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

// The checkpoint (ir.json) is small — heavy analysis lives in per-feature side-cars
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

// Build a scenario: `features` with `slicesPerFeature` slices each (no inter-slice deps,
// so the topo order is the discovery order). `merges` are agent merge decisions;
// `decisions` are what the adr:discover agent returns (each needs path:line evidence).
function scenario({ features = ['e1'], slicesPerFeature = 2, merges = [], decisions = [] } = {}) {
  const slicesByFeature = {}
  for (const e of features) {
    slicesByFeature[e] = Array.from({ length: slicesPerFeature }, (_, i) => ({
      id: `${e}-${i}`, name: `${e} slice ${i}`, handle: `${e}-h${i}`, summary: `cap ${e}.${i}`,
      thread: [{ component: 'handler', citation: 'main.go:1' }],
      behaviorSummary: `does ${e}.${i}`, dependsOn: [],
    }))
  }
  return { features, slicesByFeature, merges, decisions }
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
        features: sc.features.map(id => ({ id, name: id, kind: 'endpoint', entryPoints: ['main.go:1'], summary: id })),
      }
    }
    if (label.startsWith('discover:')) {
      // The real agent WRITES the full slices (incl. thread) to a side-car AND a light
      // projection, then returns the slices; the workflow keeps only light fields.
      const e = label.slice('discover:'.length)
      const slices = sc.slicesByFeature[e] || []
      store.files = store.files || {}
      const sp = (prompt.match(/`([^`]+\.slices\.json)`/) || [])[1]
      const lp = (prompt.match(/`([^`]+\.light\.json)`/) || [])[1]
      if (sp) store.files[sp] = { slices }
      if (lp) store.files[lp] = slices.map(s => ({ id: s.id, name: s.name, handle: s.handle, summary: s.summary, behaviorSummary: s.behaviorSummary, dependsOn: s.dependsOn || [] }))
      return { slices }
    }
    if (label === 'resume:scan') {
      // Report, per feature, which DURABLE side-cars exist on disk. Structure (light.json)
      // and behavior (behavior.json) are independent: the workflow RELOADS structure and
      // re-runs ONLY a missing behavior spec, so it never re-discovers/renumbers.
      const files = Object.keys(store.files || {})
      const ids = new Set(), light = new Set(), behav = new Set()
      for (const p of files) {
        const base = p.split('/').pop()
        if (base.endsWith('.light.json')) { const id = base.replace('.light.json', ''); light.add(id); ids.add(id) }
        else if (base.endsWith('.behavior.json')) { const id = base.replace('.behavior.json', ''); behav.add(id); ids.add(id) }
        else if (base.endsWith('.slices.json')) { ids.add(base.replace('.slices.json', '')) }
      }
      return { features: [...ids].map(id => ({ id, hasLight: light.has(id), hasBehavior: behav.has(id) })) }
    }
    if (label.startsWith('light:')) {
      const id = label.slice('light:'.length)
      return { slices: (store.files && store.files[carPaths(id).light]) || [] }
    }
    if (label.startsWith('behavior:')) {
      // Likewise: the real agent WRITES the behavior side-car and returns perSlice.
      const e = label.slice('behavior:'.length)
      const perSlice = (sc.slicesByFeature[e] || []).map(s => ({ sliceKey: s.id, coverage: 'good', acceptanceCriteria: ['ac'], testRefs: ['x_test.go:1'] }))
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
    if (label.startsWith('critic:')) {
      // Optionally simulate the critic EXTRACTING each doc's structure. On the first round a
      // malformed scenario reports a slice spec missing its last section (a `missing-heading`
      // that checkDocStructure() turns into a fixable malformed-structure gap); later rounds
      // report it conformant so the gap-fill loop converges.
      const round = Number(label.split(':')[1])
      if (store.malformedStructure && round === 1) {
        return {
          gaps: [],
          docStructures: [{
            path: 'specs/SL-0001-x.md', docType: 'slice-spec',
            frontmatterKeys: ['Slice ID', 'Build #', 'Feature', 'Status', 'Depends on'],
            // 'Shared Conventions' dropped ⇒ one missing-heading violation
            headings: ['Summary', 'Behavior Thread', 'Interface & Contract', 'Acceptance Criteria', 'Build Steps'],
          }],
        }
      }
      return { gaps: [], docStructures: store.conformantStructures || [] }
    }
    if (label.startsWith('distill:')) {
      // The real agent reads <OUT>/<rel>, writes a citation-free copy to <OUT>/distilled/<rel>, and
      // reports residual `path:line` count. Record the rel path so tests can assert full coverage.
      store.distilled = store.distilled || []
      store.distilled.push(label.slice('distill:'.length))
      return { path: `distilled/${label.slice('distill:'.length)}`, residualCitations: store.residualPerDoc || 0 }
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

test('normal run: writes every slice in one pass, no resume, authors the doc family + critic', async () => {
  const sc = scenario({
    features: ['e1', 'e2'], slicesPerFeature: 3,
    decisions: [{ id: 'd1', title: 'Use SQLite for persistence', evidence: ['db.go:1'] }],
  })
  const store = {}
  const { result, rec } = await run({ ...BASE }, sc, store)

  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, false)
  assert.equal(result.counts.slicesPlanned, 6)
  assert.equal(result.counts.slicesWritten, 6)
  // every slice spec was written exactly once (build numbers 1..6)
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
    features: ['e1'], slicesPerFeature: 1,
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

test('canonical ids + rigid skeleton reach the writers (SL-/FEAT-/ADR-, house style)', async () => {
  const sc = scenario({
    features: ['e1', 'e2'], slicesPerFeature: 2,
    decisions: [{ id: 'd1', title: 'Use SQLite', evidence: ['db.go:1'] }],
  })
  const store = {}
  const { rec } = await run({ ...BASE }, sc, store)
  const prompt = (pred) => rec.prompts.find(pred)?.prompt || ''
  const firstSlice = prompt(p => p.label.startsWith('slice:'))
  // slice spec carries the metadata header, the rigid heading, and a canonical Slice ID
  assert.match(firstSlice, /\*\*Slice ID:\*\*/, 'slice spec prompt has the Slice ID metadata field')
  assert.match(firstSlice, /## Behavior Thread/, 'slice spec prompt carries the rigid skeleton')
  assert.match(firstSlice, /SL-\d{4}/, 'slice spec prompt embeds a canonical SL-NNNN id')
  assert.doesNotMatch(firstSlice, /Include, in this order:/, 'no free-form checklist')
  // INDEX gets both id families
  const idx = prompt(p => p.label === 'index')
  assert.match(idx, /SL-\d{4}/, 'INDEX data carries slice ids')
  assert.match(idx, /FEAT-\d{2}/, 'INDEX data carries feature ids')
  // ADR writer gets its canonical ADR id, and the GLOSSARY writer runs
  assert.match(prompt(p => p.label === 'adr:write:1'), /ADR-0001/, 'ADR writer gets ADR-0001')
  assert.ok(rec.labels.includes('glossary'), 'GLOSSARY writer runs in the doc family')
  // filenames are id-prefixed + the terse handle (not the verbose name): SL-0001-e1-h0.md
  const firstSliceWrite = rec.prompts.find(p => p.label.startsWith('slice:'))?.prompt || ''
  assert.match(firstSliceWrite, /specs\/SL-0001-e1-h0\.md/, 'spec filename is <SliceID>-<handle>.md')
  assert.match(idx, /specs\/SL-0001-e1-h0\.md/, 'INDEX links the same id+handle filename')
  assert.match(prompt(p => p.label === 'adr:write:1'), /adr\/ADR-0001-/, 'ADR filename is ADR-<NNNN>-<handle>.md')
})

test('critic prompt asks for the per-doc STRUCTURE REPORT (docStructures extraction)', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 1 })
  const store = {}
  const { rec } = await run({ ...BASE }, sc, store)
  const critic = rec.prompts.find(p => p.label === 'critic:1')?.prompt || ''
  assert.match(critic, /STRUCTURE REPORT/, 'critic is told to report per-doc structure')
  assert.match(critic, /docStructures/, 'the docStructures field is named')
  assert.match(critic, /malformed-structure/, 'the new defect kind is described')
})

test('conformant docs produce no malformed-structure gap and no gap-fill', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  const store = {} // critic mock returns empty docStructures ⇒ nothing to flag
  const { result, rec } = await run({ ...BASE }, sc, store)
  assert.equal(result.ok, true)
  assert.equal(result.counts.gapsRemaining, 0, 'no structural gaps on a conformant kit')
  assert.ok(!rec.labels.some(l => l.startsWith('gapfix:')), 'no gap-fill triggered')
})

