// Integration tests that RUN the portkit workflow body with a mock runtime.
//
// portkit.js is evaluated by the Workflow runtime as an async-function body with
// injected globals (agent/log/phase/budget/…). Here we reconstruct that exact
// wrap and invoke it with STUB implementations: agent() returns canned structured
// data keyed by its label, and a shared in-memory store stands in for the file
// system (the IR persist/load agents). This exercises the real control flow —
// including the over-scale partition + resume paths — with zero model calls, which
// a live run cannot easily even trigger.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'portkit.js')

// The checkpoint (ir.json) is small — heavy analysis lives in per-capability side-cars
// the discovery agents write — so persist/load use a single agent: persist writes the
// JSON verbatim between these fences, load returns it parsed. The mock parses the same
// fences and models the side-cars in `store.files`.
const IR_OPEN = '<<<PORTKIT-IR-JSON>>>'
const IR_CLOSE = '<<<END-PORTKIT-IR-JSON>>>'

function compileWorkflow() {
  const src = readFileSync(SRC, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  return new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', src)
}
const WORKFLOW = compileWorkflow()

// Build a scenario: `epics` with `slicesPerEpic` slices each (no inter-slice deps,
// so the topo order is the discovery order). `merges` are agent merge decisions;
// `decisions` are what the adr:discover agent returns (each needs path:line evidence).
function scenario({ epics = ['e1'], slicesPerEpic = 2, merges = [], decisions = [] } = {}) {
  const slicesByEpic = {}
  for (const e of epics) {
    slicesByEpic[e] = Array.from({ length: slicesPerEpic }, (_, i) => ({
      id: `${e}-${i}`, name: `${e} slice ${i}`, capability: `cap ${e}.${i}`,
      thread: [{ component: 'handler', citation: 'main.go:1' }],
      behaviorSummary: `does ${e}.${i}`, dependsOn: [],
    }))
  }
  return { epics, slicesByEpic, merges, decisions }
}

// A mock runtime sharing `store` across invocations (so IR persist on pass 1 is
// visible to loadIR on resume). Records every agent label, log, and slice write.
function makeRuntime(sc, store) {
  const rec = { labels: [], logs: [], phases: [], prompts: [] }
  // Token-budget model: a per-INVOCATION spend pool (reset here because makeRuntime is created
  // fresh per run() — mirroring budget.spent() being a per-turn pool that refills on resume).
  // costPerAgent defaults to 0, so tests that set no budget see spent=0 / total=null = unlimited
  // = byte-identical behavior. store.tokenTotal drives the runtime "+Nk" precedence path.
  let spent = 0
  const costPerAgent = store.costPerAgent || 0
  async function agent(prompt, opts = {}) {
    const label = opts.label || ''
    rec.labels.push(label)
    rec.prompts.push({ label, prompt })
    spent += costPerAgent
    if (label === 'preflight:probe') return { exists: true, isDir: true, fileCount: 5 }
    if (label === 'map:survey') {
      return {
        languages: ['go'], buildSystem: 'go', testFrameworks: ['testing'],
        testPaths: ['x_test.go'], dependencyManifests: ['go.mod'],
        epics: sc.epics.map(id => ({ id, name: id, kind: 'endpoint', entryPoints: ['main.go:1'], summary: id })),
      }
    }
    if (label.startsWith('discover:')) {
      // The real agent WRITES the full slices (incl. thread) to a side-car AND a light
      // projection, then returns the slices; the workflow keeps only light fields.
      const e = label.slice('discover:'.length)
      const slices = sc.slicesByEpic[e] || []
      store.files = store.files || {}
      const sp = (prompt.match(/`([^`]+\.slices\.json)`/) || [])[1]
      const lp = (prompt.match(/`([^`]+\.light\.json)`/) || [])[1]
      if (sp) store.files[sp] = { slices }
      if (lp) store.files[lp] = slices.map(s => ({ id: s.id, name: s.name, capability: s.capability, behaviorSummary: s.behaviorSummary, dependsOn: s.dependsOn || [] }))
      return { slices }
    }
    if (label === 'resume:scan') {
      // A capability is done iff BOTH its light + behavior side-cars exist on disk.
      const files = Object.keys(store.files || {})
      const light = new Set(files.filter(p => p.endsWith('.light.json')).map(p => p.split('/').pop().replace('.light.json', '')))
      const behav = new Set(files.filter(p => p.endsWith('.behavior.json')).map(p => p.split('/').pop().replace('.behavior.json', '')))
      return { epicIds: [...light].filter(id => behav.has(id)) }
    }
    if (label.startsWith('light:')) {
      const id = label.slice('light:'.length)
      return { slices: (store.files && store.files[carPaths(id).light]) || [] }
    }
    if (label.startsWith('behavior:')) {
      // Likewise: the real agent WRITES the behavior side-car and returns perSlice.
      const e = label.slice('behavior:'.length)
      const perSlice = (sc.slicesByEpic[e] || []).map(s => ({ sliceId: s.id, coverage: 'good', acceptanceCriteria: ['ac'], testRefs: ['x_test.go:1'] }))
      const path = (prompt.match(/`([^`]+\.behavior\.json)`/) || [])[1]
      if (path) { store.files = store.files || {}; store.files[path] = { perSlice } }
      return { perSlice }
    }
    if (label === 'synthesize') return { merges: sc.merges }
    if (label === 'adr:discover') return { decisions: sc.decisions || [] }
    if (label === 'ir:persist') {
      // Small checkpoint written verbatim between fences — parse it straight back.
      const json = prompt.slice(prompt.indexOf(IR_OPEN) + IR_OPEN.length, prompt.indexOf(IR_CLOSE)).trim()
      store.ir = JSON.parse(json)
      return 'ok'
    }
    if (label === 'ir:load') return store.ir || { ordered: [] }
    if (label === 'ir:clear') { store.ir = undefined; store.files = undefined; return 'ok' }
    if (label.startsWith('slice:')) {
      const n = Number(label.split(':')[1])
      // Simulate a failed write (transient API error / spend-limit stop). Slices in
      // store.failNs return ok:false and are NOT recorded as written, so they stay
      // pending — exactly what a real mid-run failure does.
      if (store.failNs && store.failNs.has(n)) return { path: `doc-${n}.md`, ok: false, selfContained: false }
      store.written = store.written || new Set()
      store.written.add(n)
      return { path: `doc-${n}.md`, ok: true, selfContained: true }
    }
    if (label.startsWith('critic:')) return { gaps: [] }
    if (label.startsWith('distill:')) {
      // The real agent reads <OUT>/<rel>, writes a citation-free copy to <OUT>/rebuild/<rel>, and
      // reports residual `path:line` count. Record the rel path so tests can assert full coverage.
      store.distilled = store.distilled || []
      store.distilled.push(label.slice('distill:'.length))
      return { path: `rebuild/${label.slice('distill:'.length)}`, residualCitations: store.residualPerDoc || 0 }
    }
    return 'ok' // index, acceptance, arch, prd, adr:write, gapfix — no schema, return ignored
  }
  const log = (m) => rec.logs.push(String(m))
  const phase = (p) => rec.phases.push(String(p))
  const budget = {
    total: store.tokenTotal ?? null,
    spent: () => spent,
    remaining: () => (store.tokenTotal != null ? Math.max(0, store.tokenTotal - spent) : Infinity),
  }
  const noop = async () => { throw new Error('parallel/pipeline not expected in mock run') }
  return { agent, log, phase, budget, parallel: noop, pipeline: noop, workflow: noop, rec }
}

function run(args, sc, store) {
  const rt = makeRuntime(sc, store)
  return WORKFLOW(rt.agent, rt.parallel, rt.pipeline, rt.phase, rt.log, args, rt.budget, rt.workflow)
    .then(result => ({ result, rec: rt.rec }))
}

const BASE = { inputDir: '.', outputDir: '/tmp/portkit-out' }

test('normal run: writes every feature in one pass, no resume, authors the doc family + critic', async () => {
  const sc = scenario({
    epics: ['e1', 'e2'], slicesPerEpic: 3,
    decisions: [{ id: 'd1', title: 'Use SQLite for persistence', evidence: ['db.go:1'] }],
  })
  const store = {}
  const { result, rec } = await run({ ...BASE }, sc, store)

  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, false)
  assert.equal(result.counts.slicesPlanned, 6)
  assert.equal(result.counts.slicesWritten, 6)
  // every feature spec was written exactly once (build numbers 1..6)
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
  // auto-detect probes for a checkpoint at startup and checkpoints as it goes...
  assert.ok(rec.labels.includes('ir:load'), 'startup probes for a checkpoint')
  assert.ok(rec.labels.includes('ir:persist'), 'stages are checkpointed')
  // ...then clears the checkpoint on success, so nothing stale is left behind
  assert.ok(rec.labels.includes('ir:clear'), 'checkpoint cleared on completion')
  assert.equal(store.ir, undefined, 'no checkpoint remains after a clean run')
  // the doc family was authored
  assert.ok(rec.labels.includes('arch'), 'ARCHITECTURE writer ran')
  assert.ok(rec.labels.includes('prd'), 'PRD writer ran')
  assert.ok(rec.labels.includes('index'), 'INDEX writer ran')
  assert.ok(rec.labels.includes('acceptance'), 'ACCEPTANCE writer ran')
  // ADR discovery + one ADR writer (there was one evidenced decision)
  assert.ok(rec.labels.includes('adr:discover'), 'ADR discovery ran')
  assert.ok(rec.labels.includes('adr:write:1'), 'the evidenced decision got an ADR')
  assert.equal(result.counts.adrs, 1)
  // there is NO target layer anymore
  assert.ok(!rec.labels.some(l => l.startsWith('target:')), 'stack-neutral: no target layer')
  // critic ran
  assert.ok(rec.labels.includes('critic:1'))
})

test('ADR discovery drops decisions with no path:line evidence', async () => {
  const sc = scenario({
    epics: ['e1'], slicesPerEpic: 1,
    decisions: [
      { id: 'd1', title: 'Grounded decision', evidence: ['main.go:1'] },
      { id: 'd2', title: 'Ungrounded guess', evidence: [] },
    ],
  })
  const store = {}
  const { result, rec } = await run({ ...BASE }, sc, store)
  assert.equal(result.counts.adrs, 1) // only the evidenced one survives
  assert.ok(rec.labels.includes('adr:write:1'))
  assert.ok(!rec.labels.includes('adr:write:2'), 'evidence-less decision gets no ADR')
})

test('merge decision: merged-away slice is dropped from the written set, nothing else lost', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 3, merges: [{ keep: 'e1-0', merge: ['e1-1'] }] })
  const store = {}
  const { result } = await run({ ...BASE }, sc, store)
  assert.equal(result.ok, true)
  assert.equal(result.counts.slicesPlanned, 2) // 3 discovered - 1 merged = 2 survivors
  assert.equal(result.counts.slicesWritten, 2)
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2])
})

test('over-scale: partitions into resumable passes and never drops a slice', async () => {
  // 3 epics x 4 slices = 12. Force partitioning with a low agent cap.
  const sc = scenario({ epics: ['e1', 'e2', 'e3'], slicesPerEpic: 4 })
  const store = {}
  // projected = fixed 9 + 2*3 + 12 + 0 adrs + 2 gapfill = 29.
  // SAFE_BUDGET = floor(20*0.8) = 16 < 29 (over budget). writeBudget = 16 - tailReserve(11) = 5,
  // so each 4-slice epic is its own batch -> 3 passes.
  const args = { ...BASE, maxAgents: 20 }

  // Pass 1 (normal invocation, over budget): writes a first batch, asks to resume.
  const p1 = await run(args, sc, store)
  assert.equal(p1.result.ok, true)
  assert.equal(p1.result.resumeRequired, true)
  assert.ok(p1.result.counts.slicesRemaining > 0)
  assert.ok(p1.rec.labels.includes('ir:persist'), 'over-scale pass 1 must persist IR')
  assert.ok(store.ir && store.ir.slicesDiscovered === 12, 'checkpoint records all 12 discovered features (slice data is in side-cars)')
  assert.equal(store.ir.written.length, p1.result.counts.slicesWritten)
  // ADR discovery runs on pass 1 (before partitioning), never on a resume pass
  assert.ok(p1.rec.labels.includes('adr:discover'), 'ADRs discovered on pass 1')
  // critic must NOT run on a non-final pass
  assert.ok(!p1.rec.labels.includes('critic:1'))

  // Drive resume passes until done (guard against runaway).
  let last = p1.result
  let passes = 1
  while (last.resumeRequired && passes < 10) {
    const r = await run({ ...args, resume: true }, sc, store)
    last = r.result
    passes++
    // a resume pass must skip discovery/synthesis/ADRs entirely
    assert.ok(!r.rec.labels.includes('map:survey'), 'resume must not re-run map')
    assert.ok(!r.rec.labels.includes('synthesize'), 'resume must not re-run synthesis')
    assert.ok(!r.rec.labels.includes('adr:discover'), 'resume must not re-discover ADRs')
    assert.ok(r.rec.labels.includes('ir:load'), 'resume must load IR')
  }

  assert.equal(last.ok, true)
  assert.equal(last.resumeRequired, false)
  assert.ok(passes >= 2, 'over-scale should take more than one pass')
  // THE invariant: all 12 features written exactly once across the passes, none dropped
  assert.deepEqual([...store.written].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1))
  assert.equal(last.counts.slicesWritten, 12)
  // final pass ran critic
  assert.ok(last.counts.gapsRemaining !== undefined)
})

test('single-pass partial failure persists IR and is resumable (spend-limit mid-run)', async () => {
  // 2 epics x 3 slices = 6, well under budget => NOT partitioned (one-pass run).
  // Slices 4,5,6 fail on pass 1 (as if the account hit its spend limit mid-write).
  const sc = scenario({ epics: ['e1', 'e2'], slicesPerEpic: 3 })
  const store = { failNs: new Set([4, 5, 6]) }
  const p1 = await run({ ...BASE }, sc, store)

  // A non-over-scale pass that only partly wrote must STILL be resumable: it reports
  // resumeRequired and, crucially, persists the IR (the bug: it used to promise a
  // resume with no IR on disk).
  assert.equal(p1.result.ok, true)
  assert.equal(p1.result.resumeRequired, true)
  assert.equal(p1.result.counts.slicesWritten, 3)
  assert.equal(p1.result.counts.slicesRemaining, 3)
  assert.ok(p1.rec.labels.includes('ir:persist'), 'partial-failure single pass must persist IR')
  assert.ok(store.ir && store.ir.slicesDiscovered === 6, 'checkpoint records all 6 discovered features (slice data is in side-cars)')
  assert.deepEqual([...store.ir.written].sort((a, b) => a - b), [1, 2, 3])
  // a non-final pass must NOT run the critic
  assert.ok(!p1.rec.labels.includes('critic:1'), 'no critic on a partial pass')

  // Quota refreshed: clear the failures and resume. It must load the IR, skip
  // map/synthesis, write only the 3 pending features, and finish cleanly.
  store.failNs = new Set()
  const p2 = await run({ ...BASE, resume: true }, sc, store)
  assert.equal(p2.result.ok, true)
  assert.equal(p2.result.resumeRequired, false)
  assert.ok(p2.rec.labels.includes('ir:load'), 'resume must load the IR')
  assert.ok(!p2.rec.labels.includes('map:survey'), 'resume must not re-run map')
  assert.ok(!p2.rec.labels.includes('synthesize'), 'resume must not re-run synthesis')
  // THE invariant: all 6 slices written exactly once across the two passes.
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
  assert.equal(p2.result.counts.slicesWritten, 6)
})

test('limitSlices: opt-in test cap writes only N features, loud partial kit, still runs the doc family + critic', async () => {
  const sc = scenario({ epics: ['e1', 'e2', 'e3'], slicesPerEpic: 4 }) // 12 features discovered
  const store = {}
  const { result, rec } = await run({ ...BASE, limitSlices: 3 }, sc, store)

  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, false) // a limited run is complete for its scope: one pass
  assert.equal(result.counts.slicesPlanned, 3)
  assert.equal(result.counts.slicesWritten, 3)
  assert.equal(result.counts.slicesDiscovered, 12) // discovery still saw the full surface
  assert.equal(result.counts.testLimited, true)
  assert.equal(result.counts.slicesOmittedForTest, 9)
  // first 3 features in BUILD order were the ones written (prerequisites kept, deps intact)
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2, 3])
  // the trim is surfaced LOUDLY, never silent
  assert.ok(result.truncations.some(t => /TEST LIMIT/.test(t)), 'test limit reported in truncations')
  // the whole pipeline still ran end-to-end (that is the point of a cheap smoke test)
  assert.ok(rec.labels.includes('prd'), 'PRD writer runs under a test cap')
  assert.ok(rec.labels.includes('adr:discover'), 'ADR discovery runs under a test cap')
  assert.ok(rec.labels.includes('critic:1'), 'critic runs under a test cap')
  // it stays a single pass (no over-scale partition note) and cleans up its checkpoint
  assert.ok(!result.truncations.some(t => /Over-scale/.test(t)), 'a small limited run must not partition')
  assert.ok(rec.labels.includes('ir:clear'), 'checkpoint cleared on completion')
})

test('limitSlices: off by default writes every feature and sets no test-limit flags', async () => {
  const sc = scenario({ epics: ['e1', 'e2'], slicesPerEpic: 3 }) // 6 features, no limit passed
  const store = {}
  const { result } = await run({ ...BASE }, sc, store)
  assert.equal(result.counts.slicesWritten, 6)
  assert.equal(result.counts.testLimited, undefined)
  assert.equal(result.counts.slicesOmittedForTest, undefined)
})

test('explicit resume with no checkpoint fails loudly instead of silently doing nothing', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 2 })
  const store = {} // no checkpoint persisted
  const { result } = await run({ ...BASE, resume: true }, sc, store)
  assert.equal(result.ok, false)
  assert.match(result.error, /no usable checkpoint/i)
})

// --- staged analysis checkpoints (resume from ANY interrupted stage) ---------
// Helpers to hand-build a checkpoint at a given stage, as if a prior run had been
// interrupted there. `source: '.'` matches BASE.inputDir so auto-detect adopts it.
const epicsData = (ids) => ids.map(id => ({ id, name: id, kind: 'endpoint', entryPoints: ['main.go:1'], summary: id }))
// The checkpoint no longer stores per-capability slice data — only which capabilities
// are DONE (epicsDone). The slice data is rebuilt from the durable side-cars, which a
// prior (interrupted) run would have written to disk (see seedCars).
// Side-car paths must match the workflow: `${OUT}/.portkit/epics/${slug(id)}.<kind>.json`.
// The scenario epic ids are already slug-safe.
const carPaths = (id) => ({
  slices: `${BASE.outputDir}/.portkit/epics/${id}.slices.json`,
  behavior: `${BASE.outputDir}/.portkit/epics/${id}.behavior.json`,
  light: `${BASE.outputDir}/.portkit/epics/${id}.light.json`,
})
// Seed the on-disk side-cars a prior (interrupted) run would have left behind.
const seedCars = (store, sc, ids) => {
  store.files = store.files || {}
  for (const id of ids) {
    const p = carPaths(id)
    store.files[p.slices] = { slices: sc.slicesByEpic[id] }
    store.files[p.behavior] = { perSlice: sc.slicesByEpic[id].map(s => ({ sliceId: s.id, coverage: 'good', acceptanceCriteria: ['ac'], testRefs: ['x_test.go:1'] })) }
    store.files[p.light] = sc.slicesByEpic[id].map(s => ({ id: s.id, name: s.name, capability: s.capability, behaviorSummary: s.behaviorSummary, dependsOn: s.dependsOn || [] }))
  }
}

test('auto-resume from a MAP checkpoint skips map but still runs discovery', async () => {
  const sc = scenario({ epics: ['e1', 'e2'], slicesPerEpic: 2 })
  const store = { ir: { stage: 'mapped', source: '.', sysFacts: '{}', epics: epicsData(sc.epics) } }
  const { result, rec } = await run({ ...BASE }, sc, store) // no flag -> auto-detect

  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, false)
  assert.ok(rec.labels.includes('ir:load'), 'auto-detect probes for the checkpoint')
  assert.ok(!rec.labels.includes('map:survey'), 'map is skipped (checkpointed)')
  assert.ok(rec.labels.some(l => l.startsWith('discover:')), 'discovery runs (not yet checkpointed)')
  assert.equal(result.counts.slicesWritten, 4)
  assert.equal(store.ir, undefined, 'checkpoint cleared on completion')
})

test('auto-resume from a PARTIAL discovery checkpoint only analyzes the remaining capabilities', async () => {
  const sc = scenario({ epics: ['e1', 'e2', 'e3'], slicesPerEpic: 2 })
  const store = { ir: { stage: 'discovering', source: '.', sysFacts: '{}', epics: epicsData(sc.epics), epicsDone: ['e1'] } }
  seedCars(store, sc, ['e1']) // e1's side-cars were written before the interruption
  const { result, rec } = await run({ ...BASE }, sc, store)

  assert.equal(result.ok, true)
  assert.ok(!rec.labels.includes('discover:e1'), 'the already-analyzed capability is NOT re-discovered')
  assert.ok(rec.labels.includes('discover:e2'), 'remaining capability e2 is analyzed')
  assert.ok(rec.labels.includes('discover:e3'), 'remaining capability e3 is analyzed')
  assert.ok(!rec.labels.includes('map:survey'), 'map is skipped')
  assert.equal(result.counts.slicesWritten, 6) // 3 capabilities x 2 features, nothing lost
})

test('auto-resume from a DISCOVERED checkpoint skips map + discovery, synthesizes onward', async () => {
  const sc = scenario({ epics: ['e1', 'e2'], slicesPerEpic: 2 })
  const store = { ir: { stage: 'discovered', source: '.', sysFacts: '{}', epics: epicsData(sc.epics), epicsDone: sc.epics } }
  seedCars(store, sc, sc.epics) // all capabilities' side-cars already on disk
  const { result, rec } = await run({ ...BASE }, sc, store)

  assert.equal(result.ok, true)
  assert.ok(!rec.labels.includes('map:survey'), 'map skipped')
  assert.ok(!rec.labels.some(l => l.startsWith('discover:')), 'discovery skipped')
  assert.ok(rec.labels.includes('synthesize'), 'synthesis runs from the checkpoint')
  assert.equal(result.counts.slicesWritten, 4)
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2, 3, 4])
})

test('a checkpoint for a DIFFERENT source is ignored (fresh run, never a wrong-codebase resume)', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 2 })
  const store = { ir: { stage: 'writing', source: '/some/other/repo', ordered: [{ id: 'x', name: 'x', epicId: 'e1', n: 1 }], written: [1] } }
  const { result, rec } = await run({ ...BASE }, sc, store) // BASE source '.' != '/some/other/repo'

  assert.equal(result.ok, true)
  assert.ok(rec.labels.includes('map:survey'), 'mismatched checkpoint ignored — ran fresh')
  assert.equal(result.counts.slicesWritten, 2)
})

test('--fresh ignores an existing checkpoint and does not even probe for one', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 2 })
  const store = { ir: { stage: 'writing', source: '.', ordered: [{ id: 'e1-0', name: 'n', epicId: 'e1', n: 1 }], written: [1] } }
  const { result, rec } = await run({ ...BASE, fresh: true }, sc, store)

  assert.equal(result.ok, true)
  assert.ok(!rec.labels.includes('ir:load'), '--fresh does not probe for a checkpoint')
  assert.ok(rec.labels.includes('map:survey'), '--fresh reruns the full analysis')
  assert.equal(result.counts.slicesWritten, 2)
})

// --- side-cars keep the checkpoint small (the fix for the live persist hang) ------
// The heavy analysis (each slice's component thread + extracted acceptance criteria)
// must go to per-capability side-car files, NOT into ir.json — that is what kept the
// checkpoint small enough to persist through a single agent without stalling.
test('discovery writes heavy analysis to side-cars; the checkpoint stays light', async () => {
  const sc = scenario({ epics: ['e1', 'e2'], slicesPerEpic: 3 })
  const store = { failNs: new Set([1, 2, 3, 4, 5, 6]) } // fail all writes so the checkpoint persists (resumeRequired)
  const { result } = await run({ ...BASE }, sc, store)
  assert.equal(result.resumeRequired, true)

  // Side-cars were written to disk for every capability, and they carry the heavy data.
  const cars = Object.keys(store.files || {})
  assert.ok(cars.some(p => p.endsWith('e1.slices.json')) && cars.some(p => p.endsWith('e2.slices.json')), 'slices side-cars written')
  assert.ok(cars.some(p => p.endsWith('e1.behavior.json')) && cars.some(p => p.endsWith('e2.behavior.json')), 'behavior side-cars written')
  assert.ok(cars.some(p => p.endsWith('e1.light.json')) && cars.some(p => p.endsWith('e2.light.json')), 'light side-cars written')
  const sliceCar = store.files[carPaths('e1').slices]
  assert.ok(sliceCar.slices[0].thread, 'the slices side-car carries the component thread')
  assert.ok(store.files[carPaths('e1').behavior].perSlice[0].acceptanceCriteria, 'the behavior side-car carries acceptance criteria')

  // The persisted checkpoint is TINY: NO slice data at all — no thread, no criteria,
  // and not even the light per-slice list (that is rebuilt from the light side-cars).
  const irText = JSON.stringify(store.ir)
  assert.ok(!/"thread"/.test(irText), 'checkpoint carries no component threads')
  assert.ok(!/"acceptanceCriteria"/.test(irText), 'checkpoint carries no acceptance criteria')
  assert.ok(!/"behaviorSummary"/.test(irText), 'checkpoint carries no per-slice summaries (rebuilt from side-cars)')
  assert.equal(store.ir.perEpic, undefined, 'checkpoint holds no per-capability slice arrays')
  // it DOES carry the tiny completion index synthesis/resume needs
  assert.deepEqual(store.ir.epicsDone.sort(), ['e1', 'e2'], 'checkpoint records which capabilities are done')
  assert.equal(store.ir.slicesDiscovered, 6, 'checkpoint records the discovered count')
})

// Resume after a discovery interruption must NOT re-discover, and the feature writers
// read the heavy data from the on-disk side-cars (seeded by the prior run).
test('resume reuses on-disk side-cars instead of re-running discovery', async () => {
  const sc = scenario({ epics: ['e1', 'e2'], slicesPerEpic: 3 })
  const store = { ir: { stage: 'discovered', source: '.', sysFacts: '{}', epics: epicsData(sc.epics), epicsDone: sc.epics } }
  seedCars(store, sc, sc.epics)
  const { result, rec } = await run({ ...BASE, resume: true }, sc, store)
  assert.equal(result.ok, true)
  assert.ok(rec.labels.includes('resume:scan'), 'resume scans on-disk side-cars for completed capabilities')
  assert.ok(rec.labels.some(l => l.startsWith('light:')), 'resume rebuilds light slices from side-cars')
  assert.ok(!rec.labels.some(l => l.startsWith('discover:')), 'no capability is re-discovered')
  assert.ok(!rec.labels.some(l => l.startsWith('behavior:')), 'no behavior is re-extracted')
  assert.equal(result.counts.slicesWritten, 6, 'all features written from the checkpoint + side-cars')
})

// ===========================================================================
// Token/subscription-budget-aware chunking
// ===========================================================================
// The budget model: costPerAgent debits a per-invocation pool; a tiny ceiling (maxTokensPerRun)
// with reserve 0 exhausts it almost immediately, so the run yields at the FIRST armed checkpoint
// (the progress guard guarantees ≥1 unit of work per turn first). maxConcurrency:1 makes each
// capability its own discovery batch and each write pass a single spec, for deterministic yields.

test('token budget: yields mid-discovery (progress guard writes one batch first) and is resumable', async () => {
  const sc = scenario({ epics: ['e1', 'e2', 'e3'], slicesPerEpic: 1 })
  const store = { costPerAgent: 100_000 } // one agent call exhausts a 100k ceiling
  const { result, rec } = await run(
    { ...BASE, maxConcurrency: 1, maxTokensPerRun: 100_000, tokenReserve: 0 }, sc, store)

  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, true)
  assert.equal(result.stoppedForBudget, true, 'yielded for the token budget, not an error')
  assert.equal(result.stage, 'discovering')
  assert.deepEqual(store.ir.epicsDone, ['e1'], 'exactly one capability analyzed before yielding (progress guard)')
  assert.ok(!rec.labels.includes('synthesize'), 'did not push on into synthesis')
  assert.ok(!rec.labels.includes('index'), 'did not author the doc family')
})

test('token budget: write phase partitions below agent over-scale and yields mid-write (per-epic batches)', async () => {
  // 3 epics × 2 slices = 6 features — far below the agent over-scale threshold, so ONLY the token
  // budget can trigger partitioning. planEpicBatches never splits an epic, so multiple epics are
  // needed to observe a mid-write yield (a single big epic writes all its slices in one batch).
  const sc = scenario({ epics: ['e1', 'e2', 'e3'], slicesPerEpic: 2 })
  const store = { costPerAgent: 100_000 }
  const args = { ...BASE, maxConcurrency: 1, maxTokensPerRun: 100_000, tokenReserve: 0 }
  let result, passes = 0, sawWritingYield = false, sawTokenLog = false
  do {
    let rec
    ;({ result, rec } = await run({ ...args, ...(passes > 0 ? { resume: true } : {}) }, sc, store))
    if (rec.logs.some(l => /Token budget in effect/.test(l))) sawTokenLog = true
    if (result.stoppedForBudget && result.stage === 'writing') {
      sawWritingYield = true
      const w = (store.ir.written || []).length
      assert.ok(w >= 1 && w < 6, `partial write progress persisted before yielding: ${w}/6`)
    }
    passes++
    assert.ok(passes < 40, 'must converge')
  } while (result.resumeRequired)

  assert.ok(sawTokenLog, 'token-budget partitioning engaged below agent over-scale (logged)')
  assert.ok(sawWritingYield, 'the write phase yielded mid-write at least once')
  assert.equal(store.written.size, 6, 'every feature still written exactly once')
})

test('token budget: repeated resumes complete the kit with every slice written exactly once', async () => {
  const sc = scenario({ epics: ['e1', 'e2'], slicesPerEpic: 2 }) // N = 4 features
  const store = { costPerAgent: 100_000 } // yield after each armed checkpoint
  const args = { ...BASE, maxConcurrency: 1, maxTokensPerRun: 100_000, tokenReserve: 0 }
  const stagesSeen = new Set()
  let result, passes = 0
  do {
    ({ result } = await run({ ...args, ...(passes > 0 ? { resume: true } : {}) }, sc, store))
    if (result.stoppedForBudget) stagesSeen.add(result.stage)
    passes++
    assert.ok(passes < 30, `must converge (stuck after ${passes} passes)`) // no infinite yield loop
  } while (result.resumeRequired)

  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, false, 'eventually finishes')
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2, 3, 4], 'every slice written exactly once')
  assert.equal(result.counts.slicesWritten, 4)
  assert.ok(stagesSeen.has('discovering'), 'chunked through discovery')
  assert.ok(stagesSeen.has('writing'), 'chunked through the write phase')
  assert.equal(store.ir, undefined, 'checkpoint cleared on final completion')
})

test('footgun-1: resuming a checkpoint built with different scale knobs aborts loudly', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 2 })
  // A smoke-test checkpoint (maxEpics 5, limitSlices 3) — resuming it with a full-run command
  // must NOT silently continue the smaller scope.
  const store = {
    ir: {
      stage: 'mapped', source: '.', epics: [{ id: 'e1', name: 'e1', kind: 'endpoint' }],
      scale: { maxEpics: 5, limitSlices: 3 },
    },
  }
  const { result } = await run({ ...BASE, maxEpics: 40, limitSlices: 0 }, sc, store)

  assert.equal(result.ok, false, 'aborts rather than resuming the smaller scope')
  assert.match(result.error, /maxEpics=5, limitSlices=3/)
  assert.match(result.error, /fresh: true/)
  assert.deepEqual(result.checkpointScale, { maxEpics: 5, limitSlices: 3 })
  assert.deepEqual(result.requestedScale, { maxEpics: 40, limitSlices: 0 })
})

test('footgun-1: resuming with the SAME scale knobs continues normally', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 2 })
  const store = {
    ir: {
      stage: 'mapped', source: '.', epics: [{ id: 'e1', name: 'e1', kind: 'endpoint', entryPoints: ['main.go:1'], summary: 'e1' }],
      scale: { maxEpics: 40, limitSlices: 0 },
    },
  }
  const { result } = await run({ ...BASE }, sc, store) // defaults match the checkpoint's scale
  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, false)
  assert.equal(result.counts.slicesWritten, 2)
})

test('footgun-2: a fresh run clears the checkpoint and instructs writers to OVERWRITE (not skip)', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 1 })
  const store = { ir: { stage: 'writing', source: '.', written: [1] } } // a stale prior kit's checkpoint

  const { result, rec } = await run({ ...BASE, fresh: true }, sc, store)
  assert.equal(result.ok, true)
  assert.ok(rec.labels.includes('ir:clear'), 'fresh clears any stale checkpoint up front')
  assert.ok(!rec.labels.includes('ir:load'), 'fresh never probes the checkpoint')
  // Every doc/spec writer is told to OVERWRITE on a fresh run.
  for (const lbl of ['index', 'acceptance', 'arch', 'prd']) {
    const p = rec.prompts.find(x => x.label === lbl)
    assert.ok(p && /FRESH run.*OVERWRITE/s.test(p.prompt), `${lbl} writer told to overwrite on fresh`)
  }
  const specPrompt = rec.prompts.find(x => x.label.startsWith('slice:'))
  assert.ok(specPrompt && /OVERWRITE/.test(specPrompt.prompt), 'spec writer told to overwrite on fresh')
})

test('footgun-2: a normal (non-fresh) run keeps the SKIP-if-exists instruction (resume-safe)', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 1 })
  const { rec } = await run({ ...BASE }, sc, {})
  const index = rec.prompts.find(x => x.label === 'index')
  assert.ok(index && /do NOT rewrite it; return immediately/.test(index.prompt),
    'normal run skips an existing doc so a resume never re-authors it')
})

test('no-budget regression: an unset budget yields never and completes in a single pass', async () => {
  const sc = scenario({ epics: ['e1', 'e2'], slicesPerEpic: 3 })
  const { result } = await run({ ...BASE }, sc, {}) // no maxTokensPerRun, no tokenTotal
  assert.equal(result.resumeRequired, false, 'no voluntary yield without a budget')
  assert.ok(!('stoppedForBudget' in result))
  assert.equal(result.counts.slicesWritten, 6)
})

// ===========================================================================
// Distill: citation-free rebuild/ mirror for the weaker rebuilder (opt-in)
// ===========================================================================

test('distill: opt-in emits a citation-free rebuild/ mirror of every consumer-facing doc', async () => {
  const sc = scenario({
    epics: ['e1', 'e2'], slicesPerEpic: 2, // 4 specs
    decisions: [
      { id: 'd1', title: 'Persist as JSONL', evidence: ['x.go:1'] },
      { id: 'd2', title: 'Lock with O_EXCL', evidence: ['y.go:2'] },
    ],
  })
  const store = {}
  const { result, rec } = await run({ ...BASE, distill: true }, sc, store)

  assert.equal(result.ok, true)
  assert.ok(rec.labels.some(l => l === 'distill:ARCHITECTURE.md'), 'ARCHITECTURE distilled')
  // The four fixed docs + 4 specs + 2 ADRs are all mirrored.
  for (const d of ['ARCHITECTURE.md', 'PRD.md', 'INDEX.md', 'ACCEPTANCE.md']) {
    assert.ok(store.distilled.includes(d), `${d} distilled`)
  }
  assert.equal(store.distilled.filter(p => p.startsWith('specs/')).length, 4, 'all 4 specs distilled')
  assert.equal(store.distilled.filter(p => p.startsWith('adr/')).length, 2, 'both ADRs distilled')
  assert.equal(result.keyDocs.rebuildDir, '/tmp/portkit-out/rebuild/')
  assert.equal(result.counts.distilledDocs, 10, '4 fixed docs + 4 specs + 2 ADRs')
  assert.equal(result.counts.residualCitations, 0)
})

test('distill: OFF by default — no rebuild/ mirror, no distill agents', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 2 })
  const store = {}
  const { result, rec } = await run({ ...BASE }, sc, store) // distill not set
  assert.ok(!rec.labels.some(l => l.startsWith('distill:')), 'no distill agents run by default')
  assert.equal(store.distilled, undefined)
  assert.ok(!('rebuildDir' in result.keyDocs))
  assert.ok(!('distilledDocs' in result.counts))
})

test('distill: residual citations are surfaced loudly, not hidden', async () => {
  const sc = scenario({ epics: ['e1'], slicesPerEpic: 1 }) // 4 fixed + 1 spec = 5 docs
  const store = { residualPerDoc: 2 } // each distilled doc reports 2 leftover citations
  const { result } = await run({ ...BASE, distill: true }, sc, store)
  assert.equal(result.counts.residualCitations, 10, '2 residual × 5 docs, aggregated')
  assert.ok(result.truncations.some(t => /residual citation/.test(t)), 'residuals flagged in truncations')
})
