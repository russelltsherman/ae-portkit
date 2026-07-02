export const meta = {
  name: 'portkit',
  description: 'Analyze a codebase into a stack-neutral recreation kit (PRD, architecture spec, per-feature specs, ADRs, acceptance criteria) a weaker model can rebuild from',
  whenToUse: 'Reverse-engineering an existing project into design/planning docs, for a weaker downstream model to recreate it from the docs alone',
  phases: [
    { title: 'Preflight', detail: 'verify the input dir exists; abort loudly if not' },
    { title: 'Map', detail: 'survey the repo; draft the capability inventory' },
    { title: 'Discover slices', detail: 'trace each capability end-to-end; extract behavioral spec from tests' },
    { title: 'Synthesize', detail: 'normalize/dedup features; compute the build order; author PRD + ARCHITECTURE + INDEX + ACCEPTANCE' },
    { title: 'ADRs', detail: 'discover architecturally significant decisions; write one MADR-style ADR each' },
    { title: 'Write specs', detail: 'one self-contained, self-testing feature spec per unit' },
    { title: 'Critic', detail: 'grounding + completeness pass; write RISKS-AND-GAPS.md' },
  ],
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
// args may arrive as a structured object (from the slash command / a hand call),
// a JSON string, a raw CLI string forwarded by the skill/command bridge (e.g.
// "--input /src/mulch" or just "/src/mulch"), or undefined. parseArgs()
// (deterministic region) normalizes all of them to a config object — crucially
// recovering inputDir from the CLI-string form so the run never silently drifts
// to the cwd. This is a STACK-NEUTRAL recreation kit: there is no target language.
const cfg = parseArgs(args)
// Input dir. Preferred name: inputDir; legacy fallback: sourcePath.
const SOURCE = cfg.inputDir || cfg.sourcePath || '.'
// Output dir. Preferred name: outputDir; legacy fallback: outDir. When unset it
// defaults to a SIBLING of the input dir named "<inputDir>_recreation" (e.g.
// /src/mulch -> /src/mulch_recreation). We deliberately do NOT nest output inside
// the input dir — that pollutes the source tree (it shows up as untracked files
// in the source's own repo). When inputDir is unset SOURCE is ".", which has no
// sensible sibling, so we fall back to "portkit_recreation" in the cwd.
const OUT = (() => {
  if (cfg.outputDir || cfg.outDir) return cfg.outputDir || cfg.outDir
  const base = SOURCE.replace(/\/+$/, '')
  if (base === '.' || base === '') return 'portkit_recreation'
  return `${base}_recreation`.replace(/^\.\//, '')
})()

// ---------------------------------------------------------------------------
// Scale guards. The Workflow runtime caps a run at ~1000 agents total and 4096
// items per parallel/pipeline call. A large repo with per-epic + per-feature +
// per-ADR fan-out can blow that, so we cap each axis and LOG anything we drop
// (silent truncation reads as "complete" when it isn't). Overridable via args.
//
// NOTE: there is deliberately NO cap on total features/slices. They ARE the
// deliverable — dropping them produces an incomplete recreation kit, which defeats
// the plugin. Genuine over-scale (feature fan-out that would approach the
// ~1000-agent ceiling) is handled by epic-partitioned resumable passes, not by
// discarding features.
// ---------------------------------------------------------------------------
const MAX_EPICS = Number(cfg.maxEpics) || 40
// Architecturally significant decisions get one MADR-style ADR each. Bounded (the
// consumer needs the load-bearing decisions, not an exhaustive archaeology).
const MAX_ADRS = Number(cfg.maxAdrs) || 12
const MAX_GAPFILL_ROUNDS = Number(cfg.maxGapfillRounds) || 2
// DEV/TEST ONLY cost cap. `limitSlices=N` writes only the first N features (in build
// order) so a live run exercises the ENTIRE pipeline (map → discover → synthesize →
// adrs → write → critic) cheaply. 0 = unlimited = the production default. This is
// deliberately NOT the removed silent `maxSlices` cap: it is opt-in, off by default,
// and reported LOUDLY as a partial/test kit — never presented as a complete
// recreation kit. Pair with a low `maxEpics` to also cut discovery cost for a smoke test.
const LIMIT_SLICES = Math.max(0, Math.floor(Number(cfg.limitSlices) || 0))

// Concurrency throttle. The runtime caps in-flight agents at min(16, cores-2),
// but that ceiling is high enough that the per-agent model requests trip API
// rate limits on a busy account. We bound in-flight agents to a gentler limit
// (overridable via args.maxConcurrency) and run every fan-out through pooled()
// instead of letting parallel()/pipeline() saturate the runtime cap.
const MAX_CONCURRENCY = Math.max(1, Number(cfg.maxConcurrency) || 8)

// Checkpoint granularity for the discovery phase. Discovery is the most expensive
// analysis phase (2 agents per capability), so we process capabilities in batches
// of this size and persist a checkpoint after each batch — an interruption keeps
// every already-analyzed capability instead of reprocessing discovery from scratch.
const CHECKPOINT_EVERY = Math.max(1, Number(cfg.checkpointEvery) || MAX_CONCURRENCY)

// Over-scale guard. Slices are NEVER dropped. When a single run's projected agent
// count would approach the runtime's ~1000-agent ceiling, the expensive write
// phase is partitioned into epic-batched RESUMABLE passes: the synthesized IR is
// persisted under OUT and reloaded on `{ resume: true }`, so the costly map/
// discover/synthesize work runs exactly once and only slice-writing fans out
// across passes. Both knobs are tunable (tests force partitioning with a low cap).
const AGENT_CAP = Number(cfg.maxAgents) || 1000
const SAFE_BUDGET = Math.max(20, Math.floor(AGENT_CAP * (Number(cfg.agentSafetyFactor) || 0.8)))
const IR_PATH = `${OUT}/.portkit/ir.json`
// Fences delimit the verbatim IR JSON inside the persist agent's prompt so both
// the real agent (writes it to a file) and tests (parse it back) can extract it.
const IR_OPEN = '<<<PORTKIT-IR-JSON>>>'
const IR_CLOSE = '<<<END-PORTKIT-IR-JSON>>>'

const dropped = [] // truncation ledger, surfaced in the final result + RISKS doc
function cap(list, max, what) {
  if (list.length <= max) return list
  const kept = list.slice(0, max)
  const note = `Capped ${what}: kept ${max} of ${list.length} (dropped ${list.length - max}).`
  log(`⚠️  ${note}`)
  dropped.push(note)
  return kept
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'slice'
}
function pad(n) { return String(n).padStart(4, '0') }

// <portkit:deterministic>
// PURE deterministic helpers — single source of truth for the build-graph spine.
// INVARIANT: plain data in, plain data out. No injected globals (agent/log/phase/
// budget), no require/import, no Date.now/Math.random. This region is extracted
// verbatim and unit-tested by portkit.deterministic.test.mjs via new Function(),
// so it must stay self-contained: every helper a function here calls lives in
// this fence too. Anything that touches an agent or writes a file does NOT belong here.
//
// VOCABULARY: this region is a build-GRAPH engine and keeps the internal IR names
// `slice`/`epic`/`dependsOn`. The OUTPUT layer maps them to user-facing terms:
// a `slice` becomes a per-FEATURE spec (specs/<n>-<name>.md) and an `epic` is a
// CAPABILITY grouping in INDEX.md. Renaming here would churn every tested helper
// for zero behavioral gain, so the mismatch is intentional and documented once.

// parseArgs — normalize the workflow's `args` input into a plain config object,
// no matter how it arrives. The slash command is SUPPOSED to hand us a structured
// object ({ inputDir, outputDir }), but when the workflow is launched via the
// skill/command bridge the RAW argument string is forwarded verbatim instead
// (e.g. "--input /src/mulch" or just "/src/mulch"). Before this helper that string
// fell through to SOURCE=".", silently analyzing the cwd (the WRONG codebase). This
// is the single normalization point; it accepts every shape:
//   - object               -> returned as-is (already structured; the happy path)
//   - JSON object string    -> parsed and used directly
//   - CLI string            -> parsed as `[input] [--input d] [--output d] [--knob v]`
//   - undefined/null/other  -> {}
// Pure (returns data, never logs): any warnings are emitted by the caller.
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  const s = raw.trim()
  if (!s) return {}
  // A serialized structured form (JSON object/array) — honor it verbatim.
  if (s[0] === '{' || s[0] === '[') {
    try { const o = JSON.parse(s); if (o && typeof o === 'object') return o } catch { /* fall through to CLI parse */ }
  }
  return parseCliArgs(s)
}

// parseCliArgs — parse the command's documented `[input-dir] [--input <dir>]
// [--output <dir>] [--<knob> <value>]` grammar from a raw string. Flags (and the
// --flag=value form) override the positional input dir, as the command spec states.
// Recognized flag aliases collapse to the canonical cfg keys (inputDir/outputDir);
// any other --flag passes through with its name preserved (camelCase intact) so
// tuning knobs like --maxEpics still work. A bare --flag with no value becomes `true`.
function parseCliArgs(s) {
  const alias = {
    input: 'inputDir', inputdir: 'inputDir',
    output: 'outputDir', outputdir: 'outputDir', out: 'outputDir', outdir: 'outputDir',
  }
  const toks = s.split(/\s+/).filter(Boolean)
  const cfg = {}
  const positionals = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.startsWith('--')) {
      let name = t.slice(2)
      let value
      const eq = name.indexOf('=')
      if (eq !== -1) { value = name.slice(eq + 1); name = name.slice(0, eq) }
      else if (i + 1 < toks.length && !toks[i + 1].startsWith('--')) value = toks[++i]
      else value = true
      cfg[alias[name.toLowerCase()] || name] = value
    } else {
      positionals.push(t)
    }
  }
  // Positional fallback: the sole positional is the input dir. A flag already set wins.
  if (cfg.inputDir === undefined && positionals[0] !== undefined) cfg.inputDir = positionals[0]
  return cfg
}