test('a doc missing a required section is caught, auto-fixed via gap-fill', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  const store = { malformedStructure: true } // critic:1 reports SL-0001 missing its last section
  const { result, rec } = await run({ ...BASE }, sc, store)
  assert.equal(result.ok, true)
  // the deterministic check turned the missing heading into a fixable gap that drove the loop
  assert.ok(rec.labels.some(l => l.startsWith('gapfix:')), 'gap-fill ran on the malformed doc')
  // the gap-fix agent was handed the malformed-structure gap for SL-0001
  const gapfix = rec.prompts.find(p => p.label.startsWith('gapfix:'))?.prompt || ''
  assert.match(gapfix, /malformed-structure/, 'gap-fix agent receives the structural gap')
  assert.match(gapfix, /SL-0001-x\.md/, 'gap-fix agent is pointed at the offending doc')
})

test('dependsOn is rendered as canonical Slice IDs, never the raw discovery key', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  // make the 2nd slice depend on the 1st (raw keys e1-0 <- e1-1); topo keeps e1-0 first (SL-0001)
  sc.slicesByFeature['e1'][1].dependsOn = ['e1-0']
  const store = {}
  const { rec } = await run({ ...BASE }, sc, store)
  const depSlice = rec.prompts.find(p => p.label.startsWith('slice:2:'))?.prompt || ''
  assert.match(depSlice, /SL-0001/, 'dependency is shown as its Slice ID')
  assert.ok(!/"e1-0"/.test(depSlice.split('SLICE DATA:')[1] || ''), 'raw dependency key is not leaked into the slice data')
  const idx = rec.prompts.find(p => p.label === 'index')?.prompt || ''
  assert.match(idx, /SL-0001/, 'INDEX renders the dependency as a Slice ID too')
})

