export const meta = {
  name: 'portkit',
  description: 'Analyze a codebase into a target-neutral, vertical-slice build kit for porting to another language',
  whenToUse: 'Recreating a project in a different language/framework, for a weaker downstream model to rebuild from the docs alone',
  phases: [
    { title: 'Preflight', detail: 'verify the input dir exists; abort loudly if not' },
    { title: 'Map', detail: 'survey the repo; draft the capability/epic inventory' },
    { title: 'Discover slices', detail: 'trace each capability end-to-end; extract behavioral spec from tests' },
    { title: 'Synthesize', detail: 'normalize/dedup slices; build the kernel + index + build order' },
    { title: 'Write slices', detail: 'one self-contained, self-testing vertical-slice doc per unit' },
    { title: 'Target mapping', detail: 'prescriptive per-target dependency map, hazards, slice hints' },
    { title: 'Critic', detail: 'grounding + completeness pass; write RISKS-AND-GAPS.md' },
  ],
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
// args may arrive as an object (from the slash command / a hand call), a JSON
// string, or undefined. Normalize once; parse only when it is a string.
const input = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch { return args } })()
  : (args ?? {})

const cfg = (typeof input === 'object' && input) ? input : {}
// Input dir. Preferred name: inputDir; legacy fallback: sourcePath.
const SOURCE = cfg.inputDir || cfg.sourcePath || '.'
// Single target language/framework (optional; empty = neutral-core-only run).
// Multi-target in one run is intentionally unsupported — reuse the neutral core
// across targets via separate runs pointed at the same outputDir. If an array
// is passed, only the first entry is used.
let TARGET = ''
if (Array.isArray(cfg.target)) {
  const list = cfg.target.map(String).map(s => s.trim()).filter(Boolean)
  TARGET = list[0] || ''
  if (list.length > 1) log(`⚠️  Multiple targets given; using only "${TARGET}" (one target per run).`)
} else if (cfg.target) {
  TARGET = String(cfg.target).trim()
}
// Output dir. Preferred name: outputDir; legacy fallback: outDir. When unset it
// defaults to a SIBLING of the input dir named "<inputDir>_<target>" (e.g.
// /src/mulch -> /src/mulch_go), or "<inputDir>_portkit" when no target is given.
// We deliberately do NOT nest output inside the input dir — that pollutes the
// source tree (it shows up as untracked files in the source's own repo).
// When inputDir is unset SOURCE is ".", which has no sensible sibling, so we
// fall back to "portkit_<target>" in the current working directory.
const OUT = (() => {
  if (cfg.outputDir || cfg.outDir) return cfg.outputDir || cfg.outDir
  const base = SOURCE.replace(/\/+$/, '')
  const suffix = TARGET ? slug(TARGET) : 'portkit'
  if (base === '.' || base === '') return `portkit_${suffix}`
  return `${base}_${suffix}`.replace(/^\.\//, '')
})()

// ---------------------------------------------------------------------------
// Scale guards. The Workflow runtime caps a run at ~1000 agents total and 4096
// items per parallel/pipeline call. A large repo with per-epic + per-slice +
// per-target fan-out can blow that, so we cap each axis and LOG anything we drop
// (silent truncation reads as "complete" when it isn't). Overridable via args.
//
// NOTE: there is deliberately NO cap on total slices. Slices ARE the deliverable —
// dropping them produces an incomplete port plan, which defeats the plugin. Genuine
// over-scale (slice fan-out that would approach the ~1000-agent ceiling) is handled
// by epic-partitioned resumable passes, not by discarding slices.
// ---------------------------------------------------------------------------
const MAX_EPICS = Number(cfg.maxEpics) || 40
const MAX_HINTS_PER_TARGET = Number(cfg.maxHintsPerTarget) || 80
const MAX_GAPFILL_ROUNDS = Number(cfg.maxGapfillRounds) || 2

// Concurrency throttle. The runtime caps in-flight agents at min(16, cores-2),
// but that ceiling is high enough that the per-agent model requests trip API
// rate limits on a busy account. We bound in-flight agents to a gentler limit
// (overridable via args.maxConcurrency) and run every fan-out through pooled()
// instead of letting parallel()/pipeline() saturate the runtime cap.
const MAX_CONCURRENCY = Math.max(1, Number(cfg.maxConcurrency) || 8)

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
// + synthesize + index + behavioral-spec + 1/slice (write) + per-target (deps +
// capped hints) + critic (1 + gapfill rounds). Deliberately an upper-ish estimate;
// the per-gap fixers are unpredictable so they are folded into the gapfill term.
function projectAgents({ epicCount = 0, sliceCount = 0, hasTarget = false, hintCap = 0, gapfillRounds = 0 } = {}) {
  const fixed = 6 // preflight, map, synthesize, index, behavioral-spec, critic(base)
  const discovery = 2 * epicCount
  const writes = sliceCount
  const target = hasTarget ? 1 + Math.min(sliceCount, hintCap) : 0
  return fixed + discovery + writes + target + gapfillRounds
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

// The synth agent now does only what needs an LLM: decide which slices are the
// SAME (merge groups) and the kernel boundary. It no longer computes build order
// or writes INDEX — that is JS-owned (topoSort) + a dedicated writer agent.
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
    wroteKernel: { type: 'boolean' },
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
          kind: { type: 'string', description: 'unresolved-citation | thin-coverage | non-portable-dep | not-self-contained | missing | other' },
          detail: { type: 'string' },
          where: { type: 'string', description: 'doc path or slice id' },
          fixable: { type: 'boolean', description: 'can an agent fix this without human input?' },
        },
      },
    },
    wroteRisksDoc: { type: 'boolean' },
  },
}