// topoSort — deterministic Kahn topological sort over the `dependsOn` graph.
// Input: [{ id, dependsOn? }]. `dependsOn` lists prerequisite slice ids (those
// must build first). Output: { order: [id…], notes: [string…] }. Anomalies are
// RETURNED as notes (the region is pure — it cannot log); the caller folds them
// into the run's truncation/risks ledger. Guarantees: every input id appears in
// `order` exactly once (NEVER drops a slice — the whole point of this rewrite).
//   - unknown dep (id not present)  -> edge ignored, noted (treated as satisfied)
//   - self-edge (dependsOn itself)  -> ignored, noted
//   - duplicate dep on same slice   -> counted once (parallel-edge dedupe)
//   - cycle                          -> acyclic prefix emitted, then the cyclic
//                                       remainder appended in discovery order, noted
function topoSort(slices) {
  const notes = []
  const ids = slices.map(s => s.id)
  const idSet = new Set(ids)
  const indeg = new Map(ids.map(id => [id, 0]))
  const dependents = new Map(ids.map(id => [id, []]))
  for (const s of slices) {
    const seen = new Set()
    for (const dep of (s.dependsOn || [])) {
      if (dep === s.id) { notes.push(`Slice "${s.id}" dependsOn itself; self-edge ignored.`); continue }
      if (!idSet.has(dep)) { notes.push(`Slice "${s.id}" dependsOn unknown id "${dep}"; treated as already satisfied.`); continue }
      if (seen.has(dep)) continue // parallel-edge dedupe
      seen.add(dep)
      indeg.set(s.id, indeg.get(s.id) + 1)
      dependents.get(dep).push(s.id)
    }
  }
  // Kahn, processed FIFO so the initial zero-indegree set keeps discovery order
  // (stable sort): ties never reorder relative to how slices were discovered.
  const order = ids.filter(id => indeg.get(id) === 0)
  for (let qi = 0; qi < order.length; qi++) {
    for (const dep of dependents.get(order[qi])) {
      indeg.set(dep, indeg.get(dep) - 1)
      if (indeg.get(dep) === 0) order.push(dep)
    }
  }
  if (order.length < ids.length) {
    const emitted = new Set(order)
    const cyclic = ids.filter(id => !emitted.has(id)) // discovery order
    notes.push(`Dependency cycle: ${cyclic.length} slice(s) could not be topologically ordered and were appended in discovery order: ${cyclic.join(', ')}.`)
    for (const id of cyclic) order.push(id)
  }
  return { order, notes }
}

// rewriteEdges — apply a slice merge map to the slice list, mechanically and
// safely. `mergeMap` maps a merged-away slice id -> its surviving canonical id
// (Map or plain object; ids absent from it are their own canonical). Returns
// { slices, notes }:
//   - merged-away slices are removed; only canonical survivors remain (discovery order)
//   - a survivor inherits the UNION of `dependsOn` from every slice in its merge
//     group, each dep remapped to its canonical id (so an edge to a merged-away id
//     never dangles — the exact failure the Critic hunts for)
//   - self-edges created by the merge are dropped; parallel edges deduped
//   - `mergedFrom` records the absorbed original ids (provenance)
// A mergeMap target that is not a present slice id is IGNORED (the slice stays
// itself) so a bad map can never drop a slice. Cycle DETECTION is not done here —
// run topoSort() on the result; it reports any cycle a merge introduced.
function rewriteEdges(slices, mergeMap) {
  const mm = mergeMap instanceof Map ? mergeMap : new Map(Object.entries(mergeMap || {}))
  const byId = new Set(slices.map(s => s.id))
  const canon = (id) => {
    let cur = id, guard = 0
    const seen = new Set()
    while (mm.has(cur) && mm.get(cur) !== cur && !seen.has(cur) && guard++ < 10000) {
      seen.add(cur)
      cur = mm.get(cur)
    }
    return byId.has(cur) ? cur : id // never resolve to a non-existent slice
  }
  const groups = new Map() // canonicalId -> [original slices], discovery order
  for (const s of slices) {
    const c = canon(s.id)
    if (!groups.has(c)) groups.set(c, [])
    groups.get(c).push(s)
  }
  const notes = []
  const out = []
  for (const s of slices) {
    if (canon(s.id) !== s.id) continue // not a survivor
    const group = groups.get(s.id)
    const absorbed = group.filter(o => o.id !== s.id).map(o => o.id)
    const deps = []
    const seen = new Set()
    for (const o of group) {
      for (const dep of (o.dependsOn || [])) {
        const cd = canon(dep)
        if (cd === s.id) continue // self-edge after merge
        if (seen.has(cd)) continue // parallel-edge dedupe
        seen.add(cd)
        deps.push(cd)
      }
    }
    const mergedFrom = Array.from(new Set([...(s.mergedFrom || []), ...absorbed]))
    if (absorbed.length) notes.push(`Merged slice(s) ${absorbed.join(', ')} into "${s.id}".`)
    out.push({ ...s, dependsOn: deps, mergedFrom })
  }
  return { slices: out, notes }
}

// buildEpicTree — group slices into an epic->slices tree, preserving first-
// appearance order of both epics and slices (deterministic). Returns
// [{ epicId, sliceIds: [id…] }…]. Slices with no epicId are grouped under null.
function buildEpicTree(slices) {
  const tree = new Map() // epicId -> [sliceId…]
  for (const s of slices) {
    const e = s.epicId ?? null
    if (!tree.has(e)) tree.set(e, [])
    tree.get(e).push(s.id)
  }
  return Array.from(tree, ([epicId, sliceIds]) => ({ epicId, sliceIds }))
}

// projectAgents — estimate the total agent() calls a single full run would make,
// to decide whether to partition the write phase (the runtime caps a run at ~1000
// agents). Mirrors the actual fan-out: preflight + map + 2/epic (discover+behavior)
// + synthesize + index + acceptance + architecture + prd + adr:discover + 1/feature
// (write) + min(adrCount, maxAdrs) (adr writers) + critic (1 + gapfill rounds).
// Deliberately an upper-ish estimate; the per-gap fixers are unpredictable so they
// are folded into the gapfill term. The checkpoint agents (one loadIR at startup +
// a persist per stage/discovery-batch + one clearIR at the end) are deliberately NOT
// modeled here: they are a small constant the SAFE_BUDGET safety factor absorbs, and
// counting them would only make the over-scale guard trip slightly earlier.
function projectAgents({ epicCount = 0, sliceCount = 0, adrCount = 0, maxAdrs = 0, gapfillRounds = 0 } = {}) {
  // preflight, map, synthesize, index, acceptance, architecture, prd, adr:discover, critic(base)
  const fixed = 9
  const discovery = 2 * epicCount
  const writes = sliceCount
  const adrs = Math.min(adrCount, maxAdrs)
  return fixed + discovery + writes + adrs + gapfillRounds
}