test('merge decision: merged-away slice is dropped from the written set, nothing else lost', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 3, merges: [{ keep: 'e1-0', merge: ['e1-1'] }] })
  const store = {}
  const { result } = await run({ ...BASE }, sc, store)
  assert.equal(result.ok, true)
  assert.equal(result.counts.slicesPlanned, 2) // 3 discovered - 1 merged = 2 survivors
  assert.equal(result.counts.slicesWritten, 2)
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2])
})

test('over-scale: partitions into resumable passes and never drops a slice', async () => {
  // 3 features x 4 slices = 12. Force partitioning with a low agent cap.
  const sc = scenario({ features: ['e1', 'e2', 'e3'], slicesPerFeature: 4 })
  const store = {}
  // projected = fixed 9 + 2*3 + 12 + 0 adrs + 2 gapfill = 29.
  // SAFE_BUDGET = floor(20*0.8) = 16 < 29 (over budget). writeBudget = 16 - tailReserve(11) = 5,
  // so each 4-slice feature is its own batch -> 3 passes.
  const args = { ...BASE, maxAgents: 20 }

  // Pass 1 (normal invocation, over budget): writes a first batch, asks to resume.
  const p1 = await run(args, sc, store)
  assert.equal(p1.result.ok, true)
  assert.equal(p1.result.resumeRequired, true)
  assert.ok(p1.result.counts.slicesRemaining > 0)
  assert.ok(p1.rec.labels.includes('ir:persist'), 'over-scale pass 1 must persist IR')
  assert.ok(store.ir && store.ir.slicesDiscovered === 12, 'checkpoint records all 12 discovered slices (slice data is in side-cars)')
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
  // THE invariant: all 12 slices written exactly once across the passes, none dropped
  assert.deepEqual([...store.written].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1))
  assert.equal(last.counts.slicesWritten, 12)
  // final pass ran critic
  assert.ok(last.counts.gapsRemaining !== undefined)
})

test('single-pass partial failure persists IR and is resumable (spend-limit mid-run)', async () => {
  // 2 features x 3 slices = 6, well under budget => NOT partitioned (one-pass run).
  // Slices 4,5,6 fail on pass 1 (as if the account hit its spend limit mid-write).
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 3 })
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
  assert.ok(store.ir && store.ir.slicesDiscovered === 6, 'checkpoint records all 6 discovered slices (slice data is in side-cars)')
  assert.deepEqual([...store.ir.written].sort((a, b) => a - b), [1, 2, 3])
  // a non-final pass must NOT run the critic
  assert.ok(!p1.rec.labels.includes('critic:1'), 'no critic on a partial pass')

  // Quota refreshed: clear the failures and resume. It must load the IR, skip
  // map/synthesis, write only the 3 pending slices, and finish cleanly.
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

test('limitSlices: opt-in test cap writes only N slices, loud partial kit, still runs the doc family + critic', async () => {
  const sc = scenario({ features: ['e1', 'e2', 'e3'], slicesPerFeature: 4 }) // 12 slices discovered
  const store = {}
  const { result, rec } = await run({ ...BASE, limitSlices: 3 }, sc, store)

  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, false) // a limited run is complete for its scope: one pass
  assert.equal(result.counts.slicesPlanned, 3)
  assert.equal(result.counts.slicesWritten, 3)
  assert.equal(result.counts.slicesDiscovered, 12) // discovery still saw the full surface
  assert.equal(result.counts.testLimited, true)
  assert.equal(result.counts.slicesOmittedForTest, 9)
  // first 3 slices in BUILD order were the ones written (prerequisites kept, deps intact)
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

test('limitSlices: off by default writes every slice and sets no test-limit flags', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 3 }) // 6 slices, no limit passed
  const store = {}
  const { result } = await run({ ...BASE }, sc, store)
  assert.equal(result.counts.slicesWritten, 6)
  assert.equal(result.counts.testLimited, undefined)
  assert.equal(result.counts.slicesOmittedForTest, undefined)
})

test('explicit resume with no checkpoint fails loudly instead of silently doing nothing', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  const store = {} // no checkpoint persisted
  const { result } = await run({ ...BASE, resume: true }, sc, store)
  assert.equal(result.ok, false)
  assert.match(result.error, /no usable checkpoint/i)
})

// --- staged analysis checkpoints (resume from ANY interrupted stage) ---------
// Helpers to hand-build a checkpoint at a given stage, as if a prior run had been
// interrupted there. `source: '.'` matches BASE.inputDir so auto-detect adopts it.
const featuresData = (ids) => ids.map(id => ({ id, name: id, kind: 'endpoint', entryPoints: ['main.go:1'], summary: id }))
// The checkpoint no longer stores per-feature slice data — only which features
// are DONE (featuresDone). The slice data is rebuilt from the durable side-cars, which a
// prior (interrupted) run would have written to disk (see seedCars).
// Side-car paths must match the workflow: `${OUT}/.portkit/features/${slug(id)}.<kind>.json`.
// The scenario feature ids are already slug-safe.
const carPaths = (id) => ({
  slices: `${BASE.outputDir}/.portkit/features/${id}.slices.json`,
  behavior: `${BASE.outputDir}/.portkit/features/${id}.behavior.json`,
  light: `${BASE.outputDir}/.portkit/features/${id}.light.json`,
})
// Seed the on-disk side-cars a prior (interrupted) run would have left behind.
const seedCars = (store, sc, ids) => {
  store.files = store.files || {}
  for (const id of ids) {
    const p = carPaths(id)
    store.files[p.slices] = { slices: sc.slicesByFeature[id] }
    store.files[p.behavior] = { perSlice: sc.slicesByFeature[id].map(s => ({ sliceKey: s.id, coverage: 'good', acceptanceCriteria: ['ac'], testRefs: ['x_test.go:1'] })) }
    store.files[p.light] = sc.slicesByFeature[id].map(s => ({ id: s.id, name: s.name, summary: s.summary, behaviorSummary: s.behaviorSummary, dependsOn: s.dependsOn || [] }))
  }
}