// Persisted intermediate representation, reloaded on an over-scale resume. Loose
// item schemas: this is the workflow's own state, not source-derived content.
// `written` carries the build numbers already authored, so progress is tracked
// deterministically in the IR — no fragile filesystem re-scan, no resume that
// can loop forever.
const IR_SCHEMA = {
  type: 'object',
  required: ['ordered'],
  properties: {
    target: { type: 'string' },
    sysFacts: { type: 'string' },
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
// it can reach from the cwd and produce a build kit for the WRONG codebase.
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
// Write / target / critic — factored into helpers so the SAME tail serves the
// normal single-pass run, the first over-scale pass, and every resume pass.
// (Function declarations hoist, so the resume hook below can call them.)
// ===========================================================================
function sliceDocPath(s) { return `${OUT}/epics/${slug(s.epicId)}/${pad(s.n)}-${slug(s.name)}.md` }

// Reserve enough of the agent budget for the final pass's tail (target layer +
// critic + a little overhead) so writing a full batch can never push the LAST
// pass over the cap.
function tailReserve() {
  const target = TARGET ? 1 + MAX_HINTS_PER_TARGET : 0
  const critic = 1 + MAX_GAPFILL_ROUNDS
  return target + critic + 8
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
      `You are the PortKit SLICE-WRITER agent. Write ONE self-contained vertical-slice doc to \`${path}\`.\n\n` +
      `It must let a LESS CAPABLE local model rebuild this slice from this doc + the kernel ALONE, without the ` +
      `source. Include, in this order:\n` +
      `- Title + one-line capability.\n` +
      `- The end-to-end behavior thread (each component with its source \`path:line\`).\n` +
      `- Interface/contract: inputs, outputs, and EXACT behavior — every error, edge case, and ordering guarantee.\n` +
      `- Prerequisite slices (build order: this is #${s.n}; dependsOn ${JSON.stringify(s.dependsOn || [])}).\n` +
      `- Acceptance tests for THIS slice (from the behavioral spec; concrete and runnable-in-spirit).\n` +
      `- Function/unit-sized build steps, each individually checkable.\n` +
      `- Kernel references (names/types/conventions it relies on) — reference the kernel, do NOT restate it, and do ` +
      `NOT depend on any other slice's internals.\n\n` +
      `Re-read the cited source as needed to be exact. Source root: \`${SOURCE}\`.\n\n` +
      `SLICE DATA:\n${JSON.stringify(ctx, null, 2)}\n\n${GROUND_RULE}\n\n` +
      `After writing, return the path, whether it is genuinely self-contained, and any issues.`,
      { schema: WROTE, phase: 'Write slices', label: `slice:${s.n}:${slug(s.name)}` }
    )
  }))
  return written
}