// planEpicBatches — partition epics into ordered write batches so each batch's
// total slice count stays within `perBatch`, WITHOUT splitting an epic across
// batches (partition-by-epic). A single epic larger than `perBatch` becomes its
// own batch (we never split or drop slices — an over-budget batch is acceptable;
// a dropped slice is not). Returns [{ epicIds:[…], sliceIds:[…] }…]; an epicId of
// null is preserved as-is. With a non-positive limit, every epic is its own batch.
// (Param is `perBatch`, not `budget` — `budget` is a reserved runtime global.)
function planEpicBatches(epicTree, perBatch) {
  const limit = perBatch > 0 ? perBatch : 1
  const batches = []
  let cur = null
  for (const { epicId, sliceIds } of epicTree) {
    const size = sliceIds.length
    if (!cur) { cur = { epicIds: [epicId], sliceIds: [...sliceIds] }; continue }
    if (cur.sliceIds.length + size > limit && cur.sliceIds.length > 0) {
      batches.push(cur)
      cur = { epicIds: [epicId], sliceIds: [...sliceIds] }
    } else {
      cur.epicIds.push(epicId)
      cur.sliceIds.push(...sliceIds)
    }
  }
  if (cur) batches.push(cur)
  return batches
}

// STAGES — the linear checkpoint ladder the workflow advances through, persisted in
// the IR as `stage`. A resume skips every stage whose work is already done. The
// intermediate 'discovering' marks a PARTIALLY complete discovery phase (some
// capabilities analyzed, more to go), so it sits between 'mapped' and 'discovered'.
function stageIndex(stage) {
  return ['mapped', 'discovering', 'discovered', 'synthesized', 'docs', 'adrs', 'writing'].indexOf(stage)
}
// stageDone — has the run already COMPLETED `target`'s work? True iff the saved
// stage is at or beyond target. An unknown/absent stage (fresh run) -> false, so a
// fresh run does every stage. 'discovering' is NOT >= 'discovered' (discovery is
// only partially done), so a resume mid-discovery still finishes the phase.
function stageDone(current, target) {
  const c = stageIndex(current)
  const t = stageIndex(target)
  return t >= 0 && c >= t
}

// chunk — split an array into fixed-size, order-preserving groups (used to batch
// capability discovery so each batch can checkpoint). A non-positive size yields a
// single group (or none for an empty input).
function chunk(arr, size) {
  if (!(size > 0)) return arr.length ? [arr.slice()] : []
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
// </portkit:deterministic>

// Bounded-concurrency fan-out. Same contract as parallel() — order-stable, never
// rejects, a throwing thunk resolves to null — but at most MAX_CONCURRENCY thunks
// are ever in flight, via a rolling worker pool (no head-of-line batching). Use
// this in place of parallel() for every agent fan-out so we don't flood the API.
async function pooled(thunks, limit = MAX_CONCURRENCY) {
  const results = new Array(thunks.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= thunks.length) return
      try { results[i] = await thunks[i]() }
      catch { results[i] = null }
    }
  }
  const n = Math.max(1, Math.min(limit, thunks.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

const GROUND_RULE =
  'GROUNDING (mandatory): every nontrivial factual claim about the source must cite a `path:line` ' +
  'from the actual code. If you cannot ground a claim, mark it `[UNVERIFIED]` rather than asserting it. ' +
  'Do not invent behavior. The downstream consumer is a LESS CAPABLE local model that will rebuild from ' +
  'your docs WITHOUT reading the source — be explicit, prescriptive, and exhaustive about exact behavior ' +
  '(errors, edge cases, ordering), never suggestive.'

// Reverse-engineering inverts the normal docs->code direction: the source ships
// behavior, not intent. So any INTENT statement (goal, non-goal, success metric,
// rationale, "why", rejected alternative) is an inference, not an observed fact,
// and must be tagged so a downstream reader never mistakes a guess for a spec.
const INFER_RULE =
  'INFERENCE (mandatory): this kit is reverse-engineered from OBSERVED behavior. The source rarely ' +
  'states intent, so any goal, non-goal, success metric, rationale, or "why" is an INFERENCE — prefix ' +
  'every such statement with `[INFERRED]`. Observed facts must instead cite a `path:line`. Never present ' +
  'an inference as an observed fact, and never fabricate numbers or metrics; write `[INFERRED] none ' +
  'observable` when the source shows no evidence.'

// ---------------------------------------------------------------------------
// Schemas (small, required-tight)
// ---------------------------------------------------------------------------
const SYSTEM_MAP = {
  type: 'object',
  required: ['epics'],
  properties: {
    languages: { type: 'array', items: { type: 'string' } },
    buildSystem: { type: 'string' },
    testFrameworks: { type: 'array', items: { type: 'string' } },
    testPaths: { type: 'array', items: { type: 'string' } },
    dependencyManifests: { type: 'array', items: { type: 'string' } },
    epics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'kind'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string', description: 'endpoint | cli | public-api | event | job | ui-flow | other' },
          entryPoints: { type: 'array', items: { type: 'string' }, description: 'path:line anchors' },
          summary: { type: 'string' },
        },
      },
    },
  },
}

const SLICES = {
  type: 'object',
  required: ['slices'],
  properties: {
    slices: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'capability'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          capability: { type: 'string', description: 'the observable behavior this slice delivers' },
          thread: {
            type: 'array',
            description: 'every component/layer the slice touches, each with a path:line citation',
            items: {
              type: 'object',
              required: ['component', 'citation'],
              properties: { component: { type: 'string' }, citation: { type: 'string' } },
            },
          },
          behaviorSummary: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'slice ids this one needs first' },
        },
      },
    },
  },
}

const BEHAVIOR = {
  type: 'object',
  required: ['perSlice'],
  properties: {
    perSlice: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sliceId', 'coverage'],
        properties: {
          sliceId: { type: 'string' },
          coverage: { type: 'string', description: 'good | thin | none' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          testRefs: { type: 'array', items: { type: 'string' }, description: 'path:line of source tests' },
        },
      },
    },
  },
}

// The synth agent now does ONLY what needs an LLM: decide which slices are the
// SAME (merge groups). It no longer computes build order or writes any doc — that
// is JS-owned (topoSort) + dedicated writer agents (INDEX/ARCHITECTURE/PRD).
const SYNTH = {
  type: 'object',
  required: ['merges'],
  properties: {
    merges: {
      type: 'array',
      description: 'slice-merge decisions; each group collapses to one canonical slice. Empty if nothing merges.',
      items: {
        type: 'object',
        required: ['keep', 'merge'],
        properties: {
          keep: { type: 'string', description: 'the surviving canonical slice id' },
          merge: { type: 'array', items: { type: 'string' }, description: 'OTHER slice ids folded into keep (may be empty)' },
        },
      },
    },
  },
}

// ADR discovery — architecturally significant DECISIONS observable in the source.
// Each MUST carry path:line evidence (evidence-less "decisions" are speculation and
// are dropped); alternatives/context are optional and inferred.
const ADRS = {
  type: 'object',
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'evidence'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string', description: 'the decision, e.g. "Optimistic locking for account updates"' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'path:line anchors that prove the decision was made' },
          context: { type: 'string', description: 'observed problem the decision addresses' },
          alternatives: { type: 'array', items: { type: 'string' }, description: 'plausible rejected options (inferred)' },
        },
      },
    },
  },
}

const WROTE = {
  type: 'object',
  required: ['path', 'ok'],
  properties: {
    path: { type: 'string' },
    ok: { type: 'boolean' },
    selfContained: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const CRITIC = {
  type: 'object',
  required: ['gaps'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'detail'],
        properties: {
          kind: { type: 'string', description: 'unresolved-citation | thin-coverage | inference-as-fact | not-self-contained | missing | other' },
          detail: { type: 'string' },
          where: { type: 'string', description: 'doc path or slice id' },
          fixable: { type: 'boolean', description: 'can an agent fix this without human input?' },
        },
      },
    },
    wroteRisksDoc: { type: 'boolean' },
  },
}