test('auto-resume from a MAP checkpoint skips map but still runs discovery', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 2 })
  const store = { ir: { stage: 'mapped', source: '.', sysFacts: '{}', features: featuresData(sc.features) } }
  const { result, rec } = await run({ ...BASE }, sc, store) // no flag -> auto-detect

  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, false)
  assert.ok(rec.labels.includes('ir:load'), 'auto-detect probes for the checkpoint')
  assert.ok(!rec.labels.includes('map:survey'), 'map is skipped (checkpointed)')
  assert.ok(rec.labels.some(l => l.startsWith('discover:')), 'discovery runs (not yet checkpointed)')
  assert.equal(result.counts.slicesWritten, 4)
  assert.equal(store.ir, undefined, 'checkpoint cleared on completion')
})

test('auto-resume from a PARTIAL discovery checkpoint only analyzes the remaining features', async () => {
  const sc = scenario({ features: ['e1', 'e2', 'e3'], slicesPerFeature: 2 })
  const store = { ir: { stage: 'discovering', source: '.', sysFacts: '{}', features: featuresData(sc.features), featuresDone: ['e1'] } }
  seedCars(store, sc, ['e1']) // e1's side-cars were written before the interruption
  const { result, rec } = await run({ ...BASE }, sc, store)

  assert.equal(result.ok, true)
  assert.ok(!rec.labels.includes('discover:e1'), 'the already-analyzed feature is NOT re-discovered')
  assert.ok(rec.labels.includes('discover:e2'), 'remaining feature e2 is analyzed')
  assert.ok(rec.labels.includes('discover:e3'), 'remaining feature e3 is analyzed')
  assert.ok(!rec.labels.includes('map:survey'), 'map is skipped')
  assert.equal(result.counts.slicesWritten, 6) // 3 features x 2 slices, nothing lost
})

test('auto-resume from a DISCOVERED checkpoint skips map + discovery, synthesizes onward', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 2 })
  const store = { ir: { stage: 'discovered', source: '.', sysFacts: '{}', features: featuresData(sc.features), featuresDone: sc.features } }
  seedCars(store, sc, sc.features) // all features' side-cars already on disk
  const { result, rec } = await run({ ...BASE }, sc, store)

  assert.equal(result.ok, true)
  assert.ok(!rec.labels.includes('map:survey'), 'map skipped')
  assert.ok(!rec.labels.some(l => l.startsWith('discover:')), 'discovery skipped')
  assert.ok(rec.labels.includes('synthesize'), 'synthesis runs from the checkpoint')
  assert.equal(result.counts.slicesWritten, 4)
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2, 3, 4])
})

test('a checkpoint for a DIFFERENT source is ignored (fresh run, never a wrong-codebase resume)', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  const store = { ir: { stage: 'writing', source: '/some/other/repo', ordered: [{ id: 'x', name: 'x', featureKey: 'e1', n: 1 }], written: [1] } }
  const { result, rec } = await run({ ...BASE }, sc, store) // BASE source '.' != '/some/other/repo'

  assert.equal(result.ok, true)
  assert.ok(rec.labels.includes('map:survey'), 'mismatched checkpoint ignored — ran fresh')
  assert.equal(result.counts.slicesWritten, 2)
})

test('--fresh ignores an existing checkpoint and does not even probe for one', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  const store = { ir: { stage: 'writing', source: '.', ordered: [{ id: 'e1-0', name: 'n', featureKey: 'e1', n: 1 }], written: [1] } }
  const { result, rec } = await run({ ...BASE, fresh: true }, sc, store)

  assert.equal(result.ok, true)
  assert.ok(!rec.labels.includes('ir:load'), '--fresh does not probe for a checkpoint')
  assert.ok(rec.labels.includes('map:survey'), '--fresh reruns the full analysis')
  assert.equal(result.counts.slicesWritten, 2)
})

