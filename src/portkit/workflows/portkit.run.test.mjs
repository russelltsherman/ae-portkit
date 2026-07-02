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
  const rec = { labels: [], logs: [], phases: [] }
  async function agent(prompt, opts = {}) {
    const label = opts.label || ''
    rec.labels.push(label)
    if (label === 'preflight:probe') return { exists: true, isDir: true, fileCount: 5 }
    if (label === 'map:survey') {
      return {
        languages: ['go'], buildSystem: 'go', testFrameworks: ['testing'],
        testPaths: ['x_test.go'], dependencyManifests: ['go.mod'],
        epics: sc.epics.map(id => ({ id, name: id, kind: 'endpoint', entryPoints: ['main.go:1'], summary: id })),
      }
    }
    if (label.startsWith('discover:')) return { slices: sc.slicesByEpic[label.slice('discover:'.length)] || [] }
    if (label.startsWith('behavior:')) {
      const e = label.slice('behavior:'.length)
      return { perSlice: (sc.slicesByEpic[e] || []).map(s => ({ sliceId: s.id, coverage: 'good', acceptanceCriteria: ['ac'], testRefs: ['x_test.go:1'] })) }
    }
    if (label === 'synthesize') return { merges: sc.merges }
    if (label === 'adr:discover') return { decisions: sc.decisions || [] }
    if (label === 'ir:persist') {
      const json = prompt.slice(prompt.indexOf(IR_OPEN) + IR_OPEN.length, prompt.indexOf(IR_CLOSE)).trim()
      store.ir = JSON.parse(json)
      return 'ok'
    }
    if (label === 'ir:load') return store.ir || { ordered: [] }
    if (label === 'ir:clear') { store.ir = undefined; return 'ok' }
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
    return 'ok' // index, acceptance, arch, prd, adr:write, gapfix — no schema, return ignored
  }
  const log = (m) => rec.logs.push(String(m))
  const phase = (p) => rec.phases.push(String(p))
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
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
  assert.ok(store.ir && store.ir.ordered.length === 12, 'IR carries all 12 features')
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
  assert.ok(store.ir && store.ir.ordered.length === 6, 'persisted IR carries all 6 features')
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
const perEpicFor = (sc, id) => ({
  epicId: id,
  slices: sc.slicesByEpic[id],
  behavior: sc.slicesByEpic[id].map(s => ({ sliceId: s.id, coverage: 'good', acceptanceCriteria: ['ac'], testRefs: ['x_test.go:1'] })),
})

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
  const store = { ir: { stage: 'discovering', source: '.', sysFacts: '{}', epics: epicsData(sc.epics), perEpic: [perEpicFor(sc, 'e1')] } }
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
  const store = { ir: { stage: 'discovered', source: '.', sysFacts: '{}', epics: epicsData(sc.epics), perEpic: sc.epics.map(id => perEpicFor(sc, id)) } }
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