// Persisted intermediate representation — the resumable checkpoint. It advances
// through `stage` (see stageDone) and accumulates each phase's output, so an
// interruption ANYWHERE resumes from the last completed stage instead of
// reprocessing. Loose item schemas: this is the workflow's own state, not
// source-derived content. Nothing is required — a mapped-stage checkpoint has no
// `ordered` yet, so demanding it would reject an early checkpoint on load.
const IR_SCHEMA = {
  type: 'object',
  required: [],
  properties: {
    stage: { type: 'string', description: 'mapped | discovering | discovered | synthesized | docs | adrs | writing' },
    source: { type: 'string', description: 'the inputDir this checkpoint belongs to (fingerprint for auto-resume)' },
    fileCount: { type: 'number' },
    partitioned: { type: 'boolean', description: 'was over-scale write partitioning engaged?' },
    sysFacts: { type: 'string' },
    fresh: {},
    epics: { type: 'array', items: {}, description: 'the mapped capability inventory' },
    perEpic: { type: 'array', items: {}, description: 'completed per-capability discovery results' },
    adrs: { type: 'array', items: {}, description: 'discovered decisions (authored once)' },
    slicesDiscovered: { type: 'number' },
    slicesOmittedForTest: { type: 'number' },
    truncations: { type: 'array', items: { type: 'string' }, description: 'cumulative truncation/dedup ledger' },
    written: { type: 'array', items: { type: 'number' }, description: 'build numbers already written' },
    ordered: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'epicId', 'n'],
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, epicId: { type: 'string' },
          n: { type: 'number' }, capability: { type: 'string' }, behaviorSummary: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          mergedFrom: { type: 'array', items: { type: 'string' } },
          thread: { type: 'array' }, behavior: {},
        },
      },
    },
  },
}

// ===========================================================================
// Preflight — fail loudly if the input dir does not exist.
// The Workflow JS sandbox has no filesystem access (no fs/existsSync), so we
// verify the path through a single deterministic probe agent rather than guess.
// Without this, a bad inputDir lets the Map agent silently "drift" to whatever
// it can reach from the cwd and produce a recreation kit for the WRONG codebase.
// ===========================================================================
phase('Preflight')
const PREFLIGHT = {
  type: 'object',
  required: ['exists', 'isDir', 'fileCount'],
  properties: {
    exists: { type: 'boolean', description: 'does the exact path exist?' },
    isDir: { type: 'boolean', description: 'is it a directory (not a file)?' },
    fileCount: { type: 'number', description: 'count of regular files under the path (probe is capped, that is fine)' },
  },
}
const probe = await agent(
  `You are the PortKit PREFLIGHT probe. Do EXACTLY one thing: determine whether the path \`${SOURCE}\` ` +
  `(relative to your working directory) exists and is a NON-EMPTY directory.\n\n` +
  `Run shell checks against that EXACT path only — for example:\n` +
  `  test -e "${SOURCE}" && echo EXISTS || echo MISSING\n` +
  `  test -d "${SOURCE}" && echo IS_DIR || echo NOT_DIR\n` +
  `  find "${SOURCE}" -type f 2>/dev/null | head -1000 | wc -l\n\n` +
  `HARD RULES: do NOT search for, guess, or substitute any alternative path. Do NOT survey, list, or read ` +
  `any other directory. If the path is missing, report exists=false — do NOT go looking for something similar. ` +
  `Report only what those exact commands return.`,
  { schema: PREFLIGHT, phase: 'Preflight', label: 'preflight:probe' }
)

if (!probe || !probe.exists || !probe.isDir || !(probe.fileCount > 0)) {
  const detail = !probe ? 'preflight probe failed to run'
    : !probe.exists ? 'path does not exist'
    : !probe.isDir ? 'path exists but is not a directory'
    : 'directory is empty (no files found)'
  log(`❌ PortKit ABORTED: input dir \`${SOURCE}\` — ${detail}. Nothing was generated.`)
  return {
    ok: false,
    error: `PortKit input dir is invalid: \`${SOURCE}\` — ${detail}. ` +
      `Pass a valid inputDir/sourcePath (relative to the working directory) and re-run. ` +
      `No documents were written.`,
    inputDir: SOURCE,
    preflight: probe || null,
  }
}
log(`Preflight OK: \`${SOURCE}\` is a directory with ${probe.fileCount}${probe.fileCount >= 1000 ? '+' : ''} file(s).`)

// ===========================================================================
// Write / critic — factored into helpers so the SAME tail serves the normal
// single-pass run, the first over-scale pass, and every resume pass.
// (Function declarations hoist, so the resume hook below can call them.)
// ===========================================================================
// Feature specs live flat under specs/ with global build-order numbering; the
// capability grouping (was epics/<epic>/) lives in INDEX.md instead.
function sliceDocPath(s) { return `${OUT}/specs/${pad(s.n)}-${slug(s.name)}.md` }

// Reserve enough of the agent budget for the final pass's tail (critic + a little
// overhead) so writing a full batch can never push the LAST pass over the cap.
// The doc-family writers (ARCHITECTURE/PRD/ADR/INDEX/ACCEPTANCE) run ONCE in the
// pass-1 synth tail, before partitioning, so they are NOT reserved here.
function tailReserve() {
  const critic = 1 + MAX_GAPFILL_ROUNDS
  return critic + 8
}

async function writeSliceDocs(sliceList) {
  const written = await pooled(sliceList.map((s) => () => {
    const path = sliceDocPath(s)
    const ctx = {
      id: s.id, name: s.name, epicId: s.epicId, buildNumber: s.n,
      capability: s.capability, thread: s.thread, behaviorSummary: s.behaviorSummary,
      dependsOn: s.dependsOn || [], behavior: s.behavior,
    }
    return agent(
      `You are the PortKit FEATURE-SPEC writer. Write ONE self-contained feature spec to \`${path}\`.\n\n` +
      `It must let a LESS CAPABLE local model rebuild this feature from this spec + ARCHITECTURE.md ALONE, ` +
      `without the source. Include, in this order:\n` +
      `- Title + one-line capability.\n` +
      `- The end-to-end behavior thread (each component with its source \`path:line\`).\n` +
      `- Interface/contract: inputs, outputs, and EXACT behavior — every error, edge case, and ordering guarantee.\n` +
      `- Prerequisite features (build order: this is #${s.n}; dependsOn ${JSON.stringify(s.dependsOn || [])}).\n` +
      `- Acceptance criteria for THIS feature (from the behavioral spec; concrete and runnable-in-spirit).\n` +
      `- Function/unit-sized build steps, each individually checkable.\n` +
      `- Shared conventions (names/types/cross-cutting rules) live in \`${OUT}/ARCHITECTURE.md\` — reference them, ` +
      `do NOT restate them, and do NOT depend on any other feature's internals.\n\n` +
      `Re-read the cited source as needed to be exact. Source root: \`${SOURCE}\`.\n\n` +
      `FEATURE DATA:\n${JSON.stringify(ctx, null, 2)}\n\n${GROUND_RULE}\n\n` +
      `After writing, return the path, whether it is genuinely self-contained, and any issues.`,
      { schema: WROTE, phase: 'Write specs', label: `slice:${s.n}:${slug(s.name)}` }
    )
  }))
  return written
}