// --- side-cars keep the checkpoint small (the fix for the live persist hang) ------
// The heavy analysis (each slice's component thread + extracted acceptance criteria)
// must go to per-feature side-car files, NOT into ir.json — that is what kept the
// checkpoint small enough to persist through a single agent without stalling.
test('discovery writes heavy analysis to side-cars; the checkpoint stays light', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 3 })
  const store = { failNs: new Set([1, 2, 3, 4, 5, 6]) } // fail all writes so the checkpoint persists (resumeRequired)
  const { result } = await run({ ...BASE }, sc, store)
  assert.equal(result.resumeRequired, true)

  // Side-cars were written to disk for every feature, and they carry the heavy data.
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
  assert.equal(store.ir.perFeature, undefined, 'checkpoint holds no per-feature slice arrays')
  // it DOES carry the tiny completion index synthesis/resume needs
  assert.deepEqual(store.ir.featuresDone.sort(), ['e1', 'e2'], 'checkpoint records which features are done')
  assert.equal(store.ir.slicesDiscovered, 6, 'checkpoint records the discovered count')
})

// Resume after a discovery interruption must NOT re-discover, and the slice writers
// read the heavy data from the on-disk side-cars (seeded by the prior run).
test('resume reuses on-disk side-cars instead of re-running discovery', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 3 })
  const store = { ir: { stage: 'discovered', source: '.', sysFacts: '{}', features: featuresData(sc.features), featuresDone: sc.features } }
  seedCars(store, sc, sc.features)
  const { result, rec } = await run({ ...BASE, resume: true }, sc, store)
  assert.equal(result.ok, true)
  assert.ok(rec.labels.includes('resume:scan'), 'resume scans on-disk side-cars for completed features')
  assert.ok(rec.labels.some(l => l.startsWith('light:')), 'resume rebuilds light slices from side-cars')
  assert.ok(!rec.labels.some(l => l.startsWith('discover:')), 'no feature is re-discovered')
  assert.ok(!rec.labels.some(l => l.startsWith('behavior:')), 'no behavior is re-extracted')
  assert.equal(result.counts.slicesWritten, 6, 'all slices written from the checkpoint + side-cars')
})

// REGRESSION (the duplicate-rewrite bug): on resume, a feature whose slice
// STRUCTURE is on disk (light + slices side-cars) but whose BEHAVIOR side-car is missing
// — because its behavior agent failed on the prior pass — must re-run ONLY the behavior
// agent. It must NOT be re-discovered: re-discovery yields a different slice set and
// RENUMBERS every downstream spec, duplicating the whole kit on top of itself. The source
// is static, so the slice count/numbering must be invariant across resumes.
test('resume with a missing behavior side-car re-runs behavior ONLY, never re-discovers (no renumber)', async () => {
  const sc = scenario({ features: ['e1', 'e2', 'e3'], slicesPerFeature: 2 })
  const store = { ir: { stage: 'discovered', source: '.', sysFacts: '{}', features: featuresData(sc.features), featuresDone: sc.features } }
  seedCars(store, sc, sc.features)
  // Simulate e2's behavior agent having FAILED on the prior pass: its structure (light +
  // slices) is durable on disk, but the behavior side-car was never written.
  delete store.files[carPaths('e2').behavior]

  const { result, rec } = await run({ ...BASE, resume: true }, sc, store)

  assert.equal(result.ok, true)
  // NOTHING is re-discovered — structure is durable, so the slice set (and numbering) is fixed.
  assert.ok(!rec.labels.some(l => l.startsWith('discover:')), 'no feature is re-discovered on resume')
  // ONLY the feature missing its behavior side-car re-runs the behavior agent.
  assert.deepEqual(rec.labels.filter(l => l.startsWith('behavior:')), ['behavior:e2'],
    'exactly the behavior-missing feature re-runs behavior; the others do not')
  // (The behavior:e2 label above proves the gap was filled during the run; the on-disk
  // side-cars are wiped by ir:clear on successful completion, so we assert on labels.)
  // Every slice is written exactly once under a SINGLE stable numbering (1..6) — no
  // duplicates, no drift. Under the old "both-present-or-re-discover" gate this renumbered.
  assert.equal(result.counts.slicesWritten, 6)
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
})

// ===========================================================================
// Token/subscription-budget-aware chunking
// ===========================================================================
// The budget model: costPerAgent debits a per-invocation pool; a tiny ceiling (maxTokensPerRun)
// with reserve 0 exhausts it almost immediately, so the run yields at the FIRST armed checkpoint
// (the progress guard guarantees ≥1 unit of work per turn first). maxConcurrency:1 makes each
// feature its own discovery batch and each write pass a single spec, for deterministic yields.

test('token budget: yields mid-discovery (progress guard writes one batch first) and is resumable', async () => {
  const sc = scenario({ features: ['e1', 'e2', 'e3'], slicesPerFeature: 1 })
  const store = { costPerAgent: 100_000 } // one agent call exhausts a 100k ceiling
  const { result, rec } = await run(
    { ...BASE, maxConcurrency: 1, maxTokensPerRun: 100_000, tokenReserve: 0 }, sc, store)

  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, true)
  assert.equal(result.stoppedForBudget, true, 'yielded for the token budget, not an error')
  assert.equal(result.stage, 'discovering')
  assert.deepEqual(store.ir.featuresDone, ['e1'], 'exactly one feature analyzed before yielding (progress guard)')
  assert.ok(!rec.labels.includes('synthesize'), 'did not push on into synthesis')
  assert.ok(!rec.labels.includes('index'), 'did not author the doc family')
})

