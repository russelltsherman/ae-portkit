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
    { title: 'Distill', detail: 'opt-in: emit a citation-free distilled/ mirror for the weaker rebuilder' },
  ],
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
// args may arrive as a structured object (from the slash command / a hand call),
// a JSON string, a raw CLI string forwarded by the skill/command bridge (e.g.
// "--input /src/myapp" or just "/src/myapp"), or undefined. parseArgs()
// (deterministic region) normalizes all of them to a config object — crucially
// recovering inputDir from the CLI-string form so the run never silently drifts
// to the cwd. This is a STACK-NEUTRAL recreation kit: there is no target language.
const cfg = parseArgs(args)
// Input dir. Preferred name: inputDir; legacy fallback: sourcePath.
const SOURCE = cfg.inputDir || cfg.sourcePath || '.'
// Output dir. Preferred name: outputDir; legacy fallback: outDir. When unset it
// defaults to a SIBLING of the input dir named "<inputDir>_portkit" (e.g.
// /src/myapp -> /src/myapp_portkit). We deliberately do NOT nest output inside
// the input dir — that pollutes the source tree (it shows up as untracked files
// in the source's own repo). When inputDir is unset SOURCE is "." (the cwd); we
// resolve the cwd's OWN directory name and suffix that, so analyzing a project
// dir named "portkit" defaults to "portkit_portkit". If the runtime does not
// expose the cwd, fall back to the literal "portkit_portkit".
const OUT = (() => {
  if (cfg.outputDir || cfg.outDir) return cfg.outputDir || cfg.outDir
  const base = SOURCE.replace(/\/+$/, '')
  if (base === '.' || base === '') {
    let cwdName = ''
    try { cwdName = String(process.cwd()).replace(/\/+$/, '').split('/').pop() || '' } catch { /* no cwd access */ }
    return `${cwdName || 'portkit'}_portkit`
  }
  return `${base}_portkit`.replace(/^\.\//, '')
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

// FRESH run: ignore any checkpoint AND regenerate the kit from scratch. The doc/spec/ADR writers
// normally SKIP an existing non-empty output (so a resume never re-authors it); on a fresh run they
// must OVERWRITE instead, otherwise a re-run over a prior (e.g. smaller/aborted) kit keeps the stale
// docs and yields a Frankenstein. rewriteClause injects the right instruction into each writer.
// DISTILL (opt-in): after the critic validates the kit, emit a CLEAN mirror under <OUT>/distilled/
// with the verified `path:line` source citations stripped — the receipts help the generator/critic
// and a human auditor, but a weaker rebuilder cannot open them and is only confused (or led to
// hallucinate) by them. `[INFERRED]`/`[UNVERIFIED]` flags and artifact paths (no line number) are
// kept. The cited originals stay at the top level as the grounding/audit copy.
const DISTILL = !!cfg.distill

// Phase ceiling (per-phase commands: /portkit-map, /portkit-adrs, …). When set to a
// ladder stage name, the run advances to that stage, persists the checkpoint, and
// PAUSES (returns { paused: true }) instead of continuing — so each phase command can
// stop at its own boundary and the next command resumes from the durable checkpoint.
// Unset (the /portkit full run) => null => never pauses => byte-identical to today.
// Validated leniently by stopAfter(): an unknown value never pauses (runs to the end).
const UNTIL = cfg.until != null ? String(cfg.until) : null

const FRESH = !!cfg.fresh
const rewriteClause = (path) => FRESH
  ? `This is a FRESH run: if \`${path}\` already exists, OVERWRITE it with the newly generated content — do NOT preserve, keep, or early-return stale content.`
  : `FIRST: if \`${path}\` already exists and is non-empty, a prior pass wrote it — do NOT rewrite it; return immediately (its durable output stands).`

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

// Token/subscription-window guard. Separate axis from the agent-count guard above: a run
// voluntarily YIELDS (persists checkpoint, returns resumeRequired) when its actual token spend
// this turn nears the effective ceiling, so a very large project is processed as resumable chunks
// that each fit within a subscription window. The effective ceiling has precedence:
//   1. runtime `budget.total` (the user's "+Nk" directive), else
//   2. `maxTokensPerRun` arg, else
//   3. Infinity (unset ⇒ unlimited ⇒ byte-identical to today: no yield ever fires).
// `tokenReserve` is left unspent for the tail (critic/gapfill) and matches the critic's 50k reserve.
const MAX_TOKENS_PER_RUN = Math.max(0, Number(cfg.maxTokensPerRun) || 0)
// Guard the falsy-zero trap: `Number(x) || 50_000` would turn an explicit reserve of 0 into 50_000.
const TOKEN_RESERVE = (cfg.tokenReserve == null) ? 50_000 : Math.max(0, Number(cfg.tokenReserve) || 0)
const IR_PATH = `${OUT}/.portkit/ir.json`
// The checkpoint (ir.json) holds ONLY small, low-entropy state — stage, source,
// capability summaries, and LIGHT per-slice metadata (id/name/deps/one-line summary).
// The bulky, high-entropy analysis (each slice's component thread + extracted
// behavioral acceptance criteria) is NOT in the checkpoint: the discovery agents that
// GENERATE it write it to per-capability side-car files under EPICS_DIR, and the
// write/ACCEPTANCE agents read it back from there. This is deliberate: a model turn
// stalls when forced to REPRODUCE a large exact blob (measured: a ~4KB checkpoint
// persists fine, a ~200KB one hangs the request), but GENERATING content to a file
// works (the doc writers do it). Keeping ir.json small makes persist/load reliable;
// keeping the heavy data in generator-written side-cars keeps it off the model's
// reproduction path entirely.
const IR_OPEN = '<<<PORTKIT-IR-JSON>>>'
const IR_CLOSE = '<<<END-PORTKIT-IR-JSON>>>'
// Per-capability side-car files (heavy analysis), written by the discovery agents
// that generate them and read by the write/ACCEPTANCE agents. Survive across a
// resume (only clearIR, on success, removes them).
const EPICS_DIR = `${OUT}/.portkit/epics`

const dropped = [] // truncation ledger, surfaced in the final result + RISKS doc
function cap(list, max, what) {
  if (list.length <= max) return list
  const kept = list.slice(0, max)
  const note = `Capped ${what}: kept ${max} of ${list.length} (dropped ${list.length - max}).`
  log(`⚠️  ${note}`)
  dropped.push(note)
  return kept
}

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

// slug — filesystem-safe kebab-case, TRUNCATED to 48 chars. pad — zero-pad a build
// number to 4 digits. These live INSIDE the fence because specName() below depends on
// them and specName is the single source of truth for a feature spec's filename.
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'slice'
}
function pad(n) { return String(n).padStart(4, '0') }

// specName — the EXACT basename of a feature spec file: `<NNNN>-<slug>.md`. This is
// the SINGLE SOURCE OF TRUTH for the filename. Both sliceDocPath() (which WRITES the
// file) and the INDEX writer's link target derive from it, so an INDEX link can never
// disagree with the file on disk. The 48-char cap in slug() truncates the name part,
// so a long feature name yields e.g. `0001-...-config-constan.md` — the link MUST use
// this same truncated basename, never a re-slugified full name (that was the dangling-
// link bug: the INDEX agent recomputed a slug without the cap).
function specName(n, name) { return `${pad(n)}-${slug(name)}.md` }

// parseArgs — normalize the workflow's `args` input into a plain config object,
// no matter how it arrives. The slash command is SUPPOSED to hand us a structured
// object ({ inputDir, outputDir }), but when the workflow is launched via the
// skill/command bridge the RAW argument string is forwarded verbatim instead
// (e.g. "--input /src/myapp" or just "/src/myapp"). Before this helper that string
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
// 'critiqued' and 'distilled' are the terminal stages (Critic + the opt-in Distill
// mirror), promoted to first-class ladder stages so the per-phase commands can stop
// after each. stageList() is the single source of truth for the order; stageIndex()
// and stageAfter() both derive from it (keeping the array in one place).
function stageList() {
  return ['mapped', 'discovering', 'discovered', 'synthesized', 'docs', 'adrs', 'writing', 'critiqued', 'distilled']
}
function stageIndex(stage) {
  return stageList().indexOf(stage)
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
// stopAfter — PURE. Should the run PAUSE after completing `stage`? True iff a phase
// ceiling `until` is set and `stage` is at or beyond it. `until` null/undefined (no
// ceiling) => never pauses => a full run, byte-identical to today. An unknown `until`
// (not on the ladder) => stageIndex(until) is -1 => never pauses (fail-open to a full
// run: a mistyped ceiling produces a complete kit rather than silently stopping early).
function stopAfter(stage, until) {
  if (until == null) return false
  const u = stageIndex(until)
  if (u < 0) return false
  const c = stageIndex(stage)
  return c >= 0 && c >= u
}
// stageAfter — PURE. The ladder stage following `stage`, or null if `stage` is the last
// (or unknown). Used only to tell the user which phase comes next when a run pauses.
function stageAfter(stage) {
  const l = stageList()
  const i = l.indexOf(stage)
  return (i >= 0 && i + 1 < l.length) ? l[i + 1] : null
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

// budgetExhausted — PURE. Decide whether the run should VOLUNTARILY YIELD now to fit a
// token/subscription window. Takes plain numbers (NEVER the injected `budget` object — the
// purity gate bans that token): the effective per-run token ceiling (`total`), tokens already
// spent this turn (`spent`), and a `reserve` to leave for the tail (critic/gapfill). Returns
// true iff a ceiling is in effect AND the remaining budget has fallen to the reserve.
// An unlimited ceiling (total null/undefined/0/negative/non-finite) is NEVER exhausted, so with
// no budget set every caller short-circuits and behavior is byte-identical to today.
function budgetExhausted(total, spent, reserve) {
  if (!(total > 0) || !isFinite(total)) return false // unlimited (unset/0/negative/non-finite) ⇒ never yields
  return (total - (spent || 0)) <= (reserve || 0)
}

// findSourceCitations — PURE. Return every SOURCE CITATION in `text`: a reference to the analyzed
// source of the form `<path>.<ext>:<line>` (optionally backtick-wrapped, with an optional `-range`
// and `,list`), e.g. `src/utils/config.ts:191-193`, `config.ts:308`, `src/cli.ts:110`. These are
// the anti-hallucination receipts the generator/critic use — but a WEAKER rebuilder cannot open
// them, so the distill pass strips them from the consumer-facing kit. This is the single, tested
// definition of "a citation" that both the distiller's prompt and its verify step rely on.
// It deliberately does NOT match:
//   - a path with NO line number (e.g. `.config/settings.yaml`) — a real artifact the rebuild produces
//   - `[INFERRED]` / `[UNVERIFIED]` tags — those carry real meaning and are KEPT
//   - bare ratios/times like `10:30` — no file extension precedes the colon
function findSourceCitations(text) {
  const PATH = '(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.[A-Za-z][A-Za-z0-9]{0,5}'
  const LINES = '\\d+(?:[\\u2013-]\\d+)?(?:,\\s?\\d+(?:[\\u2013-]\\d+)?)*'
  const re = new RegExp('`?' + PATH + ':' + LINES + '`?', 'g')
  return String(text).match(re) || []
}

// planResume — PURE. Decide, from the per-capability side-car scan, what each capability
// needs on RESUME. The analyzed source is STATIC, so its slice decomposition is a FIXED
// target: a capability's slice STRUCTURE (light.json) is a deterministic function of the
// source and, once written, DURABLE — it must be RELOADED, never re-discovered. Re-running
// discovery would produce a different slice set and RENUMBER every downstream spec, turning
// a resume into a duplicate rewrite (the exact bug this guards against). behavior.json is a
// DOWNSTREAM artifact (test-derived acceptance criteria); when it ALONE is missing we re-run
// ONLY the behavior agent against the reloaded slices — structure and numbering untouched.
// Returns { reload, behaviorOnly, discover } as epic-id arrays in `epics` order:
//   - reload:       has light.json                  -> reload slices (structure is fixed)
//   - behaviorOnly: reload ∩ missing behavior.json  -> behavior re-run only (no re-discovery)
//   - discover:     no light.json                   -> full discovery (never analyzed yet)
function planResume(epics, scan) {
  const byId = new Map((scan || []).map(e => [e && e.id, e]))
  const reload = [], behaviorOnly = [], discover = []
  for (const e of (epics || [])) {
    const s = byId.get(e.id)
    if (s && s.hasLight) {
      reload.push(e.id)
      if (!s.hasBehavior) behaviorOnly.push(e.id)
    } else {
      discover.push(e.id)
    }
  }
  return { reload, behaviorOnly, discover }
}

// omissionScopeNote — PURE. A DEV/TEST run can intentionally omit work: `limitSlices` writes only
// the first N feature specs (in build order), and `maxEpics` analyzes only the first M capabilities.
// Those omissions are BY DESIGN and are reported LOUDLY as a PARTIAL test kit — they are NOT defects.
// This builds the scope caveat prepended to the critic + gap-fix prompts so the gap-fill loop never
// "repairs" a deliberate truncation by regenerating the omitted specs (or reverse-engineering a
// dropped capability straight from source) — which would silently convert a partial test kit into a
// claimed-complete one, contradicting the run's own testLimited/slicesOmittedForTest report. Returns
// '' when NOTHING was intentionally omitted, so a full/unlimited run's prompts stay byte-identical.
function omissionScopeNote({ slicesOmittedForTest = 0, limitSlices = 0, epicsKept = 0, epicsTotal = 0 } = {}) {
  const parts = []
  if (slicesOmittedForTest > 0) {
    parts.push(`${slicesOmittedForTest} feature spec(s) were INTENTIONALLY omitted (limitSlices=${limitSlices}: only the first ${limitSlices} feature(s) in build order were written)`)
  }
  if (epicsTotal > epicsKept) {
    parts.push(`${epicsTotal - epicsKept} capability(ies) were INTENTIONALLY dropped (maxEpics cap: only ${epicsKept} of ${epicsTotal} discovered capability(ies) were analyzed)`)
  }
  if (parts.length === 0) return ''
  return `INTENTIONAL TEST-SCOPE LIMITS — READ THIS FIRST: this is a deliberately PARTIAL test kit, NOT a complete recreation kit. ` +
    `${parts.join('; ')}. These omissions are BY DESIGN, not defects. Audit ONLY the features and capabilities actually present in the kit. ` +
    `Do NOT report an intentionally-omitted feature or capability as a "missing piece" or gap, do NOT mark such a gap fixable, and do NOT ` +
    `(and any fix agent MUST NOT) regenerate, back-fill, or reverse-engineer the omitted feature specs or capabilities. A dependsOn that ` +
    `points at an intentionally-omitted feature is expected and MUST NOT be flagged. Editing INDEX/ACCEPTANCE to claim the full feature ` +
    `set is present is FORBIDDEN — the partial scope must remain accurately reported.`
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
    stage: { type: 'string', description: 'mapped | discovering | discovered | synthesized | docs | adrs | writing | critiqued | distilled' },
    source: { type: 'string', description: 'the inputDir this checkpoint belongs to (fingerprint for auto-resume)' },
    fileCount: { type: 'number' },
    partitioned: { type: 'boolean', description: 'was over-scale write partitioning engaged?' },
    sysFacts: { type: 'string' },
    fresh: {},
    epics: { type: 'array', items: {}, description: 'the mapped capability inventory (after the maxEpics cap)' },
    epicsTotal: { type: 'number', description: 'capabilities discovered BEFORE the maxEpics cap — lets the critic report an intentional maxEpics drop as out-of-scope on resume' },
    epicsDone: { type: 'array', items: { type: 'string' }, description: 'ids of capabilities whose discovery finished (slice data lives in side-cars, not here)' },
    merges: { type: 'array', items: {}, description: 'dedup merge groups (the build order is recomputed from these + the light slices)' },
    adrs: { type: 'array', items: {}, description: 'discovered decisions (authored once)' },
    slicesDiscovered: { type: 'number' },
    slicesOmittedForTest: { type: 'number' },
    scale: { type: 'object', description: 'the run\'s scale knobs {maxEpics, limitSlices} — resume aborts on a mismatch' },
    truncations: { type: 'array', items: { type: 'string' }, description: 'cumulative truncation/dedup ledger' },
    written: { type: 'array', items: { type: 'number' }, description: 'build numbers already written' },
    gaps: { type: 'array', items: {}, description: 'critic findings (small; reloaded on a resume past the critic so finalize can report the counts)' },
    distill: { type: 'object', description: 'distill result counts { docs, residual, failed }, persisted once distill runs' },
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
function sliceDocPath(s) { return `${OUT}/${specRelPath(s)}` }
// specRelPath — the spec path RELATIVE to OUT (`specs/<NNNN>-<slug>.md`). Used both to
// build sliceDocPath (the absolute write target) and as the exact INDEX link target, so
// the two can never diverge. Derives from specName (the single source of truth).
function specRelPath(s) { return `specs/${specName(s.n, s.name)}` }

// Per-capability side-car paths (heavy analysis kept off the checkpoint). One file
// per capability per kind, each written by the agent that GENERATES it (discovery →
// slices+thread; behavior → acceptance criteria) and read back by the feature-spec
// and ACCEPTANCE writers. Keyed by slug(epicId) so the path is filesystem-safe.
function slicesCarPath(epicId) { return `${EPICS_DIR}/${slug(epicId)}.slices.json` }
function behaviorCarPath(epicId) { return `${EPICS_DIR}/${slug(epicId)}.behavior.json` }
// LIGHT per-capability projection (id/name/capability/behaviorSummary/dependsOn — no
// thread, no criteria). Small enough to reload one capability at a time on resume
// without a large-string reproduction, so the orchestrator can rebuild its in-memory
// slice list from artifacts instead of carrying it in the (size-capped) checkpoint.
function lightCarPath(epicId) { return `${EPICS_DIR}/${slug(epicId)}.light.json` }

// Reserve enough of the agent budget for the final pass's tail (critic + a little
// overhead) so writing a full batch can never push the LAST pass over the cap.
// The doc-family writers (ARCHITECTURE/PRD/ADR/INDEX/ACCEPTANCE) run ONCE in the
// pass-1 synth tail, before partitioning, so they are NOT reserved here.
function tailReserve() {
  const critic = 1 + MAX_GAPFILL_ROUNDS
  return critic + 8
}

// Token-budget wrappers — the SINGLE place that reads the injected `budget` global (which the
// pure deterministic region may not touch). They compute the effective ceiling and delegate the
// yield decision to the pure budgetExhausted(). When neither a runtime "+Nk" directive nor
// maxTokensPerRun is set, effectiveTokenTotal() is Infinity ⇒ tokenBudgetSet() is false and
// shouldYieldForBudget() is always false ⇒ every budget branch is inert (byte-identical to today).
function effectiveTokenTotal() {
  if (typeof budget !== 'undefined' && budget && budget.total) return budget.total
  if (MAX_TOKENS_PER_RUN > 0) return MAX_TOKENS_PER_RUN
  return Infinity
}
function tokenSpent() {
  return (typeof budget !== 'undefined' && budget && typeof budget.spent === 'function') ? budget.spent() : 0
}
function tokenBudgetSet() { return isFinite(effectiveTokenTotal()) }
function shouldYieldForBudget() {
  return budgetExhausted(effectiveTokenTotal(), tokenSpent(), TOKEN_RESERVE)
}
// Voluntary yield at a checkpoint boundary. The boundary's saveStage already persisted the
// checkpoint, so this only records a LOUD ledger note and returns the SAME resume contract the
// over-scale write partition uses, plus a stoppedForBudget marker. Auto-resume stitches the next
// chunk. progressGuard (didWorkThisTurn) ensures we never yield before ≥1 unit of work this turn.
let didWorkThisTurn = false
function yieldForBudget(stage, extraCounts = {}) {
  const note = `⏸️  Paused at token budget after stage '${stage}' — re-run (or /loop) with { resume: true } pointed at outputDir "${OUT}" to continue. Nothing dropped.`
  log(note); dropped.push(note)
  return {
    ok: true, outDir: OUT, resumeRequired: true, stoppedForBudget: true, stage,
    resumeArgs: { resume: true, outputDir: OUT },
    counts: { ...extraCounts },
    truncations: dropped,
  }
}
// True only when a token ceiling is set, we've done ≥1 unit of work this turn, and spend has
// reached the reserve. The progress guard prevents an infinite no-progress resume loop when the
// ceiling is smaller than a single phase's cost.
function budgetYieldNow() { return didWorkThisTurn && shouldYieldForBudget() }

// Deliberate phase stop for the per-phase commands (via UNTIL). The stage's saveStage
// already persisted the checkpoint, so this just records a note and returns a { paused }
// result. Unlike yieldForBudget it sets NO resumeRequired/stoppedForBudget flag — the
// command must NOT auto-re-invoke; a human reviews the phase output, then runs the next
// phase command. Crucially it NEVER clears the checkpoint (that only happens at natural
// completion, in finalize()), so the next phase resumes from where this one stopped.
// stage->next-command map is informational only (guides the user's next step).
const NEXT_COMMAND = {
  mapped: '/portkit-discover', discovering: '/portkit-discover', discovered: '/portkit-synthesize',
  synthesized: '/portkit-synthesize', docs: '/portkit-adrs', adrs: '/portkit-specs',
  writing: '/portkit-critic', critiqued: '/portkit-distill', distilled: null,
}
function pausedAfter(stage, extraCounts = {}) {
  const nextCmd = NEXT_COMMAND[stage]
  const note = `⏸️  Stopped after stage '${stage}' (phase ceiling until='${UNTIL}'). Checkpoint kept at ` +
    `\`${IR_PATH}\` — review this phase's output, then run ${nextCmd ? `\`${nextCmd}\`` : 'the next phase'} to continue.`
  log(note)
  return {
    ok: true, outDir: OUT, paused: true, stage, next: stageAfter(stage), nextCommand: nextCmd,
    resumeArgs: { resume: true, outputDir: OUT },
    counts: { ...extraCounts },
    truncations: dropped,
  }
}

async function writeSliceDocs(sliceList) {
  const written = await pooled(sliceList.map((s) => () => {
    const path = sliceDocPath(s)
    const ctx = {
      id: s.id, name: s.name, epicId: s.epicId, buildNumber: s.n,
      capability: s.capability, behaviorSummary: s.behaviorSummary,
      dependsOn: s.dependsOn || [],
    }
    return agent(
      `You are the PortKit FEATURE-SPEC writer. Write ONE self-contained feature spec to \`${path}\`.\n\n` +
      `${FRESH ? rewriteClause(path) : `FIRST: if \`${path}\` already exists and is non-empty, a prior pass already wrote it — do NOT rewrite it; ` +
      `return \`{ "path": "${path}", "ok": true, "selfContained": true }\` immediately (its durable output stands).`}\n\n` +
      `This feature's heavy analysis is in two side-car files — READ them and pull out ONLY the entry whose ` +
      `slice id is \`${s.id}\`:\n` +
      `- Component thread: the slice with \`id == "${s.id}"\` in \`${slicesCarPath(s.epicId)}\` (its \`thread\`).\n` +
      `- Acceptance criteria: the entry with \`sliceId == "${s.id}"\` in \`${behaviorCarPath(s.epicId)}\` ` +
      `(\`acceptanceCriteria\`, \`testRefs\`, \`coverage\`). If that file or entry is missing, say coverage is ` +
      `unknown/none — do NOT invent criteria.\n\n` +
      `It must let a LESS CAPABLE local model rebuild this feature from this spec + ARCHITECTURE.md ALONE, ` +
      `without the source. Include, in this order:\n` +
      `- Title + one-line capability.\n` +
      `- The end-to-end behavior thread (each component with its source \`path:line\`, from the side-car).\n` +
      `- Interface/contract: inputs, outputs, and EXACT behavior — every error, edge case, and ordering guarantee.\n` +
      `- Prerequisite features (build order: this is #${s.n}; dependsOn ${JSON.stringify(s.dependsOn || [])}).\n` +
      `- Acceptance criteria for THIS feature (from the behavior side-car; concrete and runnable-in-spirit).\n` +
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

// runBehaviorSpec — extract each slice's behavioral acceptance spec from the source's
// tests and WRITE the behavior side-car. Deliberately SEPARATE from discovery so a resume
// can fill a MISSING behavior spec against ALREADY-DISCOVERED slices (reloaded from
// light.json) WITHOUT re-discovering — and thus renumbering — the slice set. `slices` carry
// at least { id, name, capability }; a capability with no slices needs no behavior side-car.
async function runBehaviorSpec(epicId, slices, sysFacts) {
  const ids = (slices || []).map(s => ({ id: s.id, name: s.name, capability: s.capability }))
  if (ids.length === 0) return
  await agent(
    `You are the PortKit BEHAVIOR-SPEC agent. The source's existing tests are the behavioral contract.\n\n` +
    `Source root: \`${SOURCE}\`. Test setup: ${sysFacts}\n\n` +
    `For each slice below, find the source tests that exercise it and translate them into LANGUAGE-NEUTRAL ` +
    `acceptance criteria (concrete enough that a weak model can self-check its rebuild). Cite each source test ` +
    `as \`path:line\`. Rate coverage good/thin/none. FLAG thin/none LOUDLY — never paper over missing coverage.\n\n` +
    `WRITE the result as JSON \`{ "perSlice": [ { "sliceId", "coverage", "acceptanceCriteria": [...], "testRefs": [...] } ] }\` ` +
    `to \`${behaviorCarPath(epicId)}\` (create parent directories first). This side-car is read later by the ` +
    `ACCEPTANCE and feature-spec writers — write the file, do not just return.\n\n` +
    `SLICES:\n${JSON.stringify(ids, null, 2)}\n\n${GROUND_RULE}\n\nReturn perSlice behavioral specs.`,
    { schema: BEHAVIOR, phase: 'Discover slices', label: `behavior:${epicId}` }
  )
}

// Discover ONE capability end-to-end: trace it into fine vertical slices (features),
// then extract each slice's behavioral acceptance spec from the test suite. Returns
// { epicId, slices } — or null if the discovery agent itself failed, so a failed
// capability is retried on the next resume rather than silently lost. A capability that
// legitimately has no slices returns { epicId, slices: [] } (done, not retried).
async function discoverEpic(epic, sysFacts) {
  const r = await agent(
    `You are the PortKit SLICE-DISCOVERY agent for ONE capability of the source at \`${SOURCE}\`.\n\n` +
    `EPIC: ${JSON.stringify(epic)}\n\n` +
    `Trace this capability END-TO-END through every layer it touches (entry → validation → business rule → ` +
    `data model → persistence → response/side-effects). Decompose it into fine, FUNCTION/UNIT-SIZED VERTICAL ` +
    `SLICES — each an independently buildable & testable thread. For each slice give: a stable id (prefix with ` +
    `the epic id), name, the observable capability, the \`thread\` (components touched, each with a \`path:line\` ` +
    `citation), a precise behaviorSummary, and dependsOn (other slice ids it needs first).\n\n` +
    `Then WRITE two side-car files (create parent directories first with \`mkdir -p\`):\n` +
    `1. \`${slicesCarPath(epic.id)}\` — the FULL slices array (every field, INCLUDING each slice's \`thread\`). ` +
    `This is the feature-spec writer's source for the component thread.\n` +
    `2. \`${lightCarPath(epic.id)}\` — a LIGHT projection: a JSON array of ` +
    `\`{ "id", "name", "capability", "behaviorSummary", "dependsOn" }\` for the same slices (NO thread). This lets a ` +
    `resume rebuild the build graph cheaply.\n` +
    `Write BOTH files — do not just return.\n\n` +
    `${GROUND_RULE}\n\nReturn the slices.`,
    { schema: SLICES, phase: 'Discover slices', label: `discover:${epic.id}` }
  )
  const prev = r ? { epicId: epic.id, slices: r.slices || [] } : null
  if (!prev || prev.slices.length === 0) return prev
  // LIGHT per-epic result ONLY — the bulky thread + acceptance criteria live in the
  // side-cars (written by the discovery + behavior agents), never in the checkpoint
  // (that is what kept persist small enough to succeed). Heavy consumers read from disk.
  const lightSlices = prev.slices.map((s) => ({
    id: s.id, name: s.name, capability: s.capability,
    behaviorSummary: s.behaviorSummary, dependsOn: s.dependsOn || [],
  }))
  await runBehaviorSpec(epic.id, lightSlices, sysFacts)
  return { epicId: epic.id, slices: lightSlices }
}

async function runCritic(scopeNote = '') {
  phase('Critic')
  const scopePrefix = scopeNote ? `${scopeNote}\n\n` : '' // '' on a full run ⇒ prompts byte-identical to today
  function criticPrompt(round, prior) {
    return scopePrefix +
      `You are the PortKit CRITIC. Audit the generated recreation kit under \`${OUT}\` for whether a LESS ` +
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
    !shouldYieldForBudget() // stop gap-fill once remaining budget falls to the reserve (single source of truth)
  ) {
    round++
    const fixable = gaps.filter(g => g.fixable)
    log(`Gap-fill round ${round}: attempting ${fixable.length} fixable gap(s).`)
    await pooled(fixable.map((g, i) => () => agent(
      scopePrefix +
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

// Distill (opt-in): emit a citation-free MIRROR of the kit under <OUT>/distilled/ for the weaker
// rebuilder. `docPaths` are relative to OUT (ARCHITECTURE.md, PRD.md, INDEX.md, ACCEPTANCE.md, every
// specs/*.md and adr/*.md). Each doc is stripped by its own agent (file-to-file, so large docs never
// round-trip through the orchestrator), then self-checks for residual `path:line` refs. Returns the
// total residual count so the caller can flag an imperfect strip.
const DISTILLED = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string', description: 'the distilled/ path written' },
    residualCitations: { type: 'number', description: 'count of `path:line` refs still present after stripping (should be 0)' },
  },
}
async function runDistill(docPaths) {
  phase('Distill')
  log(`Distilling ${docPaths.length} doc(s) into \`${OUT}/distilled/\` (citation-free copy for the rebuilder).`)
  const reports = await pooled(docPaths.map((rel) => () => {
    const src = `${OUT}/${rel}`
    const dst = `${OUT}/distilled/${rel}`
    return agent(
      `You are the PortKit DISTILL agent. Produce a CLEAN, citation-free copy of ONE kit document for a ` +
      `LESS CAPABLE local model that will rebuild the software from the docs ALONE — it has NO access to the ` +
      `original source, so \`path:line\` citations are noise at best and induce hallucination at worst.\n\n` +
      `Read \`${src}\`. Write the cleaned version to \`${dst}\` (run \`mkdir -p\` on its parent dir first). Rules:\n` +
      `1. REMOVE every SOURCE CITATION: a \`path:line\` reference to the original source — a path ending in a ` +
      `file extension immediately followed by \`:<line>\` (optionally backtick-wrapped, with an optional ` +
      `\`-range\` or \`,list\`), e.g. \`src/utils/config.ts:191-193\`, \`config.ts:308\`, \`src/cli.ts:110\`. ` +
      `Remove the citation AND tidy the surrounding prose (drop now-empty parens, dangling "see"/"per"/"verified", ` +
      `stray dashes, double spaces) so every sentence reads naturally.\n` +
      `2. KEEP, verbatim: \`[INFERRED]\` and \`[UNVERIFIED]\` tags (they carry real meaning for the rebuilder), ` +
      `all prose/behavior, headings, code blocks, and any path that has NO line number (e.g. \`.config/settings.yaml\`, ` +
      `\`.config/templates/\`) — real artifacts the rebuild must produce.\n` +
      `3. If a sentence ONLY POINTED at the source (e.g. "the logic is at \`config.ts:191\`") and stated no ` +
      `behavior, INLINE the actual behavior by reading the source at \`${SOURCE}\` (stay grounded — do NOT invent). ` +
      `If you cannot determine it, replace the pointer with a \`[UNVERIFIED]\` note. Never leave a dangling ` +
      `reference and never fabricate.\n` +
      `4. Change NOTHING else — do not summarize, reorder, or reword beyond the citation cleanup.\n\n` +
      `After writing, grep \`${dst}\` for any remaining \`path:line\` citation and return the exact count as ` +
      `\`residualCitations\` (0 means fully clean).`,
      { schema: DISTILLED, phase: 'Distill', label: `distill:${rel}` }
    )
  }))
  const residual = reports.filter(Boolean).reduce((n, r) => n + (Number(r.residualCitations) || 0), 0)
  const failed = docPaths.length - reports.filter(Boolean).length
  if (residual > 0 || failed > 0) {
    const note = `Distill: ${residual} residual citation(s) across the distilled/ copy` +
      (failed ? ` and ${failed} doc(s) failed to distill` : '') + ` — the top-level cited kit is unaffected.`
    log(`⚠️  ${note}`); dropped.push(note)
  } else {
    log(`Distill complete: ${docPaths.length} citation-free doc(s) under \`${OUT}/distilled/\`.`)
  }
  return { docs: docPaths.length, residual, failed }
}

// IR persistence — the checkpoint mechanism. The orchestrator sandbox has no
// filesystem, so an agent writes/reads/deletes the JSON. The checkpoint is now SMALL
// (heavy analysis lives in generator-written side-cars, see EPICS_DIR), so a single
// agent can write it verbatim / read it back structured without stalling — the thing
// that broke when the full accumulator went through here (see the EPICS_DIR note).
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
    `You are the PortKit IR-CLEAR agent. The run is complete, so remove the whole checkpoint directory (the ` +
    `checkpoint JSON AND the per-capability side-cars) so a later run starts fresh instead of auto-resuming a ` +
    `finished run: \`rm -rf "$(dirname "${IR_PATH}")"\`. Return when done.`,
    { phase: 'Checkpoint', label: 'ir:clear' }
  )
}
// Resume helpers — completion is judged by the DURABLE ARTIFACTS on disk, not by the
// checkpoint, so no already-finished agent is ever re-run even if the checkpoint lagged.
// scanEpicSidecars: for EACH capability under EPICS_DIR, which side-cars exist. Slice
// STRUCTURE (light.json) and the BEHAVIOR spec (behavior.json) are INDEPENDENT artifacts —
// reporting them separately (rather than a single "both present = done" flag) lets
// planResume() reload durable structure and re-run ONLY a missing behavior spec, instead of
// re-discovering (and renumbering) a capability just because its behavior agent had failed.
// loadEpicLight: rebuild ONE capability's light slice list from its small light.json
// (a small read, never the heavy slices.json).
async function scanEpicSidecars() {
  const r = await agent(
    `You are the PortKit RESUME-SCAN agent. List \`${EPICS_DIR}\` (it may not exist — then return \`{"epics": []}\`). ` +
    `A capability id is a side-car file name with its \`.light.json\`, \`.slices.json\`, or \`.behavior.json\` suffix ` +
    `removed. For EVERY distinct capability id present, report which side-cars exist. Return ` +
    `\`{"epics": [ { "id": <id>, "hasLight": <true iff <id>.light.json exists>, "hasBehavior": <true iff <id>.behavior.json exists> } ]}\`.`,
    { schema: { type: 'object', properties: { epics: { type: 'array', items: {
        type: 'object',
        properties: { id: { type: 'string' }, hasLight: { type: 'boolean' }, hasBehavior: { type: 'boolean' } },
        required: ['id', 'hasLight', 'hasBehavior'] } } } },
      phase: 'Discover slices', label: 'resume:scan' }
  )
  return (r && Array.isArray(r.epics)) ? r.epics : []
}
async function loadEpicLight(epicId) {
  const r = await agent(
    `You are the PortKit LIGHT-LOAD agent. Read \`${lightCarPath(epicId)}\` and return \`{"slices": <its JSON array>}\` ` +
    `EXACTLY (do not alter). If the file is missing or empty, return \`{"slices": []}\`.`,
    { schema: { type: 'object', properties: { slices: { type: 'array', items: {} } } },
      phase: 'Discover slices', label: `light:${epicId}` }
  )
  return { epicId, slices: (r && Array.isArray(r.slices)) ? r.slices : [] }
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

// Write-specs stage. Writes the next un-written batch of feature specs and returns a
// CONTROL object: { done: true } when every spec is written (the caller proceeds to the
// critic stage), or { done: false, result } for a resumable stop (over-scale partition,
// token yield, or partial-failure) that the caller must RETURN verbatim. `partitioned`
// engages over-scale batching (off for a normal run, so behavior there is byte-for-byte
// unchanged). The doc-family writers already ran once in the synth tail, so a resume
// never re-authors them. Critic/Distill/finalize are now SEPARATE ladder stages
// (critiqued/distilled) driven by the main body — this helper only writes specs.
async function runWriteSpecs({ ordered, partitioned, priorWritten = [], extraCounts = {} }) {
  phase('Write specs')
  const writtenNs = new Set(priorWritten)

  // Per-batch size. Agent over-scale sizes a batch to the agent write budget (one big batch per
  // invocation, as before). A TOKEN budget instead uses small FIXED batches (≤ maxConcurrency) so
  // we checkpoint + re-check spend frequently and overshoot the window by at most one batch.
  const agentWriteBudget = Math.max(1, SAFE_BUDGET - tailReserve())
  const perBatch = tokenBudgetSet() ? Math.min(agentWriteBudget, MAX_CONCURRENCY) : agentWriteBudget

  // Loop batches WITHIN this invocation:
  //   - not partitioned  → one pass writes ALL pending (unchanged); partial failure yields to resume.
  //   - agent over-scale → exactly ONE batch per invocation, then yield (unchanged).
  //   - token-budgeted   → keep writing small batches until spend nears the reserve (or the agent
  //                        write budget for this invocation is filled), then yield. Each batch is a
  //                        real unit of forward progress, so the write phase can never no-progress-yield.
  let wroteThisInvocation = 0
  while (true) {
    const pending = ordered.filter(s => !writtenNs.has(s.n))
    if (pending.length === 0) break // everything written → fall through to critic

    let thisPass = pending
    if (partitioned && tokenBudgetSet()) {
      // Token chunking: take the next `perBatch` specs in build order. Specs are independent
      // files, so we batch at SLICE granularity here (not epic) — this bounds the per-pass
      // overshoot to ~maxConcurrency specs even inside one very large capability. Build order is
      // preserved (pending is ordered), so prerequisites still precede dependents.
      thisPass = pending.slice(0, perBatch)
    } else if (partitioned) {
      // Agent over-scale (no token budget): keep whole capabilities together per pass.
      const batch = planEpicBatches(buildEpicTree(pending), perBatch)[0]
      const ids = new Set((batch && batch.sliceIds) || [])
      thisPass = pending.filter(s => ids.has(s.id))
    }

    const docs = await writeSliceDocs(thisPass)
    // Mark only features that actually wrote OK as done; failures stay pending and are
    // retried on the next pass (so a flaky write is never silently lost).
    const okThisPass = thisPass.filter((s, i) => docs[i] && docs[i].ok)
    okThisPass.forEach(s => writtenNs.add(s.n))
    if (okThisPass.length) didWorkThisTurn = true
    wroteThisInvocation += okThisPass.length
    const remaining = ordered.filter(s => !writtenNs.has(s.n)).length
    log(`Wrote ${okThisPass.length}/${thisPass.length} feature spec(s)` +
      (partitioned ? ` — ${writtenNs.size}/${ordered.length} done, ${remaining} remaining` : ''))

    // Persist write progress before returning ANY resumeRequired result (over-scale partition,
    // token yield, or a partially-failed non-partitioned pass). A clean full pass skips this and
    // clears the checkpoint at the end instead.
    if (partitioned || remaining > 0) {
      await saveStage('writing', { written: [...writtenNs] })
    }

    // No-progress guard: a partitioned batch that wrote nothing but has work left would loop
    // forever (across resumes AND within this while-loop). Stop loudly.
    if (partitioned && okThisPass.length === 0 && remaining > 0) {
      const err = `Write pass made no progress: all ${thisPass.length} write(s) failed, ${remaining} feature(s) still pending${tokenBudgetSet() ? ' (token-budget chunked run)' : ''}.`
      log(`❌ ${err}`); dropped.push(err)
      return { done: false, result: { ok: false, error: err, outDir: OUT, resumeRequired: true, truncations: dropped } }
    }

    if (remaining === 0) break // all done this pass → critic

    // Decide: keep filling this invocation, or yield to resume?
    //   - token-budgeted: continue unless spend hit the reserve OR the agent write budget is filled.
    //   - otherwise (not partitioned partial-failure, or agent over-scale): one pass per invocation.
    const stopForBudget = tokenBudgetSet() && shouldYieldForBudget()
    const stopForAgentCap = wroteThisInvocation >= agentWriteBudget
    if (!tokenBudgetSet() || stopForBudget || stopForAgentCap) {
      const note = `${remaining} feature spec(s) remain after this ${stopForBudget ? 'token-budget ' : ''}pass — re-run with { resume: true } pointed at outputDir "${OUT}" to continue (nothing dropped).`
      log(`⏸️  ${note}`); dropped.push(note)
      return { done: false, result: {
        ok: true, outDir: OUT, resumeRequired: true,
        ...(stopForBudget ? { stoppedForBudget: true, stage: 'writing' } : {}),
        resumeArgs: { resume: true, outputDir: OUT },
        counts: { slicesPlanned: ordered.length, slicesWritten: writtenNs.size, slicesRemaining: remaining, ...extraCounts },
        truncations: dropped,
      } }
    }
    // token budget remains → loop to the next small batch within THIS invocation
  }

  // Every spec is written. Record the writing stage as COMPLETE (written = all build
  // numbers) so a resume proceeds to the critic stage rather than re-entering the write
  // loop, then hand control back to the main body's critiqued/distilled stages.
  await saveStage('writing', { written: ordered.map(s => s.n) })
  return { done: true }
}

// finalize — assemble the run's final result object and CLEAR the checkpoint. Called
// once at the run's NATURAL end: the terminal stage reached with no phase ceiling in
// effect ('distilled' when DISTILL, else 'critiqued'). Extracted from the old
// runWriteAndFinish tail so both the fresh path and a resume that SKIPPED the critic/
// distill stages produce the same result (gaps/distill come from the checkpoint on such
// a resume). clearIR() lives ONLY here — a phase command that stops early returns
// pausedAfter() and deliberately leaves the checkpoint intact for the next phase.
async function finalize({ ordered, adrs = [], gaps = [], distill = null, extraCounts = {} }) {
  await clearIR()
  return {
    ok: true, outDir: OUT, resumeRequired: false,
    counts: {
      slicesPlanned: ordered.length,
      slicesWritten: ordered.length,
      adrs: adrs.length,
      gapsRemaining: gaps.length,
      gapsRemainingHumanDecision: gaps.filter(g => !g.fixable).length,
      ...(distill ? { distilledDocs: distill.docs, residualCitations: distill.residual } : {}),
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
      ...(distill ? { distilledDir: `${OUT}/distilled/` } : {}),
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
    } else if (loaded.scale &&
      ((loaded.scale.maxEpics ?? MAX_EPICS) !== MAX_EPICS || (loaded.scale.limitSlices ?? LIMIT_SLICES) !== LIMIT_SLICES)) {
      // Scope MISMATCH: the checkpoint was built with different scale knobs. Resuming would reuse
      // the checkpoint's (capped) epic list and limitSlices, silently continuing the smaller scope
      // with this run's flags. Abort loudly rather than produce a Frankenstein kit.
      return {
        ok: false,
        error: `Checkpoint at \`${IR_PATH}\` was built with maxEpics=${loaded.scale.maxEpics}, limitSlices=${loaded.scale.limitSlices}; ` +
          `this run uses maxEpics=${MAX_EPICS}, limitSlices=${LIMIT_SLICES}. Resuming would keep the checkpoint's smaller scope, ` +
          `not your new flags. Use { fresh: true } with a clean or new outputDir for a full run, or re-run with the same scale knobs to continue this checkpoint.`,
        outDir: OUT,
        checkpointScale: loaded.scale,
        requestedScale: { maxEpics: MAX_EPICS, limitSlices: LIMIT_SLICES },
      }
    } else {
      checkpoint = loaded
      dropped.push(...(Array.isArray(loaded.truncations) ? loaded.truncations : []))
      log(`↩️  Resuming from checkpoint stage '${loaded.stage}' for \`${SOURCE}\`.`)
    }
  }
} else {
  // FRESH: drop any stale checkpoint + side-cars so discovery re-runs cleanly, and warn that
  // existing generated docs will be OVERWRITTEN (the writers get rewriteClause). Orphaned
  // higher-numbered specs from a LARGER prior run may remain — a clean/new outputDir avoids that.
  await clearIR()
  log(`🧹 Fresh run: cleared any checkpoint under \`${OUT}/.portkit\`; existing kit files in \`${OUT}\` will be OVERWRITTEN (orphaned specs from a larger prior run may remain — use a clean or new outputDir if that matters).`)
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
let sysFacts, epics, epicsTotal
if (RESUMING && stageDone(savedStage, 'mapped')) {
  sysFacts = checkpoint.sysFacts || '{}'
  epics = checkpoint.epics || []
  // Pre-cap total for the critic's intentional-omission scope note; fall back to the kept
  // count for pre-epicsTotal checkpoints (⇒ no false "capabilities dropped" claim).
  epicsTotal = checkpoint.epicsTotal ?? epics.length
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
  epicsTotal = map.epics.length
  epics = cap(map.epics, MAX_EPICS, 'epics')
  log(`Mapped ${map.epics.length} capability(ies); analyzing ${epics.length}.`)
  // Persist the scale knobs so a later resume can detect a scope MISMATCH (e.g. resuming a
  // maxEpics=5/limitSlices=3 smoke-test checkpoint with a full-run command) and refuse to silently
  // continue the smaller scope — the exact trap that produced the 5-epic Frankenstein kit.
  // epicsTotal (pre-cap) rides along so the critic can flag an intentional maxEpics drop even on resume.
  await saveStage('mapped', {
    source: SOURCE, fileCount: probe.fileCount, sysFacts, epics, epicsTotal,
    scale: { maxEpics: MAX_EPICS, limitSlices: LIMIT_SLICES },
  })
}
// Phase ceiling: /portkit-map stops here. Placed OUTSIDE the if/else so it fires on a
// resume that skipped the map agent too (re-running /portkit-map just re-reports).
if (stopAfter('mapped', UNTIL)) return pausedAfter('mapped', { epics: epics.length })

// ===========================================================================
// Stage: Discover — per capability, trace slices + extract the behavioral spec.
// Processed in CHECKPOINTED batches (CHECKPOINT_EVERY capabilities per batch): after
// each batch the checkpoint advances, so an interruption keeps every already-analyzed
// capability instead of restarting the whole (most expensive) discovery phase.
// ===========================================================================
// perEpicDone holds LIGHT slices in memory (fresh: from discovery returns; resume:
// rebuilt from the light side-cars). On resume, completion is judged by the durable
// side-cars — NOT the checkpoint — so no finished capability is ever re-analyzed. We
// rebuild in `epics` order (not filesystem order) so the downstream build numbering is
// identical to a fresh run, keeping already-written spec file names valid.
let perEpicDone = []
if (RESUMING && stageDone(savedStage, 'mapped')) {
  const plan = planResume(epics, await scanEpicSidecars())
  if (plan.reload.length) {
    // Structure is durable + deterministic: reload EVERY capability that has a light.json
    // (in `epics` order, so numbering matches a fresh run) — NEVER re-discover it, which
    // would change the slice set and renumber every downstream spec.
    perEpicDone = (await pooled(plan.reload.map(id => () => loadEpicLight(id)))).filter(Boolean)
    // A capability whose behavior side-car is missing (its behavior agent failed on a prior
    // pass) re-runs ONLY the behavior agent, against the reloaded slices — structure and
    // numbering are untouched, so already-written specs keep matching their build numbers.
    const fill = new Set(plan.behaviorOnly)
    const behaviorTodo = perEpicDone.filter(e => e && e.slices.length && fill.has(e.epicId))
    if (behaviorTodo.length) {
      log(`Reusing ${perEpicDone.length} capability(ies) from durable side-cars (structure unchanged); re-running behavior-spec only for ${behaviorTodo.length} missing a behavior side-car.`)
      await pooled(behaviorTodo.map(e => () => runBehaviorSpec(e.epicId, e.slices, sysFacts)))
    } else {
      log(`Reusing ${perEpicDone.length} capability(ies) already analyzed by a prior run (from side-cars).`)
    }
  }
}
if (!(RESUMING && stageDone(savedStage, 'discovered'))) {
  phase('Discover slices')
  const doneIds = new Set(perEpicDone.map(e => e && e.epicId))
  const todo = epics.filter(e => !doneIds.has(e.id))
  if (perEpicDone.length) log(`Discovery resuming: ${perEpicDone.length} done, ${todo.length} capability(ies) to analyze.`)
  for (const group of chunk(todo, CHECKPOINT_EVERY)) {
    const results = await pooled(group.map((epic) => () => discoverEpic(epic, sysFacts)))
    perEpicDone.push(...results.filter(Boolean))
    didWorkThisTurn = true // a discovery batch completed this turn — the progress guard is now armed
    // TINY checkpoint: advance the stage + record only WHICH capabilities are done
    // (their ids). The slice data itself lives in the durable side-cars, never here.
    await saveStage('discovering', { epicsDone: perEpicDone.map(e => e.epicId) })
    // Voluntary token-budget yield: discovery is the dominant early cost and is fully
    // mid-phase resumable (side-cars + epicsDone), so this is the cheapest place to chunk a
    // very large project. The just-checkpointed batch is durable before we stop.
    if (budgetYieldNow()) return yieldForBudget('discovering', { epicsDiscovered: perEpicDone.length })
  }
  await saveStage('discovered', { epicsDone: perEpicDone.map(e => e.epicId) })
  if (budgetYieldNow()) return yieldForBudget('discovered', { epicsDiscovered: perEpicDone.length })
}
// Phase ceiling: /portkit-discover stops here (outside the block so it fires on resume too).
if (stopAfter('discovered', UNTIL)) return pausedAfter('discovered', { epicsDiscovered: perEpicDone.length })

// ===========================================================================
// Stage: Synthesize — dedup (the one job needing judgment); the mechanical graph
// work (rewriteEdges + topoSort) is JS-owned and unit-tested. Skipped wholesale on
// a resume past this stage (the ordered build graph is reloaded from the checkpoint,
// so build numbers stay stable — specs already written keep matching their numbers).
// ===========================================================================
// `ordered` (the numbered build graph) is NOT persisted — it is an O(slices) aggregate
// that would blow the checkpoint's size budget. Instead we persist only the small
// DEDUP `merges` and recompute the build order deterministically (rewriteEdges +
// topoSort, both unit-tested) from the light slices. Same slices + same merges ⇒ same
// numbering, so specs already written on a prior pass keep matching their build numbers.
let ordered, slicesDiscovered, slicesOmittedForTest = 0
{
  // Flatten light slices (fresh: from discovery returns; resume: rebuilt from side-cars).
  // Heavy thread/behavior stay in side-cars, read from disk by the spec/ACCEPTANCE writers.
  const slices = []
  for (const e of perEpicDone) {
    if (!e) continue
    for (const s of (e.slices || [])) slices.push({ ...s, epicId: e.epicId })
  }
  if (slices.length === 0) {
    return { ok: false, error: 'No vertical slices were discovered.', outDir: OUT }
  }
  slicesDiscovered = slices.length

  // Dedup decisions: reuse the persisted merges on a resume past 'synthesized' (the
  // synth agent never re-runs); otherwise ask the synth agent for them now.
  const resumedSynth = RESUMING && stageDone(savedStage, 'synthesized') && Array.isArray(checkpoint.merges)
  let merges
  if (resumedSynth) {
    merges = checkpoint.merges
    log(`Skipping synthesis (checkpointed merges): rebuilding build order for ${slices.length} slice(s).`)
  } else {
    log(`Discovered ${slices.length} feature(s) across ${perEpicDone.filter(Boolean).length} capability(ies).`)
    phase('Synthesize')
    const synthInput = slices.map(s => ({
      id: s.id, name: s.name, epicId: s.epicId, capability: s.capability, behaviorSummary: s.behaviorSummary,
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
    merges = (synth && synth.merges) || []
  }

  // Apply the MERGE DECISIONS deterministically — JS owns every mechanical graph step:
  // rewriteEdges remaps/aggregates dependsOn across merges (never dropping a slice),
  // topoSort computes the build order (recovering cycles/dangling deps into the ledger).
  const mergeMap = {}
  for (const m of merges) {
    const keep = m && m.keep
    if (!keep) continue
    for (const f of (m.merge || [])) if (f && f !== keep) mergeMap[f] = keep
  }
  const rewritten = rewriteEdges(slices, mergeMap)
  const topo = topoSort(rewritten.slices)
  const survivorById = new Map(rewritten.slices.map(s => [s.id, s]))
  const orderedFull = topo.order.map((id, i) => ({ ...survivorById.get(id), n: i + 1 }))
  const mergedCount = slices.length - orderedFull.length
  ordered = orderedFull

  // DEV/TEST cost cap (opt-in, LOUD). Keep only the first N features in build order;
  // topo order means prerequisites are kept, so the trimmed kit stays consistent.
  if (LIMIT_SLICES > 0 && ordered.length > LIMIT_SLICES) {
    slicesOmittedForTest = ordered.length - LIMIT_SLICES
    ordered = ordered.slice(0, LIMIT_SLICES)
  }

  // Ledger notes + checkpoint only on the FRESH synth path (recomputing on resume
  // would duplicate the notes and the merges are already persisted).
  if (!resumedSynth) {
    for (const note of rewritten.notes) { log(`🔀 dedup: ${note}`); dropped.push(note) }
    for (const note of topo.notes) { log(`⚠️  build-order: ${note}`); dropped.push(note) }
    if (mergedCount > 0) log(`Synthesis merged ${mergedCount} duplicate slice(s); ${orderedFull.length} canonical slice(s) remain.`)
    if (slicesOmittedForTest > 0) {
      const note = `🧪 TEST LIMIT: writing only ${ordered.length} of ${orderedFull.length} feature(s) (limitSlices=${LIMIT_SLICES}). ` +
        `PARTIAL end-to-end TEST kit — NOT a complete recreation kit; ${slicesOmittedForTest} feature(s) intentionally omitted.`
      log(note); dropped.push(note)
    }
    await saveStage('synthesized', { merges, sysFacts, slicesDiscovered, slicesOmittedForTest })
    didWorkThisTurn = true // the synth agent ran this turn
  }
  // Phase ceiling: pause after dedup if explicitly asked (not a default command target —
  // /portkit-synthesize stops at 'docs' — but honored if until='synthesized' is passed).
  if (stopAfter('synthesized', UNTIL)) return pausedAfter('synthesized', { slicesDiscovered })
  // Yield only if something ran this turn (fresh synth here, or discovery earlier). On a pure
  // resume that reloaded merges without doing work, didWorkThisTurn stays false so we push on to
  // the doc family rather than yield having done nothing.
  if (budgetYieldNow()) return yieldForBudget('synthesized', { slicesDiscovered })
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
//
// Each feature carries its EXACT `spec` path (specRelPath → specName, the same source
// of truth sliceDocPath uses to WRITE the file). The agent MUST link that verbatim and
// MUST NOT re-slugify the name: slug() truncates to 48 chars, so a recomputed link for a
// long name silently disagreed with the truncated file on disk — every such link 404'd
// even on a fully successful run. The capability tree is enriched with the same per-
// feature {n,id,name,spec} so its links use the exact path too (not just build order).
const byIdForIndex = new Map(ordered.map(s => [s.id, s]))
const indexData = {
  buildOrder: ordered.map(s => ({
    n: s.n, id: s.id, name: s.name, epicId: s.epicId, spec: specRelPath(s),
    dependsOn: s.dependsOn || [], mergedFrom: s.mergedFrom || [],
  })),
  capabilityTree: epicTree.map(({ epicId, sliceIds }) => ({
    epicId,
    features: sliceIds.map(id => {
      const s = byIdForIndex.get(id)
      return { n: s.n, id: s.id, name: s.name, spec: specRelPath(s) }
    }),
  })),
}
await agent(
  `You are the PortKit INDEX writer. ${rewriteClause(`${OUT}/INDEX.md`)} Write \`${OUT}/INDEX.md\` — the recreation roadmap — from the data below. ` +
  `The build order and capability→feature tree are AUTHORITATIVE (computed deterministically) — do NOT reorder, ` +
  `renumber, or invent.\n\n` +
  `CRITICAL — spec links: every feature object carries an exact \`spec\` field (e.g. \`specs/0001-....md\`). Use that ` +
  `string VERBATIM as the markdown link target. Do NOT construct, slugify, shorten, or otherwise alter a spec path ` +
  `yourself — the filenames are truncated and a hand-built link will not match the file on disk.\n\n` +
  `Include:\n` +
  `- A CAPABILITY→FEATURE tree: group by capability in the given order (use \`capabilityTree\`); show each feature as ` +
  `\`#<n> <name>\` with its id and a link whose target is that feature's exact \`spec\` value.\n` +
  `- The RECOMMENDED BUILD ORDER as a numbered list (#1 first), each entry with id, name, capability, and its ` +
  `dependsOn ids.\n` +
  `- Flag any feature whose mergedFrom is non-empty (it absorbed duplicate features).\n\n` +
  `DATA:\n${JSON.stringify(indexData, null, 2)}`,
  { phase: 'Synthesize', label: 'index' }
)

// ACCEPTANCE writer — the single surface that flags coverage gaps loudly (each
// feature spec's acceptance criteria are drawn from here). Written from the
// extracted behavior data of the SURVIVING (post-merge) features; agent invents nothing.
// The surviving features (light) + the behavior side-cars to pull their acceptance
// criteria from. Criteria live in the per-capability behavior side-cars (written at
// discovery), NOT in the checkpoint — the ACCEPTANCE writer reads them from disk.
const survivors = ordered.map(s => ({ sliceId: s.id, name: s.name, epicId: s.epicId }))
const behaviorFiles = [...new Set(ordered.map(s => s.epicId))].map(behaviorCarPath)
await agent(
  `You are the PortKit ACCEPTANCE writer. ${rewriteClause(`${OUT}/ACCEPTANCE.md`)} Write \`${OUT}/ACCEPTANCE.md\`: the full extracted acceptance criteria, ` +
  `grouped by capability and mapped to feature id, each with its source test \`path:line\` refs.\n\n` +
  `The criteria are in these behavior side-car files (JSON, each \`{ "perSlice": [ { "sliceId", "coverage", ` +
  `"acceptanceCriteria", "testRefs" } ] }\`):\n${behaviorFiles.map(f => `- \`${f}\``).join('\n')}\n` +
  `READ them and index by \`sliceId\`. For EACH surviving feature below, emit its criteria/testRefs/coverage from ` +
  `that index; if a feature's entry (or its file) is missing, treat coverage as 'none'. Use ONLY what the ` +
  `side-cars contain — do NOT invent criteria.\n\n` +
  `At the TOP, add a COVERAGE SUMMARY table (feature → good/thin/none) and LOUDLY flag every feature whose coverage ` +
  `is 'thin' or 'none' as a rebuild risk — never paper over missing coverage.\n\n` +
  `SURVIVING FEATURES:\n${JSON.stringify(survivors, null, 2)}\n\n${GROUND_RULE}`,
  { phase: 'Synthesize', label: 'acceptance' }
)

// ARCHITECTURE writer — the system/tech spec. Absorbs the old system-map + kernel
// glossary + cross-cutting conventions into one doc a weak model reads once and
// every feature spec references (instead of restating).
await agent(
  `You are the PortKit ARCHITECTURE writer. ${rewriteClause(`${OUT}/ARCHITECTURE.md`)} Write \`${OUT}/ARCHITECTURE.md\` — the system/technical spec a weak ` +
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
  `You are the PortKit PRD writer. ${rewriteClause(`${OUT}/PRD.md`)} Write \`${OUT}/PRD.md\` — a Product Requirements Document RECONSTRUCTED from ` +
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
  didWorkThisTurn = true // the doc family (4 agents) ran this turn
}
// Phase ceiling: /portkit-synthesize stops here (after the doc family is authored).
if (stopAfter('docs', UNTIL)) return pausedAfter('docs', { slicesDiscovered })
if (budgetYieldNow()) return yieldForBudget('docs')

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
    `${rewriteClause(`${OUT}/adr/${pad(i + 1)}-${slug(d.title)}.md`)}\n\n` +
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
  didWorkThisTurn = true // ADR discovery + writers ran this turn
}
// Phase ceiling: /portkit-adrs stops here (outside the if/else so it fires on resume too).
if (stopAfter('adrs', UNTIL)) return pausedAfter('adrs', { adrs: decisions.length })
if (budgetYieldNow()) return yieldForBudget('adrs', { adrs: decisions.length })

// ===========================================================================
// Stage: Write specs + critic. Over-scale decision (computed once, then persisted
// so a resume reuses it): if a single run's projected agent count would approach the
// runtime ceiling, partition feature-spec writing into resumable passes.
// runWriteAndFinish advances the `written` checkpoint each pass and CLEARS the
// checkpoint on completion.
// ===========================================================================
// Two independent reasons to partition the write phase into resumable passes: AGENT over-scale
// (projected agents near the ~1000 ceiling) and a TOKEN budget (chunk to fit a subscription
// window). Either engages small/batched writes; a token budget additionally makes each pass small.
const finalCounts = {
  epics: epics.length, slicesDiscovered,
  // Present ONLY on a test-limited run so the partial kit is unmistakable.
  ...(slicesOmittedForTest > 0 ? { testLimited: true, slicesOmittedForTest } : {}),
}
// Skip the whole write phase on a resume past the critic (specs are already on disk).
if (!(RESUMING && stageDone(savedStage, 'critiqued'))) {
  let partitioned
  if (RESUMING && stageDone(savedStage, 'writing') && typeof checkpoint.partitioned === 'boolean') {
    partitioned = checkpoint.partitioned || tokenBudgetSet()
  } else {
    const projected = projectAgents({
      epicCount: epics.length, sliceCount: ordered.length,
      adrCount: decisions.length, maxAdrs: MAX_ADRS, gapfillRounds: MAX_GAPFILL_ROUNDS,
    })
    const overScale = projected > SAFE_BUDGET
    partitioned = overScale || tokenBudgetSet()
    if (overScale) {
      const note = `Over-scale: projected ~${projected} agents exceeds the safe budget (${SAFE_BUDGET}); partitioning feature-spec writing into resumable passes. Nothing dropped.`
      log(`⚖️  ${note}`); dropped.push(note)
    } else if (tokenBudgetSet()) {
      const note = `Token budget in effect (~${effectiveTokenTotal()} tokens, reserve ${TOKEN_RESERVE}); writing feature specs in small resumable passes sized to the subscription window. Nothing dropped.`
      log(`💰 ${note}`); dropped.push(note)
    }
  }
  // NOTE: `ordered` is deliberately NOT persisted (it is the O(slices) aggregate that
  // blew the checkpoint size budget); it is recomputed deterministically from the light
  // side-cars + persisted merges on resume. Only small state goes in the checkpoint.
  await saveStage('writing', { partitioned, adrs: decisions, written: checkpoint.written || [] })
  const writeCtl = await runWriteSpecs({
    ordered, partitioned, priorWritten: checkpoint.written || [], extraCounts: finalCounts,
  })
  // A resumable stop (over-scale partition, token yield, or partial-failure) — return verbatim.
  if (!writeCtl.done) return writeCtl.result
  // Phase ceiling: /portkit-specs stops here, after every spec is written, before the critic.
  if (stopAfter('writing', UNTIL)) return pausedAfter('writing', { ...finalCounts, slicesWritten: ordered.length })
}

// ===========================================================================
// Stage: Critic — grounding + completeness audit; writes RISKS-AND-GAPS.md and runs
// the budget-bounded gap-fill loop. Skipped on a resume past this stage; the gaps
// reload from the checkpoint so finalize can still report the counts.
// ===========================================================================
let gaps
if (RESUMING && stageDone(savedStage, 'critiqued')) {
  gaps = Array.isArray(checkpoint.gaps) ? checkpoint.gaps : []
  log(`Skipping critic (checkpointed): ${gaps.length} gap(s).`)
} else {
  // Tell the critic which omissions are INTENTIONAL (limitSlices trims specs, maxEpics drops
  // capabilities) so its gap-fill loop never "repairs" a deliberate truncation into a
  // claimed-complete kit. '' on a full run ⇒ the critic/gap-fix prompts are byte-identical to today.
  const scopeNote = omissionScopeNote({
    slicesOmittedForTest, limitSlices: LIMIT_SLICES,
    epicsKept: epics.length, epicsTotal: epicsTotal ?? epics.length,
  })
  gaps = await runCritic(scopeNote)
  await saveStage('critiqued', { gaps })
  didWorkThisTurn = true
}
// Phase ceiling: /portkit-critic stops here. (When distill is OFF, 'critiqued' is also
// the natural terminal stage — but a full run passes UNTIL=null, so it falls through.)
if (stopAfter('critiqued', UNTIL)) return pausedAfter('critiqued', { ...finalCounts, gapsRemaining: gaps.length })
if (budgetYieldNow()) return yieldForBudget('critiqued', { ...finalCounts, gapsRemaining: gaps.length })

// ===========================================================================
// Stage: Distill (opt-in) — emit a citation-free distilled/ mirror for the weaker
// rebuilder, after the critic has validated the cited kit. Skipped on a resume past
// this stage. When DISTILL is off, this stage is inert and 'critiqued' is terminal.
// ===========================================================================
let distill = null
if (DISTILL) {
  if (RESUMING && stageDone(savedStage, 'distilled')) {
    distill = checkpoint.distill || null
    log('Skipping distill (checkpointed).')
  } else {
    const docPaths = [
      'ARCHITECTURE.md', 'PRD.md', 'INDEX.md', 'ACCEPTANCE.md',
      ...ordered.map(s => specRelPath(s)),
      ...decisions.map((d, i) => `adr/${pad(i + 1)}-${slug(d.title)}.md`),
    ]
    distill = await runDistill(docPaths)
    await saveStage('distilled', { distill })
    didWorkThisTurn = true
  }
  // 'distilled' is the terminal stage, so a ceiling of 'distilled' means "finish": fall
  // through to finalize rather than pause (pausing would leave a completed-but-uncleared
  // checkpoint that a plain /portkit would then have to clean up).
}

// Natural completion — assemble the final result and clear the checkpoint.
return await finalize({ ordered, adrs: decisions, gaps, distill, extraCounts: finalCounts })