// Discover ONE capability end-to-end: trace it into fine vertical slices (features),
// then extract each slice's behavioral acceptance spec from the test suite. Returns
// { epicId, slices, behavior } — or null if the discovery agent itself failed, so a
// failed capability is retried on the next resume rather than silently lost. A
// capability that legitimately has no slices returns { epicId, slices: [] } (done,
// not retried).
async function discoverEpic(epic, sysFacts) {
  const r = await agent(
    `You are the PortKit SLICE-DISCOVERY agent for ONE capability of the source at \`${SOURCE}\`.\n\n` +
    `EPIC: ${JSON.stringify(epic)}\n\n` +
    `Trace this capability END-TO-END through every layer it touches (entry → validation → business rule → ` +
    `data model → persistence → response/side-effects). Decompose it into fine, FUNCTION/UNIT-SIZED VERTICAL ` +
    `SLICES — each an independently buildable & testable thread. For each slice give: a stable id (prefix with ` +
    `the epic id), name, the observable capability, the \`thread\` (components touched, each with a \`path:line\` ` +
    `citation), a precise behaviorSummary, and dependsOn (other slice ids it needs first).\n\n` +
    `${GROUND_RULE}\n\nReturn the slices.`,
    { schema: SLICES, phase: 'Discover slices', label: `discover:${epic.id}` }
  )
  const prev = r ? { epicId: epic.id, slices: r.slices || [] } : null
  if (!prev || prev.slices.length === 0) return prev
  const ids = prev.slices.map(s => ({ id: s.id, name: s.name, capability: s.capability }))
  const b = await agent(
    `You are the PortKit BEHAVIOR-SPEC agent. The source's existing tests are the behavioral contract.\n\n` +
    `Source root: \`${SOURCE}\`. Test setup: ${sysFacts}\n\n` +
    `For each slice below, find the source tests that exercise it and translate them into LANGUAGE-NEUTRAL ` +
    `acceptance criteria (concrete enough that a weak model can self-check its rebuild). Cite each source test ` +
    `as \`path:line\`. Rate coverage good/thin/none. FLAG thin/none LOUDLY — never paper over missing coverage.\n\n` +
    `SLICES:\n${JSON.stringify(ids, null, 2)}\n\n${GROUND_RULE}\n\nReturn perSlice behavioral specs.`,
    { schema: BEHAVIOR, phase: 'Discover slices', label: `behavior:${epic.id}` }
  )
  return { ...prev, behavior: (b && b.perSlice) || [] }
}

async function runCritic() {
  phase('Critic')
  function criticPrompt(round, prior) {
    return `You are the PortKit CRITIC. Audit the generated recreation kit under \`${OUT}\` for whether a LESS ` +
      `CAPABLE local model could rebuild the project from it ALONE.\n\nCheck for:\n` +
      `- Unresolved/uncheckable \`path:line\` citations (sample and verify against \`${SOURCE}\`).\n` +
      `- Thin/missing test coverage not flagged in \`${OUT}/ACCEPTANCE.md\`.\n` +
      `- \`[INFERRED]\` misuse: an inference (goal, metric, rationale, "why") asserted as observed fact, OR an ` +
      `observed fact left uncited. Check PRD.md and every adr/*.md especially.\n` +
      `- Feature specs that are NOT actually self-contained or not end-to-end testable.\n` +
      `- Missing pieces (a capability with no feature spec, a dangling dependsOn, a spec with no acceptance criteria).\n\n` +
      (prior ? `Previously reported gaps that fix agents attempted:\n${prior}\n\n` : '') +
      `Append findings to \`${OUT}/RISKS-AND-GAPS.md\` (create if absent; this is round ${round}). ` +
      `Mark each gap fixable=true only if an agent could resolve it WITHOUT human input.\n\n${GROUND_RULE}\n\n${INFER_RULE}\n\nReturn the gaps.`
  }
  let critic = await agent(criticPrompt(1, null), { schema: CRITIC, phase: 'Critic', label: 'critic:1' })
  let gaps = (critic && critic.gaps) || []
  let round = 1
  while (
    gaps.some(g => g.fixable) &&
    round < MAX_GAPFILL_ROUNDS &&
    (!budget.total || budget.remaining() > 50_000)
  ) {
    round++
    const fixable = gaps.filter(g => g.fixable)
    log(`Gap-fill round ${round}: attempting ${fixable.length} fixable gap(s).`)
    await pooled(fixable.map((g, i) => () => agent(
      `You are the PortKit GAP-FIX agent. Resolve this gap by editing ONLY files under \`${OUT}\` (the generated ` +
      `recreation kit). Read the source at \`${SOURCE}\` as needed, but you MUST NOT create, modify, or delete ANY ` +
      `file outside \`${OUT}\` — never touch the source tree. If the gap is thin/missing coverage in the SOURCE's ` +
      `own tests, do NOT add tests to the source; instead flag it clearly in \`${OUT}/ACCEPTANCE.md\` and ` +
      `\`${OUT}/RISKS-AND-GAPS.md\`.\n\nGAP: ${JSON.stringify(g)}\n\n${GROUND_RULE}\n\n${INFER_RULE}`,
      { phase: 'Critic', label: `gapfix:${round}:${i + 1}` }
    )))
    critic = await agent(
      criticPrompt(round, JSON.stringify(fixable, null, 2)),
      { schema: CRITIC, phase: 'Critic', label: `critic:${round}` }
    )
    gaps = (critic && critic.gaps) || []
  }
  return gaps
}

// IR persistence — the checkpoint mechanism. The orchestrator sandbox has no
// filesystem, so an agent writes/reads/deletes the JSON. The persist agent writes
// the fenced bytes verbatim; the load agent returns the parsed object; the clear
// agent deletes the file on successful completion (so a later run starts fresh
// rather than auto-resuming a finished run).
async function persistIR(ir) {
  await agent(
    `You are the PortKit IR-PERSIST agent. Create the directory if needed and write the JSON between the fences ` +
    `below — VERBATIM, exactly those bytes and nothing else — to \`${IR_PATH}\`. Do not reformat, summarize, or ` +
    `add commentary. This is the workflow's resumable checkpoint.\n\n${IR_OPEN}\n${JSON.stringify(ir)}\n${IR_CLOSE}\n`,
    { phase: 'Checkpoint', label: 'ir:persist' }
  )
}
async function loadIR() {
  return await agent(
    `You are the PortKit IR-LOAD agent. Read the JSON file at \`${IR_PATH}\` and return its parsed contents ` +
    `EXACTLY as structured data (do not invent or alter fields). If the file does not exist or is empty, return ` +
    `an object whose \`ordered\` is an empty array (and no \`stage\`).`,
    { schema: IR_SCHEMA, phase: 'Checkpoint', label: 'ir:load' }
  )
}
async function clearIR() {
  await agent(
    `You are the PortKit IR-CLEAR agent. Delete the file at \`${IR_PATH}\` if it exists (e.g. \`rm -f "${IR_PATH}"\`). ` +
    `The run is complete, so this checkpoint is no longer needed and its presence would auto-resume a finished run. ` +
    `Return when done.`,
    { phase: 'Checkpoint', label: 'ir:clear' }
  )
}

// The single mutable checkpoint object. saveStage() merges a phase's output into it,
// stamps the stage, and persists — so the on-disk IR always reflects the furthest
// completed stage. Initialized fresh below, or replaced by a loaded checkpoint on
// auto-resume.
let checkpoint = null
async function saveStage(stage, patch = {}) {
  // Carry the truncation ledger into every checkpoint so a resume can re-seed it —
  // otherwise notes from earlier passes (capped epics, dedup/cycle notes) would be
  // lost and the final result would under-report what was dropped.
  checkpoint = { ...(checkpoint || {}), ...patch, stage, truncations: dropped }
  await persistIR(checkpoint)
  return checkpoint
}