test('token budget: write phase partitions below agent over-scale and yields mid-write (per-feature batches)', async () => {
  // 3 features × 2 slices = 6 slices — far below the agent over-scale threshold, so ONLY the token
  // budget can trigger partitioning. planFeatureBatches never splits an feature, so multiple features are
  // needed to observe a mid-write yield (a single big feature writes all its slices in one batch).
  const sc = scenario({ features: ['e1', 'e2', 'e3'], slicesPerFeature: 2 })
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
  assert.equal(store.written.size, 6, 'every slice still written exactly once')
})

test('token budget: repeated resumes complete the kit with every slice written exactly once', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 2 }) // N = 4 slices
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
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  // A smoke-test checkpoint (maxFeatures 5, limitSlices 3) — resuming it with a full-run command
  // must NOT silently continue the smaller scope.
  const store = {
    ir: {
      stage: 'mapped', source: '.', features: [{ id: 'e1', name: 'e1', kind: 'endpoint' }],
      scale: { maxFeatures: 5, limitSlices: 3 },
    },
  }
  const { result } = await run({ ...BASE, maxFeatures: 40, limitSlices: 0 }, sc, store)

  assert.equal(result.ok, false, 'aborts rather than resuming the smaller scope')
  assert.match(result.error, /maxFeatures=5, limitSlices=3/)
  assert.match(result.error, /fresh: true/)
  assert.deepEqual(result.checkpointScale, { maxFeatures: 5, limitSlices: 3 })
  assert.deepEqual(result.requestedScale, { maxFeatures: 40, limitSlices: 0 })
})

test('footgun-1: resuming with the SAME scale knobs continues normally', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  const store = {
    ir: {
      stage: 'mapped', source: '.', features: [{ id: 'e1', name: 'e1', kind: 'endpoint', entryPoints: ['main.go:1'], summary: 'e1' }],
      scale: { maxFeatures: 40, limitSlices: 0 },
    },
  }
  const { result } = await run({ ...BASE }, sc, store) // defaults match the checkpoint's scale
  assert.equal(result.ok, true)
  assert.equal(result.resumeRequired, false)
  assert.equal(result.counts.slicesWritten, 2)
})

test('footgun-2: a fresh run clears the checkpoint and instructs writers to OVERWRITE (not skip)', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 1 })
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
  const sc = scenario({ features: ['e1'], slicesPerFeature: 1 })
  const { rec } = await run({ ...BASE }, sc, {})
  const index = rec.prompts.find(x => x.label === 'index')
  assert.ok(index && /do NOT rewrite it; return immediately/.test(index.prompt),
    'normal run skips an existing doc so a resume never re-authors it')
})

test('no-budget regression: an unset budget yields never and completes in a single pass', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 3 })
  const { result } = await run({ ...BASE }, sc, {}) // no maxTokensPerRun, no tokenTotal
  assert.equal(result.resumeRequired, false, 'no voluntary yield without a budget')
  assert.ok(!('stoppedForBudget' in result))
  assert.equal(result.counts.slicesWritten, 6)
})

// ===========================================================================
// Distill: citation-free distilled/ mirror for the weaker rebuilder (opt-in)
// ===========================================================================

test('distill: opt-in emits a citation-free distilled/ mirror of every consumer-facing doc', async () => {
  const sc = scenario({
    features: ['e1', 'e2'], slicesPerFeature: 2, // 4 specs
    decisions: [
      { id: 'd1', title: 'Persist as JSONL', evidence: ['x.go:1'] },
      { id: 'd2', title: 'Lock with O_EXCL', evidence: ['y.go:2'] },
    ],
  })
  const store = {}
  const { result, rec } = await run({ ...BASE, distill: true }, sc, store)

  assert.equal(result.ok, true)
  assert.ok(rec.labels.some(l => l === 'distill:ARCHITECTURE.md'), 'ARCHITECTURE distilled')
  // The five fixed docs + 4 specs + 2 ADRs are all mirrored.
  for (const d of ['ARCHITECTURE.md', 'PRD.md', 'INDEX.md', 'ACCEPTANCE.md', 'GLOSSARY.md']) {
    assert.ok(store.distilled.includes(d), `${d} distilled`)
  }
  assert.equal(store.distilled.filter(p => p.startsWith('specs/')).length, 4, 'all 4 specs distilled')
  assert.equal(store.distilled.filter(p => p.startsWith('adr/')).length, 2, 'both ADRs distilled')
  assert.equal(result.keyDocs.distilledDir, '/tmp/portkit-out/distilled/')
  assert.equal(result.counts.distilledDocs, 11, '5 fixed docs + 4 specs + 2 ADRs')
  assert.equal(result.counts.residualCitations, 0)
})

test('distill: OFF by default — no distilled/ mirror, no distill agents', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  const store = {}
  const { result, rec } = await run({ ...BASE }, sc, store) // distill not set
  assert.ok(!rec.labels.some(l => l.startsWith('distill:')), 'no distill agents run by default')
  assert.equal(store.distilled, undefined)
  assert.ok(!('distilledDir' in result.keyDocs))
  assert.ok(!('distilledDocs' in result.counts))
})