async function writeTargetLayer(ordered, sysFacts) {
  if (!TARGET) return
  phase('Target mapping')
  const dir = `${OUT}/targets/${slug(TARGET)}`
  const orderedBrief = ordered.map(s => ({ id: s.id, name: s.name, epicId: s.epicId, n: s.n, capability: s.capability }))
  await agent(
    `You are the PortKit TARGET-MAPPING agent for target: ${TARGET}.\n\n` +
    `Write TWO docs (prescriptive, exact — the consumer is a weak model):\n` +
    `1. \`${dir}/dependency-map.md\` — for EACH source dependency, give the concrete strategy: target equivalent ` +
    `(name the exact library) / reimplement / drop / HUMAN-DECISION-REQUIRED. Never silently guess a non-obvious ` +
    `mapping — flag it for a human.\n` +
    `2. \`${dir}/porting-hazards.md\` — source-language assumptions that break in ${TARGET} (e.g. GIL, duck typing, ` +
    `GC, memory model, numeric precision, evaluation/ordering) and how to handle each.\n\n` +
    `Source facts: ${sysFacts}\nSource root: \`${SOURCE}\`.\n\n${GROUND_RULE}\n\nReturn when written.`,
    { phase: 'Target mapping', label: `target:${slug(TARGET)}:deps` }
  )
  const hintSlices = cap(orderedBrief, MAX_HINTS_PER_TARGET, `${TARGET} slice-hints`)
  await pooled(hintSlices.map((s) => () => agent(
    `You are the PortKit SLICE-HINT agent for target ${TARGET}, slice "${s.name}" (#${s.n}).\n\n` +
    `Read the neutral slice doc at \`${OUT}/epics/${slug(s.epicId)}/${pad(s.n)}-${slug(s.name)}.md\` and write ` +
    `\`${dir}/slice-hints/${pad(s.n)}.md\`: PRESCRIPTIVE ${TARGET} guidance for THIS slice — exact library/API, ` +
    `function signatures, and idioms to use. No prose alternatives; pick one and specify it.\n\n${GROUND_RULE}`,
    { phase: 'Target mapping', label: `hint:${slug(TARGET)}:${s.n}` }
  )))
}