// Shared tail. Writes the next un-written batch of feature specs; if any remain it
// persists progress and returns resumeRequired; otherwise it runs the critic and
// returns the final result. `partitioned` engages over-scale batching (off for a
// normal run, so behavior there is byte-for-byte unchanged). The doc-family writers
// (PRD/ARCHITECTURE/INDEX/ACCEPTANCE/ADR) already ran once in the pass-1 synth tail,
// so a resume never re-authors them — this tail only writes specs then criticizes.
async function runWriteAndFinish({ ordered, adrs = [], partitioned, priorWritten = [], extraCounts = {} }) {
  phase('Write specs')
  const writtenNs = new Set(priorWritten)
  const pending = ordered.filter(s => !writtenNs.has(s.n))

  let thisPass = pending
  if (partitioned) {
    const writeBudget = Math.max(1, SAFE_BUDGET - tailReserve())
    const batch = planEpicBatches(buildEpicTree(pending), writeBudget)[0]
    const ids = new Set((batch && batch.sliceIds) || [])
    thisPass = pending.filter(s => ids.has(s.id))
  }

  const docs = await writeSliceDocs(thisPass)
  // Mark only features that actually wrote OK as done; failures stay pending and are
  // retried on the next pass (so a flaky write is never silently lost).
  const okThisPass = thisPass.filter((s, i) => docs[i] && docs[i].ok)
  okThisPass.forEach(s => writtenNs.add(s.n))
  const remaining = ordered.filter(s => !writtenNs.has(s.n)).length
  log(`Wrote ${okThisPass.length}/${thisPass.length} feature spec(s)` +
    (partitioned ? ` — ${writtenNs.size}/${ordered.length} done, ${remaining} remaining` : ''))

  // Persist write progress before returning ANY resumeRequired result — this must
  // cover BOTH an over-scale partition (more batches to come) AND a single
  // non-partitioned pass whose writes partially failed (a transient API error or a
  // mid-run spend-limit stop leaves features pending). The checkpoint already holds
  // ordered/adrs (saved at earlier stages); here we just advance `written`. On a
  // clean single pass that writes everything we skip this and clear the checkpoint
  // at the end instead.
  if (partitioned || remaining > 0) {
    await saveStage('writing', { written: [...writtenNs] })
  }

  // Progress guard: a resume/partition pass that writes nothing new but still has
  // work left would loop forever on resume. Stop loudly instead. (A first pass that
  // wrote zero is intentionally left resumable — that is the spend-limit case, and
  // the IR persisted just above lets the user resume once the limit clears.)
  if (partitioned && okThisPass.length === 0 && remaining > 0) {
    const err = `Over-scale resume made no progress: all ${thisPass.length} write(s) this pass failed, ${remaining} feature(s) still pending.`
    log(`❌ ${err}`); dropped.push(err)
    return { ok: false, error: err, outDir: OUT, resumeRequired: true, truncations: dropped }
  }

  if (remaining > 0) {
    const note = `${remaining} feature spec(s) remain after this pass (writes incomplete — over-scale partition or an interrupted pass, e.g. a spend-limit stop) — re-run with { resume: true } pointed at outputDir "${OUT}" to continue (nothing dropped).`
    log(`⏸️  ${note}`); dropped.push(note)
    return {
      ok: true, outDir: OUT, resumeRequired: true,
      resumeArgs: { resume: true, outputDir: OUT },
      counts: { slicesPlanned: ordered.length, slicesWritten: writtenNs.size, slicesRemaining: remaining, ...extraCounts },
      truncations: dropped,
    }
  }

  const gaps = await runCritic()
  // The run is complete — remove the checkpoint so a later invocation starts fresh
  // instead of auto-resuming a finished run.
  await clearIR()
  return {
    ok: true, outDir: OUT, resumeRequired: false,
    counts: {
      slicesPlanned: ordered.length,
      slicesWritten: writtenNs.size,
      adrs: adrs.length,
      gapsRemaining: gaps.length,
      gapsRemainingHumanDecision: gaps.filter(g => !g.fixable).length,
      ...extraCounts,
    },
    truncations: dropped,
    keyDocs: {
      prd: `${OUT}/PRD.md`,
      architecture: `${OUT}/ARCHITECTURE.md`,
      index: `${OUT}/INDEX.md`,
      acceptance: `${OUT}/ACCEPTANCE.md`,
      adrDir: `${OUT}/adr/`,
      risks: `${OUT}/RISKS-AND-GAPS.md`,
    },
    remainingGaps: gaps,
  }
}

// ===========================================================================
// Checkpoint / resume (auto-detect). If a compatible checkpoint exists at the
// output dir and --fresh was not passed, resume from the last completed stage
// rather than reprocessing — a large run interrupted anywhere (crash, spend limit,
// API outage) picks up where it left off. Semantics:
//   - no flag       -> auto: resume if a matching checkpoint exists, else fresh
//   - resume: true  -> DEMAND a checkpoint (error if none — an explicit request)
//   - fresh: true   -> ignore any checkpoint and start over
// The checkpoint is fingerprinted by `source` (inputDir); one for a different
// source is ignored so a stale IR can never make us resume the WRONG codebase.
// ===========================================================================
if (!cfg.fresh) {
  const loaded = await loadIR()
  if (loaded && loaded.stage) {
    if (loaded.source && loaded.source !== SOURCE) {
      log(`⚠️  Ignoring checkpoint at \`${IR_PATH}\`: it belongs to a different source (\`${loaded.source}\` ≠ \`${SOURCE}\`). Starting fresh — use --output for a separate dir to keep both.`)
    } else {
      checkpoint = loaded
      dropped.push(...(Array.isArray(loaded.truncations) ? loaded.truncations : []))
      log(`↩️  Resuming from checkpoint stage '${loaded.stage}' for \`${SOURCE}\`.`)
    }
  }
}
if (cfg.resume && !checkpoint) {
  return {
    ok: false,
    error: `Resume requested but no usable checkpoint was found at \`${IR_PATH}\` for source \`${SOURCE}\`. ` +
      `Run PortKit normally first — it checkpoints as it goes and auto-resumes if interrupted.`,
    outDir: OUT,
  }
}
const RESUMING = !!checkpoint
const savedStage = checkpoint ? checkpoint.stage : null

// ===========================================================================
// Stage: Map — survey the repo + draft the capability inventory.
// ===========================================================================
let sysFacts, epics
if (RESUMING && stageDone(savedStage, 'mapped')) {
  sysFacts = checkpoint.sysFacts || '{}'
  epics = checkpoint.epics || []
  log(`Skipping map (checkpointed): ${epics.length} capability(ies).`)
} else {
  phase('Map')
  const map = await agent(
  `You are the PortKit MAP agent. Survey the source codebase rooted at \`${SOURCE}\`. ` +
  `This path has been preflight-verified to exist. If at any point it appears empty or unreadable, STOP and ` +
  `report it — do NOT survey any other directory or substitute a different path.\n\n` +
  `Tasks:\n` +
  `1. Identify languages, build system, test framework(s) and where tests live, and the dependency manifest file(s).\n` +
  `2. Discover the CAPABILITIES of the system as a DRAFT CAPABILITY INVENTORY — coarse, user/externally-observable ` +
  `behaviors (HTTP endpoints, CLI commands, public API operations, event/message handlers, scheduled jobs, UI flows). ` +
  `These are VERTICAL threads, NOT horizontal layers. Do NOT list "the models" or "the controllers" — list what the ` +
  `system DOES. Give each a stable id, a name, a kind, and entry-point \`path:line\` anchors.\n\n` +
  `Return ONLY the structured inventory as data — do NOT write any file (ARCHITECTURE.md is authored later from this ` +
  `data plus the discovered features).\n\n` +
  `${GROUND_RULE}\n\nReturn the structured inventory.`,
    { schema: SYSTEM_MAP, phase: 'Map', label: 'map:survey' }
  )
  if (!map || !Array.isArray(map.epics) || map.epics.length === 0) {
    return {
      ok: false,
      error: 'Map phase produced no capabilities — cannot build a recreation kit.',
      outDir: OUT,
    }
  }
  sysFacts = JSON.stringify({
    languages: map.languages, buildSystem: map.buildSystem,
    testFrameworks: map.testFrameworks, testPaths: map.testPaths,
    dependencyManifests: map.dependencyManifests,
  }, null, 2)
  epics = cap(map.epics, MAX_EPICS, 'epics')
  log(`Mapped ${map.epics.length} capability(ies); analyzing ${epics.length}.`)
  await saveStage('mapped', { source: SOURCE, fileCount: probe.fileCount, sysFacts, epics })
}

// ===========================================================================
// Stage: Discover — per capability, trace slices + extract the behavioral spec.
// Processed in CHECKPOINTED batches (CHECKPOINT_EVERY capabilities per batch): after
// each batch the checkpoint advances, so an interruption keeps every already-analyzed
// capability instead of restarting the whole (most expensive) discovery phase.
// ===========================================================================
let perEpicDone = (RESUMING && Array.isArray(checkpoint.perEpic)) ? checkpoint.perEpic : []
if (!(RESUMING && stageDone(savedStage, 'discovered'))) {
  phase('Discover slices')
  const doneIds = new Set(perEpicDone.map(e => e && e.epicId))
  const todo = epics.filter(e => !doneIds.has(e.id))
  if (perEpicDone.length) log(`Discovery resuming: ${perEpicDone.length} done, ${todo.length} capability(ies) to analyze.`)
  for (const group of chunk(todo, CHECKPOINT_EVERY)) {
    const results = await pooled(group.map((epic) => () => discoverEpic(epic, sysFacts)))
    perEpicDone.push(...results.filter(Boolean))
    await saveStage('discovering', { perEpic: perEpicDone })
  }
  await saveStage('discovered', { perEpic: perEpicDone })
}