test('distill: residual citations are surfaced loudly, not hidden', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 1 }) // 5 fixed + 1 spec = 6 docs
  const store = { residualPerDoc: 2 } // each distilled doc reports 2 leftover citations
  const { result } = await run({ ...BASE, distill: true }, sc, store)
  assert.equal(result.counts.residualCitations, 12, '2 residual × 6 docs, aggregated')
  assert.ok(result.truncations.some(t => /residual citation/.test(t)), 'residuals flagged in truncations')
})

// ===========================================================================
// Per-phase commands: the `until` ceiling stops after a chosen stage (review /
// dev-debugging), leaves the checkpoint intact, and never runs a later phase.
// ===========================================================================
// Each phase command is a thin wrapper that sets `until: '<stage>'`; a paused result
// carries { paused: true, stage, nextCommand } and (crucially) does NOT clear the IR,
// so the next command resumes from it.

test('until=mapped: stops after Map, runs no discovery, keeps the checkpoint', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 2 })
  const store = {}
  const { result, rec } = await run({ ...BASE, until: 'mapped' }, sc, store)

  assert.equal(result.paused, true)
  assert.equal(result.stage, 'mapped')
  assert.equal(result.nextCommand, '/portkit-discover')
  assert.ok(rec.labels.includes('map:survey'), 'Map ran')
  assert.ok(!rec.labels.some(l => l.startsWith('discover:')), 'discovery must NOT run past the ceiling')
  assert.ok(!rec.labels.includes('synthesize'))
  assert.ok(!rec.labels.includes('ir:clear'), 'a phase pause must NOT clear the checkpoint')
  assert.ok(store.ir && store.ir.stage === 'mapped', 'checkpoint kept at the map stage')
})

test('until=discovered: stops after Discover, before synthesis, checkpoint kept', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 2 })
  const store = {}
  const { result, rec } = await run({ ...BASE, until: 'discovered' }, sc, store)

  assert.equal(result.paused, true)
  assert.equal(result.stage, 'discovered')
  assert.ok(rec.labels.some(l => l.startsWith('discover:')), 'discovery ran')
  assert.ok(!rec.labels.includes('synthesize'), 'synthesis must not run past the ceiling')
  assert.ok(!rec.labels.includes('ir:clear'))
  assert.equal(store.ir.stage, 'discovered')
})

test('until=docs: stops after the doc family, before ADR discovery', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2, decisions: [{ id: 'd1', title: 'X', evidence: ['a.go:1'] }] })
  const store = {}
  const { result, rec } = await run({ ...BASE, until: 'docs' }, sc, store)

  assert.equal(result.paused, true)
  assert.equal(result.stage, 'docs')
  for (const lbl of ['index', 'acceptance', 'arch', 'prd']) assert.ok(rec.labels.includes(lbl), `${lbl} authored`)
  assert.ok(!rec.labels.includes('adr:discover'), 'ADRs must not run past the ceiling')
  assert.ok(!rec.labels.some(l => l.startsWith('slice:')), 'no slice specs written yet')
  assert.equal(store.ir.stage, 'docs')
})

test('until=adrs: stops after ADRs, before any slice spec is written', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2, decisions: [{ id: 'd1', title: 'X', evidence: ['a.go:1'] }] })
  const store = {}
  const { result, rec } = await run({ ...BASE, until: 'adrs' }, sc, store)

  assert.equal(result.paused, true)
  assert.equal(result.stage, 'adrs')
  assert.ok(rec.labels.includes('adr:discover'), 'ADR discovery ran')
  assert.ok(!rec.labels.some(l => l.startsWith('slice:')), 'no slice specs written past the ceiling')
  assert.ok(!rec.labels.some(l => l.startsWith('critic:')))
  assert.equal(store.ir.stage, 'adrs')
})

test('until=writing: stops after every spec is written, before the critic', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 3 }) // 6 specs
  const store = {}
  const { result, rec } = await run({ ...BASE, until: 'writing' }, sc, store)

  assert.equal(result.paused, true)
  assert.equal(result.stage, 'writing')
  assert.equal(result.nextCommand, '/portkit-critic')
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6], 'all specs written')
  assert.ok(!rec.labels.some(l => l.startsWith('critic:')), 'critic must not run past the ceiling')
  assert.ok(!rec.labels.includes('ir:clear'))
  assert.equal(store.ir.stage, 'writing')
})

test('until=critiqued: stops after the critic, persists gaps, runs no distill, keeps checkpoint', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 2 })
  const store = {}
  const { result, rec } = await run({ ...BASE, until: 'critiqued' }, sc, store)

  assert.equal(result.paused, true)
  assert.equal(result.stage, 'critiqued')
  assert.ok(rec.labels.includes('critic:1'), 'critic ran')
  assert.ok(!rec.labels.some(l => l.startsWith('distill:')), 'distill must not run past the ceiling')
  assert.ok(!rec.labels.includes('ir:clear'), 'critic pause keeps the checkpoint for an optional distill phase')
  assert.equal(store.ir.stage, 'critiqued')
  assert.ok(Array.isArray(store.ir.gaps), 'gaps persisted so a resume can report them')
})