async function runCritic() {
  phase('Critic')
  function criticPrompt(round, prior) {
    return `You are the PortKit CRITIC. Audit the generated build kit under \`${OUT}\` for whether a LESS CAPABLE ` +
      `local model could rebuild the project from it ALONE.\n\nCheck for:\n` +
      `- Unresolved/uncheckable \`path:line\` citations (sample and verify against \`${SOURCE}\`).\n` +
      `- Thin/missing test coverage not flagged.\n` +
      `- Non-portable deps left as silent guesses (should be HUMAN-DECISION-REQUIRED).\n` +
      `- Slices that are NOT actually self-contained or not end-to-end testable.\n` +
      `- Missing pieces (a capability with no slices, a dangling dependsOn, a slice with no acceptance tests).\n\n` +
      (prior ? `Previously reported gaps that fix agents attempted:\n${prior}\n\n` : '') +
      `Append findings to \`${OUT}/RISKS-AND-GAPS.md\` (create if absent; this is round ${round}). ` +
      `Mark each gap fixable=true only if an agent could resolve it WITHOUT human input.\n\n${GROUND_RULE}\n\nReturn the gaps.`
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
      `build kit). Read the source at \`${SOURCE}\` as needed, but you MUST NOT create, modify, or delete ANY file ` +
      `outside \`${OUT}\` — never touch the source tree. If the gap is thin/missing coverage in the SOURCE's own ` +
      `tests, do NOT add tests to the source; instead flag it clearly in \`${OUT}/05-behavioral-spec.md\` and ` +
      `\`${OUT}/RISKS-AND-GAPS.md\`.\n\nGAP: ${JSON.stringify(g)}\n\n${GROUND_RULE}`,
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

// IR persistence (over-scale only). The orchestrator sandbox has no filesystem,
// so an agent writes/reads the JSON. The persist agent must write the fenced bytes
// verbatim; the load agent returns the parsed object.
async function persistIR(ir) {
  await agent(
    `You are the PortKit IR-PERSIST agent. Create the directory if needed and write the JSON between the fences ` +
    `below — VERBATIM, exactly those bytes and nothing else — to \`${IR_PATH}\`. Do not reformat, summarize, or ` +
    `add commentary. This is the workflow's resumable state.\n\n${IR_OPEN}\n${JSON.stringify(ir)}\n${IR_CLOSE}\n`,
    { phase: 'Write slices', label: 'ir:persist' }
  )
}
async function loadIR() {
  return await agent(
    `You are the PortKit IR-LOAD agent. Read the JSON file at \`${IR_PATH}\` and return its parsed contents ` +
    `EXACTLY as structured data (do not invent or alter fields). If the file does not exist or is empty, return ` +
    `an object whose \`ordered\` is an empty array.`,
    { schema: IR_SCHEMA, phase: 'Resume', label: 'ir:load' }
  )
}

// Shared tail. Writes the next un-written batch of slice docs; if any remain it
// persists progress and returns resumeRequired; otherwise it runs the target
// layer + critic and returns the final result. `partitioned` engages over-scale
// batching (off for a normal run, so behavior there is byte-for-byte unchanged).
async function runWriteAndFinish({ ordered, sysFacts, partitioned, priorWritten = [], extraCounts = {} }) {
  phase('Write slices')
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
  // Mark only slices that actually wrote OK as done; failures stay pending and are
  // retried on the next pass (so a flaky write is never silently lost).
  const okThisPass = thisPass.filter((s, i) => docs[i] && docs[i].ok)
  okThisPass.forEach(s => writtenNs.add(s.n))
  const remaining = ordered.filter(s => !writtenNs.has(s.n)).length
  log(`Wrote ${okThisPass.length}/${thisPass.length} slice doc(s)` +
    (partitioned ? ` — ${writtenNs.size}/${ordered.length} done, ${remaining} remaining` : ''))

  if (partitioned) {
    await persistIR({ ordered, sysFacts, target: TARGET, written: [...writtenNs] })
    // Progress guard: a pass that writes nothing new but still has work left would
    // loop forever on resume. Stop loudly instead.
    if (okThisPass.length === 0 && remaining > 0) {
      const err = `Over-scale resume made no progress: all ${thisPass.length} write(s) this pass failed, ${remaining} slice(s) still pending.`
      log(`❌ ${err}`); dropped.push(err)
      return { ok: false, error: err, outDir: OUT, resumeRequired: true, truncations: dropped }
    }
  }

  if (remaining > 0) {
    const note = `Over-scale: ${remaining} slice(s) remain after this pass — re-run with { resume: true } pointed at outputDir "${OUT}" to continue (no slices dropped).`
    log(`⏸️  ${note}`); dropped.push(note)
    return {
      ok: true, outDir: OUT, target: TARGET || null, resumeRequired: true,
      resumeArgs: { resume: true, outputDir: OUT, ...(TARGET ? { target: TARGET } : {}) },
      counts: { slicesPlanned: ordered.length, slicesWritten: writtenNs.size, slicesRemaining: remaining, ...extraCounts },
      truncations: dropped,
    }
  }

  await writeTargetLayer(ordered, sysFacts)
  const gaps = await runCritic()
  return {
    ok: true, outDir: OUT, target: TARGET || null, resumeRequired: false,
    counts: {
      slicesPlanned: ordered.length,
      slicesWritten: writtenNs.size,
      gapsRemaining: gaps.length,
      gapsRemainingHumanDecision: gaps.filter(g => !g.fixable).length,
      ...extraCounts,
    },
    truncations: dropped,
    keyDocs: {
      systemMap: `${OUT}/00-system-map.md`,
      kernel: `${OUT}/KERNEL.md`,
      crossCutting: `${OUT}/kernel/cross-cutting.md`,
      behavioralSpec: `${OUT}/05-behavioral-spec.md`,
      index: `${OUT}/epics/INDEX.md`,
      risks: `${OUT}/RISKS-AND-GAPS.md`,
    },
    remainingGaps: gaps,
  }
}

// ===========================================================================
// Resume entry (over-scale only). Taken ONLY when args.resume is set — i.e. a
// prior over-scale pass asked to continue. Skips map/discover/synthesize/index
// entirely (those ran once on pass 1) and writes the next batch from the IR.
// ===========================================================================
if (cfg.resume) {
  phase('Resume')
  const ir = await loadIR()
  if (!ir || !Array.isArray(ir.ordered) || ir.ordered.length === 0) {
    return {
      ok: false,
      error: `Resume requested but no usable IR was found at \`${IR_PATH}\`. Run PortKit normally first; resume only continues an over-scale run.`,
      outDir: OUT,
    }
  }
  TARGET = typeof ir.target === 'string' ? ir.target : TARGET
  log(`Resuming over-scale run: loaded IR with ${ir.ordered.length} slice(s); ${(ir.written || []).length} already written.`)
  return await runWriteAndFinish({
    ordered: ir.ordered, sysFacts: ir.sysFacts || '{}',
    partitioned: true, priorWritten: ir.written || [],
  })
}

// ===========================================================================
// Phase 0 — Map
// ===========================================================================
phase('Map')
const map = await agent(
  `You are the PortKit MAP agent. Survey the source codebase rooted at \`${SOURCE}\`. ` +
  `This path has been preflight-verified to exist. If at any point it appears empty or unreadable, STOP and ` +
  `report it — do NOT survey any other directory or substitute a different path.\n\n` +
  `Tasks:\n` +
  `1. Identify languages, build system, test framework(s) and where tests live, and the dependency manifest file(s).\n` +
  `2. Discover the CAPABILITIES of the system as a DRAFT EPIC INVENTORY — coarse, user/externally-observable ` +
  `behaviors (HTTP endpoints, CLI commands, public API operations, event/message handlers, scheduled jobs, UI flows). ` +
  `These are VERTICAL threads, NOT horizontal layers. Do NOT list "the models" or "the controllers" — list what the ` +
  `system DOES. Give each a stable id, a name, a kind, and entry-point \`path:line\` anchors.\n` +
  `3. Write a concise orientation doc to \`${OUT}/00-system-map.md\` (languages, build, test setup, dependency ` +
  `manifests, and the epic list). Create directories as needed.\n\n` +
  `${GROUND_RULE}\n\nReturn the structured inventory.`,
  { schema: SYSTEM_MAP, phase: 'Map', label: 'map:survey' }
)

if (!map || !Array.isArray(map.epics) || map.epics.length === 0) {
  return {
    ok: false,
    error: 'Map phase produced no epics — cannot build a vertical-slice IR.',
    outDir: OUT,
  }
}

const sysFacts = JSON.stringify({
  languages: map.languages, buildSystem: map.buildSystem,
  testFrameworks: map.testFrameworks, testPaths: map.testPaths,
  dependencyManifests: map.dependencyManifests,
}, null, 2)

const epics = cap(map.epics, MAX_EPICS, 'epics')
log(`Mapped ${map.epics.length} epics; analyzing ${epics.length}.`)

// ===========================================================================
// Phase 1 — Slice discovery (+ behavioral spec), per epic, concurrency-bounded.
// Each epic flows independently: discover its vertical slices, then extract the
// behavioral acceptance spec from the test suite for those slices. The two
// stages run sequentially WITHIN an epic; across epics, pooled() keeps at most
// MAX_CONCURRENCY epics in flight so we never flood the API (was pipeline(),
// which let the runtime cap — min(16, cores-2) — saturate and trip rate limits).
// ===========================================================================
phase('Discover slices')
const perEpic = await pooled(epics.map((epic) => async () => {
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
  const prev = r ? { epic, slices: r.slices || [] } : null
  if (!prev || prev.slices.length === 0) return prev
  const ids = prev.slices.map(s => ({ id: s.id, name: s.name, capability: s.capability }))
  const b = await agent(
    `You are the PortKit BEHAVIOR-SPEC agent. The source's existing tests are the behavioral contract.\n\n` +
    `Source root: \`${SOURCE}\`. Test setup: ${sysFacts}\n\n` +
    `For each slice below, find the source tests that exercise it and translate them into LANGUAGE-NEUTRAL ` +
    `acceptance criteria (concrete enough that a weak model can self-check its rebuild). Cite each source test ` +
    `as \`path:line\`. Rate coverage good/thin/none. FLAG thin/none LOUDLY — never paper over missing coverage.\n\n` +
    `SLICES:\n${JSON.stringify(ids, null, 2)}\n\n${GROUND_RULE}\n\nReturn perSlice behavioral specs.`,
    { schema: BEHAVIOR, phase: 'Discover slices', label: `behavior:${prev.epic.id}` }
  )
  return { ...prev, behavior: (b && b.perSlice) || [] }
}))

// Flatten into a single slice list, attaching behavior and epic id.
const allSlices = []
for (const e of perEpic.filter(Boolean)) {
  const behaviorById = new Map((e.behavior || []).map(b => [b.sliceId, b]))
  for (const s of e.slices) {
    allSlices.push({ ...s, epicId: e.epic.id, behavior: behaviorById.get(s.id) || null })
  }
}
if (allSlices.length === 0) {
  return { ok: false, error: 'No vertical slices were discovered.', outDir: OUT }
}
// Every discovered slice is carried — NEVER truncated (see the scale-guard note).
const slices = allSlices
log(`Discovered ${slices.length} slices across ${perEpic.filter(Boolean).length} epics.`)

// ===========================================================================
// Phase 2 — Synthesize. The LLM does only the two jobs that need judgment:
// (1) DEDUP — decide which slices are the same thread (merge groups), and
// (2) the kernel/slice boundary (+ write the kernel docs). The error-prone
// mechanical work — remapping edges across merges (rewriteEdges) and the
// topological build order (topoSort) — is JS-owned and unit-tested, so feeding
// the agent ALL slices no longer makes it the bottleneck/single point of failure.
// The payload is compact: NO `thread` (the heavy field) and NO dependsOn (the
// graph is JS-owned), so this scales to hundreds of slices in one agent call.
// ===========================================================================
phase('Synthesize')
const synthInput = slices.map(s => ({
  id: s.id, name: s.name, epicId: s.epicId, capability: s.capability,
  behaviorSummary: s.behaviorSummary,
}))
const synth = await agent(
  `You are the PortKit SYNTHESIS agent. You receive ALL discovered vertical slices in compact form.\n\n` +
  `Do TWO things:\n` +
  `1. DEDUP: identify sets of slices that are truly the SAME vertical thread discovered from different ` +
  `epics/angles. For each set return a merge group { keep, merge: [ids…] } — \`keep\` is the surviving canonical ` +
  `slice id, \`merge\` lists the OTHER ids folded into it. Only merge GENUINE duplicates; when in doubt do NOT ` +
  `merge (a wrongly-merged slice silently loses real behavior). Return an empty list if nothing merges. Do NOT ` +
  `compute a build order and do NOT renumber — ordering is handled deterministically downstream.\n` +
  `2. KERNEL BOUNDARY: shared naming, types, domain vocabulary, and cross-cutting CONVENTIONS (auth, config, ` +
  `logging, error handling, concurrency) are HOISTED into a thin shared kernel that slices reference; everything ` +
  `else stays inside its slice so each slice is self-contained for a weak model. WRITE \`${OUT}/KERNEL.md\` ` +
  `(naming/type glossary + domain vocabulary) and \`${OUT}/kernel/cross-cutting.md\` (conventions stated as rules ` +
  `slices obey, not a layer to build). Set wroteKernel=true when done.\n\n` +
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
const ordered = topo.order.map((id, i) => ({ ...survivorById.get(id), n: i + 1 }))
if (slices.length !== ordered.length) {
  log(`Synthesis merged ${slices.length - ordered.length} duplicate slice(s); ${ordered.length} canonical slice(s) remain.`)
}
const epicTree = buildEpicTree(ordered)

// INDEX writer — transcribes the JS-computed build order + epic tree into
// epics/INDEX.md (the orchestrator sandbox cannot write files; an agent must).
// The data is AUTHORITATIVE: the agent must not reorder or invent.
const indexData = {
  buildOrder: ordered.map(s => ({
    n: s.n, id: s.id, name: s.name, epicId: s.epicId,
    dependsOn: s.dependsOn || [], mergedFrom: s.mergedFrom || [],
  })),
  epicTree,
}
await agent(
  `You are the PortKit INDEX writer. Write \`${OUT}/epics/INDEX.md\` from the data below. The build order and ` +
  `epic→slice tree are AUTHORITATIVE (computed deterministically) — do NOT reorder, renumber, or invent.\n\n` +
  `Include:\n` +
  `- An EPIC→SLICE tree: group by epic in the given order; show each slice as \`#<n> <name>\` with its id.\n` +
  `- The TOPOLOGICAL BUILD ORDER as a numbered list (#1 first), each entry with id, name, epic, and its ` +
  `dependsOn ids.\n` +
  `- Flag any slice whose mergedFrom is non-empty (it absorbed duplicate slices).\n\n` +
  `DATA:\n${JSON.stringify(indexData, null, 2)}`,
  { phase: 'Synthesize', label: 'index' }
)

// Consolidated behavioral spec — the single surface that flags coverage gaps
// loudly (the per-slice tests are drawn from here). Written from the extracted
// behavior data of the SURVIVING (post-merge) slices; agent invents nothing.
const behaviorIndex = ordered.map(s => ({
  sliceId: s.id, name: s.name, epicId: s.epicId,
  coverage: (s.behavior && s.behavior.coverage) || 'none',
  acceptanceCriteria: (s.behavior && s.behavior.acceptanceCriteria) || [],
  testRefs: (s.behavior && s.behavior.testRefs) || [],
}))
await agent(
  `You are the PortKit BEHAVIORAL-SPEC writer. Write \`${OUT}/05-behavioral-spec.md\`: the full extracted ` +
  `acceptance criteria, grouped by epic and mapped to slice id, each with its source test \`path:line\` refs.\n\n` +
  `At the TOP, add a COVERAGE SUMMARY table (slice → good/thin/none) and LOUDLY flag every slice whose coverage ` +
  `is 'thin' or 'none' as a rebuild risk — never paper over missing coverage. Use ONLY the data provided; do not ` +
  `invent criteria.\n\nDATA:\n${JSON.stringify(behaviorIndex, null, 2)}\n\n${GROUND_RULE}`,
  { phase: 'Synthesize', label: 'behavioral-spec' }
)

// ===========================================================================
// Phases 3–5 — Write slices, target layer, critic. Over-scale decision: if a
// single full run's projected agent count would approach the runtime ceiling,
// persist the IR and partition slice-writing into resumable passes. Otherwise
// (the common case) write everything in one pass — behavior unchanged.
// ===========================================================================
const projected = projectAgents({
  epicCount: epics.length, sliceCount: ordered.length,
  hasTarget: !!TARGET, hintCap: MAX_HINTS_PER_TARGET, gapfillRounds: MAX_GAPFILL_ROUNDS,
})
const overBudget = projected > SAFE_BUDGET
if (overBudget) {
  const note = `Over-scale: projected ~${projected} agents exceeds the safe budget (${SAFE_BUDGET}); partitioning slice-writing into resumable passes. No slices dropped.`
  log(`⚖️  ${note}`); dropped.push(note)
  await persistIR({ ordered, sysFacts, target: TARGET, written: [] })
}
return await runWriteAndFinish({
  ordered, sysFacts, partitioned: overBudget, priorWritten: [],
  extraCounts: { epics: epics.length, slicesDiscovered: allSlices.length },
})