// ===========================================================================
// Stage: Synthesize — dedup (the one job needing judgment); the mechanical graph
// work (rewriteEdges + topoSort) is JS-owned and unit-tested. Skipped wholesale on
// a resume past this stage (the ordered build graph is reloaded from the checkpoint,
// so build numbers stay stable — specs already written keep matching their numbers).
// ===========================================================================
let ordered, slicesDiscovered, slicesOmittedForTest = 0
if (RESUMING && stageDone(savedStage, 'synthesized')) {
  ordered = checkpoint.ordered || []
  slicesDiscovered = checkpoint.slicesDiscovered || ordered.length
  slicesOmittedForTest = checkpoint.slicesOmittedForTest || 0
  log(`Skipping synthesis (checkpointed): ${ordered.length} feature(s) in build order.`)
} else {
  // Flatten completed discovery into a single slice list, attaching behavior + epic.
  const allSlices = []
  for (const e of perEpicDone) {
    if (!e) continue
    const behaviorById = new Map((e.behavior || []).map(b => [b.sliceId, b]))
    for (const s of (e.slices || [])) {
      allSlices.push({ ...s, epicId: e.epicId, behavior: behaviorById.get(s.id) || null })
    }
  }
  if (allSlices.length === 0) {
    return { ok: false, error: 'No vertical slices were discovered.', outDir: OUT }
  }
  // Every discovered slice is carried — NEVER truncated (see the scale-guard note).
  const slices = allSlices
  slicesDiscovered = allSlices.length
  log(`Discovered ${slices.length} feature(s) across ${perEpicDone.filter(Boolean).length} capability(ies).`)
  phase('Synthesize')
  const synthInput = slices.map(s => ({
  id: s.id, name: s.name, epicId: s.epicId, capability: s.capability,
  behaviorSummary: s.behaviorSummary,
}))
const synth = await agent(
  `You are the PortKit SYNTHESIS agent. You receive ALL discovered vertical slices (features) in compact form.\n\n` +
  `Do ONE thing — DEDUP: identify sets of slices that are truly the SAME vertical thread discovered from different ` +
  `capabilities/angles. For each set return a merge group { keep, merge: [ids…] } — \`keep\` is the surviving ` +
  `canonical slice id, \`merge\` lists the OTHER ids folded into it. Only merge GENUINE duplicates; when in doubt ` +
  `do NOT merge (a wrongly-merged slice silently loses real behavior). Return an empty list if nothing merges. Do ` +
  `NOT compute a build order and do NOT renumber — ordering is handled deterministically downstream.\n\n` +
  `Source facts: ${sysFacts}\n\nSLICES:\n${JSON.stringify(synthInput, null, 2)}\n\n` +
  `${GROUND_RULE}\n\nReturn the merge groups.`,
  { schema: SYNTH, phase: 'Synthesize', label: 'synthesize' }
)

// Apply the agent's MERGE DECISIONS deterministically. Build a merge map (folded
// id -> surviving id), then let JS do every mechanical graph step: rewriteEdges
// remaps/aggregates dependsOn across merges (dropping self/parallel edges, never
// dropping a slice), and topoSort computes the build order (recovering cycles/
// dangling deps into the ledger). The agent never touches the build graph.
const mergeMap = {}
for (const m of ((synth && synth.merges) || [])) {
  const keep = m && m.keep
  if (!keep) continue
  for (const f of (m.merge || [])) if (f && f !== keep) mergeMap[f] = keep
}
const rewritten = rewriteEdges(slices, mergeMap)
for (const note of rewritten.notes) { log(`🔀 dedup: ${note}`); dropped.push(note) }
const topo = topoSort(rewritten.slices)
for (const note of topo.notes) { log(`⚠️  build-order: ${note}`); dropped.push(note) }

const survivorById = new Map(rewritten.slices.map(s => [s.id, s]))
ordered = topo.order.map((id, i) => ({ ...survivorById.get(id), n: i + 1 }))
if (slices.length !== ordered.length) {
  log(`Synthesis merged ${slices.length - ordered.length} duplicate slice(s); ${ordered.length} canonical slice(s) remain.`)
}

// DEV/TEST cost cap (opt-in, LOUD). Keep only the first N features in build order.
// `ordered` is topologically sorted, so the first N are prerequisites and every
// kept feature's dependencies are also kept — the trimmed kit stays internally
// consistent (INDEX, ACCEPTANCE, and the feature specs below all derive from the
// trimmed `ordered`, so nothing dangles). Applied HERE, before the doc writers, so
// a limited run produces a coherent partial kit, not a complete kit with missing
// files. Off by default (LIMIT_SLICES=0); never silent.
if (LIMIT_SLICES > 0 && ordered.length > LIMIT_SLICES) {
  slicesOmittedForTest = ordered.length - LIMIT_SLICES
  const full = ordered.length
  ordered = ordered.slice(0, LIMIT_SLICES)
  const note = `🧪 TEST LIMIT: writing only ${ordered.length} of ${full} feature(s) (limitSlices=${LIMIT_SLICES}). ` +
    `PARTIAL end-to-end TEST kit — NOT a complete recreation kit; ${slicesOmittedForTest} feature(s) intentionally omitted.`
  log(note); dropped.push(note)
}
  await saveStage('synthesized', { ordered, sysFacts, slicesDiscovered, slicesOmittedForTest })
}