test('phase-by-phase sequence produces the SAME kit as one full run, and distill finalizes/clears', async () => {
  const sc = scenario({
    features: ['e1', 'e2'], slicesPerFeature: 2, // 4 specs
    decisions: [{ id: 'd1', title: 'Persist as JSONL', evidence: ['x.go:1'] }],
  })
  const store = {}
  // Walk the ceilings in order, sharing the checkpoint (auto-resume, no fresh flag) —
  // exactly what /portkit-map → … → /portkit-critic do.
  for (const until of ['mapped', 'discovered', 'docs', 'adrs', 'writing', 'critiqued']) {
    const { result } = await run({ ...BASE, until }, sc, store)
    assert.equal(result.paused, true, `paused at ${until}`)
    assert.equal(result.stage, until)
    assert.notEqual(store.ir, undefined, `checkpoint kept after ${until}`)
  }
  // Terminal /portkit-distill (distill:true, no ceiling) runs to natural completion.
  const { result: fin, rec } = await run({ ...BASE, distill: true }, sc, store)
  assert.equal(fin.ok, true)
  assert.equal(fin.resumeRequired, false)
  assert.ok(rec.labels.some(l => l.startsWith('distill:')), 'distill ran on the terminal phase')
  assert.equal(store.ir, undefined, 'checkpoint cleared at natural completion')
  assert.deepEqual([...store.written].sort((a, b) => a - b), [1, 2, 3, 4], 'every slice written exactly once across the phases')
  assert.equal(fin.counts.slicesWritten, 4)
  assert.equal(fin.counts.adrs, 1)
})

test('a full /portkit run (no until) is unaffected: never pauses, still clears the checkpoint', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 2 })
  const store = {}
  const { result } = await run({ ...BASE }, sc, store) // no until
  assert.ok(!('paused' in result), 'no ceiling => never pauses')
  assert.equal(result.resumeRequired, false)
  assert.equal(store.ir, undefined, 'full run clears the checkpoint as before')
})

test('default output dir uses the _portkit suffix (never _recreation)', async () => {
  const sc = scenario({ features: ['e1'], slicesPerFeature: 1 })
  const store = {}
  // No outputDir passed -> the workflow derives it from the input/cwd with a _portkit suffix.
  const { result } = await run({ inputDir: '.', until: 'mapped' }, sc, store)
  assert.equal(result.paused, true)
  assert.match(result.outDir, /_portkit$/, 'default output dir ends with _portkit')
  assert.ok(!/_recreation/.test(result.outDir), 'the old _recreation suffix is gone')
})

// --- critic respects INTENTIONAL test-scope omissions (limitSlices / maxFeatures) ---
// The critic must be told a DEV/TEST truncation is deliberate, so its gap-fill loop never
// "repairs" it by regenerating the omitted specs (which would silently turn a partial test
// kit into a claimed-complete one). Full runs must stay byte-identical (no clause).

function criticPromptOf(rec) {
  const c = rec.prompts.find(p => p.label === 'critic:1')
  return c ? c.prompt : ''
}

test('limitSlices run: critic prompt carries the intentional-omission scope clause', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 3 }) // 6 slices
  const store = {}
  const { result, rec } = await run({ ...BASE, limitSlices: 3 }, sc, store)
  assert.equal(result.counts.slicesWritten, 3)
  assert.equal(result.counts.slicesOmittedForTest, 3)
  const cp = criticPromptOf(rec)
  assert.match(cp, /INTENTIONAL TEST-SCOPE/)
  assert.match(cp, /3 slice spec\(s\) were INTENTIONALLY omitted/)
  assert.match(cp, /limitSlices=3/)
})

test('maxFeatures run: critic prompt reports the dropped features as intentional', async () => {
  const sc = scenario({ features: ['e1', 'e2', 'e3'], slicesPerFeature: 1 }) // 3 features discovered
  const store = {}
  const { rec } = await run({ ...BASE, maxFeatures: 1 }, sc, store)
  const cp = criticPromptOf(rec)
  assert.match(cp, /INTENTIONAL TEST-SCOPE/)
  assert.match(cp, /2 feature\(ies\) were INTENTIONALLY dropped/)
  assert.match(cp, /1 of 3/)
})

test('normal full run: critic prompt has NO scope clause (byte-identical-when-unset)', async () => {
  const sc = scenario({ features: ['e1', 'e2'], slicesPerFeature: 3 })
  const store = {}
  const { rec } = await run({ ...BASE }, sc, store)
  assert.ok(!/INTENTIONAL TEST-SCOPE/.test(criticPromptOf(rec)), 'full run must not carry the test-scope clause')
})

test('maxFeatures scope clause survives a resume into the critic stage (featuresTotal persisted)', async () => {
  // Pass 1: stop right after mapping, with maxFeatures capping 3 -> 1. This persists featuresTotal.
  const sc = scenario({ features: ['e1', 'e2', 'e3'], slicesPerFeature: 1 })
  const store = {}
  await run({ ...BASE, maxFeatures: 1, until: 'mapped' }, sc, store)
  assert.equal(store.ir.featuresTotal, 3, 'pre-cap feature total is persisted in the checkpoint')
  // Pass 2: resume to completion (map is skipped) — the clause must still reflect the cap.
  const { rec } = await run({ ...BASE, maxFeatures: 1 }, sc, store)
  const cp = criticPromptOf(rec)
  assert.match(cp, /2 feature\(ies\) were INTENTIONALLY dropped/)
  assert.match(cp, /1 of 3/)
})