// ===========================================================================
// Stage: Docs — author the system-wide doc family (INDEX, ACCEPTANCE, ARCHITECTURE,
// PRD) from the checkpointed build order. Idempotent overwrites; skipped on a resume
// past this stage.
// ===========================================================================
if (RESUMING && stageDone(savedStage, 'docs')) {
  log('Skipping doc family (checkpointed).')
} else {
  phase('Synthesize')
  const epicTree = buildEpicTree(ordered)

  // Compact per-feature briefs shared by the PRD / ARCHITECTURE / INDEX writers.
  const orderedBrief = ordered.map(s => ({
  n: s.n, id: s.id, name: s.name, epicId: s.epicId, capability: s.capability,
  behaviorSummary: s.behaviorSummary, dependsOn: s.dependsOn || [],
}))

// INDEX writer — transcribes the JS-computed build order + capability tree into
// INDEX.md (the orchestrator sandbox cannot write files; an agent must). The data
// is AUTHORITATIVE: the agent must not reorder or invent.
const indexData = {
  buildOrder: ordered.map(s => ({
    n: s.n, id: s.id, name: s.name, epicId: s.epicId,
    dependsOn: s.dependsOn || [], mergedFrom: s.mergedFrom || [],
  })),
  capabilityTree: epicTree,
}
await agent(
  `You are the PortKit INDEX writer. Write \`${OUT}/INDEX.md\` — the recreation roadmap — from the data below. ` +
  `The build order and capability→feature tree are AUTHORITATIVE (computed deterministically) — do NOT reorder, ` +
  `renumber, or invent.\n\n` +
  `Include:\n` +
  `- A CAPABILITY→FEATURE tree: group by capability in the given order; show each feature as \`#<n> <name>\` with ` +
  `its id and a link to \`specs/<NNNN>-<slug>.md\`.\n` +
  `- The RECOMMENDED BUILD ORDER as a numbered list (#1 first), each entry with id, name, capability, and its ` +
  `dependsOn ids.\n` +
  `- Flag any feature whose mergedFrom is non-empty (it absorbed duplicate features).\n\n` +
  `DATA:\n${JSON.stringify(indexData, null, 2)}`,
  { phase: 'Synthesize', label: 'index' }
)

// ACCEPTANCE writer — the single surface that flags coverage gaps loudly (each
// feature spec's acceptance criteria are drawn from here). Written from the
// extracted behavior data of the SURVIVING (post-merge) features; agent invents nothing.
const behaviorIndex = ordered.map(s => ({
  sliceId: s.id, name: s.name, epicId: s.epicId,
  coverage: (s.behavior && s.behavior.coverage) || 'none',
  acceptanceCriteria: (s.behavior && s.behavior.acceptanceCriteria) || [],
  testRefs: (s.behavior && s.behavior.testRefs) || [],
}))
await agent(
  `You are the PortKit ACCEPTANCE writer. Write \`${OUT}/ACCEPTANCE.md\`: the full extracted acceptance criteria, ` +
  `grouped by capability and mapped to feature id, each with its source test \`path:line\` refs.\n\n` +
  `At the TOP, add a COVERAGE SUMMARY table (feature → good/thin/none) and LOUDLY flag every feature whose coverage ` +
  `is 'thin' or 'none' as a rebuild risk — never paper over missing coverage. Use ONLY the data provided; do not ` +
  `invent criteria.\n\nDATA:\n${JSON.stringify(behaviorIndex, null, 2)}\n\n${GROUND_RULE}`,
  { phase: 'Synthesize', label: 'acceptance' }
)

// ARCHITECTURE writer — the system/tech spec. Absorbs the old system-map + kernel
// glossary + cross-cutting conventions into one doc a weak model reads once and
// every feature spec references (instead of restating).
await agent(
  `You are the PortKit ARCHITECTURE writer. Write \`${OUT}/ARCHITECTURE.md\` — the system/technical spec a weak ` +
  `local model reads ONCE to understand how the pieces fit, then every feature spec references it.\n\n` +
  `Sections (in order):\n` +
  `- Tech stack & build/test: languages, build system, test framework(s), where tests live, dependency manifests.\n` +
  `- Component/module inventory: the internal building blocks and their responsibilities.\n` +
  `- Data model & domain vocabulary: the core types/entities and a naming glossary (shared names features rely on).\n` +
  `- Data flows: for each capability, how a request/event moves through the components.\n` +
  `- Cross-cutting concerns: auth, config, logging, error handling, concurrency — stated as RULES features obey.\n\n` +
  `Source facts: ${sysFacts}\nSource root: \`${SOURCE}\`.\n\nCAPABILITIES:\n${JSON.stringify(epics, null, 2)}\n\n` +
  `FEATURES:\n${JSON.stringify(orderedBrief, null, 2)}\n\n${GROUND_RULE}\n\n${INFER_RULE}\n\nReturn when written.`,
  { phase: 'Synthesize', label: 'arch' }
)

// PRD writer — product requirements RECONSTRUCTED from observed behavior. Intent
// fields (goals/non-goals/metrics/users) are inferred and MUST be tagged; the
// functional requirements are grounded (one per capability, cited).
await agent(
  `You are the PortKit PRD writer. Write \`${OUT}/PRD.md\` — a Product Requirements Document RECONSTRUCTED from ` +
  `the observed behavior of the source (you are reverse-engineering; the source does not state its own intent).\n\n` +
  `Sections (in order):\n` +
  `- Overview / Problem: what the software does and the problem it appears to solve.\n` +
  `- Goals: \`[INFERRED]\` — the outcomes the software seems built to achieve.\n` +
  `- Non-goals: \`[INFERRED]\` — inferred from what it deliberately does NOT do.\n` +
  `- Success metrics: \`[INFERRED]\` — never fabricate numbers; write \`[INFERRED] none observable\` if unclear.\n` +
  `- Users / personas: \`[INFERRED]\` — who the observable interfaces serve.\n` +
  `- Functional requirements: one grounded bullet per capability, each citing \`path:line\`.\n` +
  `- Constraints & assumptions.\n\n` +
  `Source facts: ${sysFacts}\nSource root: \`${SOURCE}\`.\n\nCAPABILITIES:\n${JSON.stringify(epics, null, 2)}\n\n` +
  `FEATURES:\n${JSON.stringify(orderedBrief, null, 2)}\n\n${GROUND_RULE}\n\n${INFER_RULE}\n\nReturn when written.`,
  { phase: 'Synthesize', label: 'prd' }
)
  await saveStage('docs', {})
}

// ===========================================================================
// Stage: ADRs — discover architecturally significant DECISIONS observable in the
// source, then write one MADR-style ADR each. Runs once; on a resume past this
// stage the decisions are reloaded (never re-discovered — ADR ids stay stable).
// ===========================================================================
let decisions
if (RESUMING && stageDone(savedStage, 'adrs')) {
  decisions = checkpoint.adrs || []
  log(`Skipping ADRs (checkpointed): ${decisions.length} decision(s).`)
} else {
  phase('ADRs')
  const adrDisc = await agent(
  `You are the PortKit ADR-DISCOVERY agent. Identify the architecturally SIGNIFICANT DECISIONS the source made ` +
  `that a rebuilder MUST know — e.g. persistence engine, concurrency model, auth scheme, error-handling strategy, ` +
  `protocol/serialization choice, module boundaries, and load-bearing dependency choices.\n\n` +
  `HARD RULES: include a decision ONLY if you can point to observable EVIDENCE (\`path:line\` anchors) that it was ` +
  `made — no evidence, no ADR. Return at most ${MAX_ADRS}, ordered by significance (most load-bearing first). Give ` +
  `each a stable id and a decision-shaped title.\n\n` +
  `Source facts: ${sysFacts}\nSource root: \`${SOURCE}\`.\n\nCAPABILITIES:\n${JSON.stringify(epics, null, 2)}\n\n` +
  `${GROUND_RULE}\n\nReturn the decisions.`,
  { schema: ADRS, phase: 'ADRs', label: 'adr:discover' }
)
  decisions = cap(((adrDisc && adrDisc.decisions) || []).filter(d => d && d.title && Array.isArray(d.evidence) && d.evidence.length),
    MAX_ADRS, 'ADRs')
if (decisions.length) {
  log(`Discovered ${decisions.length} architecturally significant decision(s).`)
  await pooled(decisions.map((d, i) => () => agent(
    `You are the PortKit ADR writer. Write ONE Architecture Decision Record in MADR format to ` +
    `\`${OUT}/adr/${pad(i + 1)}-${slug(d.title)}.md\`.\n\n` +
    `Sections (in order):\n` +
    `- Title: \`${d.title}\`.\n` +
    `- Status: \`Reconstructed\` (this ADR is reverse-engineered, not an original decision record).\n` +
    `- Context & problem statement: the observed situation the decision addresses — cite \`path:line\`.\n` +
    `- Decision drivers.\n` +
    `- Considered options: the chosen option (grounded) and plausible rejected alternatives (\`[INFERRED]\`).\n` +
    `- Decision outcome: what the source actually does — cite the EVIDENCE.\n` +
    `- Consequences.\n` +
    `- Rationale / "why": \`[INFERRED]\` — the source rarely states why; do not present a guess as fact.\n\n` +
    `DECISION DATA:\n${JSON.stringify(d, null, 2)}\nSource root: \`${SOURCE}\`.\n\n${GROUND_RULE}\n\n${INFER_RULE}`,
    { phase: 'ADRs', label: `adr:write:${i + 1}` }
  )))
  } else {
    const note = 'No architecturally significant decisions with observable evidence were found; no ADRs written.'
    log(`ℹ️  ${note}`); dropped.push(note)
  }
  await saveStage('adrs', { adrs: decisions })
}

// ===========================================================================
// Stage: Write specs + critic. Over-scale decision (computed once, then persisted
// so a resume reuses it): if a single run's projected agent count would approach the
// runtime ceiling, partition feature-spec writing into resumable passes.
// runWriteAndFinish advances the `written` checkpoint each pass and CLEARS the
// checkpoint on completion.
// ===========================================================================
let partitioned
if (RESUMING && stageDone(savedStage, 'writing') && typeof checkpoint.partitioned === 'boolean') {
  partitioned = checkpoint.partitioned
} else {
  const projected = projectAgents({
    epicCount: epics.length, sliceCount: ordered.length,
    adrCount: decisions.length, maxAdrs: MAX_ADRS, gapfillRounds: MAX_GAPFILL_ROUNDS,
  })
  partitioned = projected > SAFE_BUDGET
  if (partitioned) {
    const note = `Over-scale: projected ~${projected} agents exceeds the safe budget (${SAFE_BUDGET}); partitioning feature-spec writing into resumable passes. Nothing dropped.`
    log(`⚖️  ${note}`); dropped.push(note)
  }
}
await saveStage('writing', { partitioned, ordered, adrs: decisions, written: checkpoint.written || [] })
return await runWriteAndFinish({
  ordered, adrs: decisions, partitioned, priorWritten: checkpoint.written || [],
  extraCounts: {
    epics: epics.length, slicesDiscovered,
    // Present ONLY on a test-limited run so the partial kit is unmistakable.
    ...(slicesOmittedForTest > 0 ? { testLimited: true, slicesOmittedForTest } : {}),
  },
})
