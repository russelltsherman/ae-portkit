export const meta = {
  name: 'portkit',
  description: 'Analyze a codebase into a stack-neutral recreation kit (PRD, architecture spec, per-slice specs, ADRs, acceptance criteria) a weaker model can rebuild from',
  whenToUse: 'Reverse-engineering an existing project into design/planning docs, for a weaker downstream model to recreate it from the docs alone',
  phases: [
    { title: 'Preflight', detail: 'verify the input dir exists; abort loudly if not' },
    { title: 'Map', detail: 'survey the repo; draft the feature inventory' },
    { title: 'Discover slices', detail: 'trace each feature end-to-end; extract behavioral spec from tests' },
    { title: 'Synthesize', detail: 'normalize/dedup slices; compute the build order; author PRD + ARCHITECTURE + INDEX + ACCEPTANCE' },
    { title: 'ADRs', detail: 'discover architecturally significant decisions; write one MADR-style ADR each' },
    { title: 'Write specs', detail: 'one self-contained, self-testing slice spec per unit' },
    { title: 'Critic', detail: 'grounding + completeness pass; write RISKS-AND-GAPS.md' },
    { title: 'Distill', detail: 'emit a citation-free distilled/ mirror for the weaker rebuilder (default on)' },
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
// /src/myapp -> /src/myapp_portkit), NEVER nested inside the input dir — nesting
// pollutes the source tree (untracked files in the source's own repo). The full
// precedence lives in the pure, unit-tested `resolveOutputDir` helper (inside the
// deterministic fence); the only impurity out here is obtaining the cwd.
//
// cwd CHANNEL: the Workflow sandbox exposes no Node API, so process.cwd() usually
// throws here (same disabled bucket as Date.now/Math.random). The /portkit command
// layer DOES have a shell, so it captures `pwd` and passes it as an explicit
// `cfg.cwd` arg — the deterministic channel the sandbox trusts. We prefer that arg
// and fall back to a best-effort process.cwd() only for runtimes that do expose it.
// If NEITHER is available and the input is "." (no absolute parent to derive a
// sibling from), the output dir is unresolvable: we THROW with remediation rather
// than silently writing a wrong `portkit_portkit` tree INSIDE the source.
const OUT = (() => {
  const cwd = cfg.cwd ?? (() => { try { return String(process.cwd()) } catch { return '' } })()
  const { outDir, reason } = resolveOutputDir(cfg, cwd)
  if (outDir === null) throw new Error(`[portkit] ${reason}`)
  return outDir
})()

// ---------------------------------------------------------------------------
// Scale guards. The Workflow runtime caps a run at ~1000 agents total and 4096
// items per parallel/pipeline call. A large repo with per-feature + per-slice +
// per-ADR fan-out can blow that, so we cap each axis and LOG anything we drop
// (silent truncation reads as "complete" when it isn't). Overridable via args.
//
// NOTE: there is deliberately NO cap on total slices/slices. They ARE the
// deliverable — dropping them produces an incomplete recreation kit, which defeats
// the plugin. Genuine over-scale (slice fan-out that would approach the
// ~1000-agent ceiling) is handled by feature-partitioned resumable passes, not by
// discarding slices.
// ---------------------------------------------------------------------------
// `maxFeatures` caps the coarse capability inventory (was `maxEpics`). The legacy name is
// still accepted as an alias — via the parseCliArgs alias table for the CLI-string form, and
// here for the structured-object form — so existing `{ maxEpics: N }` / `--maxEpics N` calls
// keep working after the epic→feature rename.
const MAX_FEATURES = Number(cfg.maxFeatures ?? cfg.maxEpics) || 40
// Architecturally significant decisions get one MADR-style ADR each. Bounded (the
// consumer needs the load-bearing decisions, not an exhaustive archaeology).
const MAX_ADRS = Number(cfg.maxAdrs) || 12
const MAX_GAPFILL_ROUNDS = Number(cfg.maxGapfillRounds) || 2
// DEV/TEST ONLY cost cap. `limitSlices=N` writes only the first N slices (in build
// order) so a live run exercises the ENTIRE pipeline (map → discover → synthesize →
// adrs → write → critic) cheaply. 0 = unlimited = the production default. This is
// deliberately NOT the removed silent `maxSlices` cap: it is opt-in, off by default,
// and reported LOUDLY as a partial/test kit — never presented as a complete
// recreation kit. Pair with a low `maxFeatures` to also cut discovery cost for a smoke test.
const LIMIT_SLICES = Math.max(0, Math.floor(Number(cfg.limitSlices) || 0))

// FRESH run: ignore any checkpoint AND regenerate the kit from scratch. The doc/spec/ADR writers
// normally SKIP an existing non-empty output (so a resume never re-authors it); on a fresh run they
// must OVERWRITE instead, otherwise a re-run over a prior (e.g. smaller/aborted) kit keeps the stale
// docs and yields a Frankenstein. rewriteClause injects the right instruction into each writer.
// DISTILL (ON by default; opt out with `distill: false`): after the critic validates the kit, emit
// a CLEAN mirror under <OUT>/distilled/ with the verified `path:line` source citations stripped —
// the receipts help the generator/critic and a human auditor, but a weaker rebuilder cannot open
// them and is only confused (or led to hallucinate) by them. `[INFERRED]`/`[UNVERIFIED]` flags and
// artifact paths (no line number) are kept. The cited originals stay at the top level as the
// grounding/audit copy. The distilled/ mirror IS the artifact the weaker downstream model rebuilds
// from, so a complete run produces it by default; `distill: false` yields the cited kit only.
const DISTILL = cfg.distill !== false

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
// analysis phase (2 agents per feature), so we process features in batches
// of this size and persist a checkpoint after each batch — an interruption keeps
// every already-analyzed feature instead of reprocessing discovery from scratch.
const CHECKPOINT_EVERY = Math.max(1, Number(cfg.checkpointEvery) || MAX_CONCURRENCY)

// Over-scale guard. Slices are NEVER dropped. When a single run's projected agent
// count would approach the runtime's ~1000-agent ceiling, the expensive write
// phase is partitioned into feature-batched RESUMABLE passes: the synthesized IR is
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
// feature summaries, and LIGHT per-slice metadata (id/name/deps/one-line summary).
// The bulky, high-entropy analysis (each slice's component thread + extracted
// behavioral acceptance criteria) is NOT in the checkpoint: the discovery agents that
// GENERATE it write it to per-feature side-car files under FEATURES_DIR, and the
// write/ACCEPTANCE agents read it back from there. This is deliberate: a model turn
// stalls when forced to REPRODUCE a large exact blob (measured: a ~4KB checkpoint
// persists fine, a ~200KB one hangs the request), but GENERATING content to a file
// works (the doc writers do it). Keeping ir.json small makes persist/load reliable;
// keeping the heavy data in generator-written side-cars keeps it off the model's
// reproduction path entirely.
const IR_OPEN = '<<<PORTKIT-IR-JSON>>>'
const IR_CLOSE = '<<<END-PORTKIT-IR-JSON>>>'
// Per-feature side-car files (heavy analysis), written by the discovery agents
// that generate them and read by the write/ACCEPTANCE agents. Survive across a
// resume (only clearIR, on success, removes them).
const FEATURES_DIR = `${OUT}/.portkit/features`

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
// `slice`/`feature`/`dependsOn`. The OUTPUT layer maps them to user-facing terms:
// a `slice` becomes a per-SLICE spec (specs/<n>-<name>.md) and an `feature` is a
// FEATURE grouping in INDEX.md. Renaming here would churn every tested helper
// for zero behavioral gain, so the mismatch is intentional and documented once.

// slug — filesystem-safe kebab-case, TRUNCATED to 48 chars. pad — zero-pad a build
// number to 4 digits. These live INSIDE the fence because specName() below depends on
// them and specName is the single source of truth for a slice spec's filename.
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'slice'
}
function pad(n) { return String(n).padStart(4, '0') }

// Canonical DISPLAY identifiers — the user-facing ids shown in every kit document. They are
// DETERMINISTIC functions of the JS-owned ordering (a slice's build number n; a feature's
// first-appearance index; an ADR's significance rank), NOT the free-form ids the discovery
// agents emit. The raw agent id stays the internal graph/checkpoint KEY (feature key / slice
// key); these are the labels a reader sees, so specs/INDEX/ADRs never disagree on how a unit
// is named. Kept in the fence beside the filename SoTs and unit-tested identically.
//   sliceId    — SL-<NNNN>   from build order (the primary per-spec identifier)
//   featureId  — FEAT-<NN>   from the feature's first-appearance order in the map (2-digit; FEAT-100+ if >99)
//   adrId      — ADR-<NNNN>  from the decision's significance rank
function sliceId(n) { return `SL-${pad(n)}` }
function featureId(n) { return `FEAT-${String(n).padStart(2, '0')}` }
function adrId(n) { return `ADR-${pad(n)}` }

// specName / adrName — the EXACT basename of a slice spec / ADR file, `<ID>-<slug>.md`
// (e.g. `SL-0001-init-dispatch.md`, `ADR-0005-write-acl-matrix.md`). These are the SINGLE
// SOURCE OF TRUTH for their filenames: the writer (which WRITES the file), the INDEX link
// target, and the distiller ALL derive from them, so a link can never disagree with the file
// on disk. `label` is the unit's TERSE HANDLE — a short kebab descriptor the discovery/ADR
// agents emit alongside the full name/title (which stays the document's H1). slug() lower-cases,
// kebabs, and 48-char-caps it; callers pass `handle || name` so a missing handle degrades to
// the old behavior instead of breaking. The `SL-`/`ADR-` prefix (from sliceId/adrId) makes the
// filename unique regardless of handle collisions, and self-identifying at a glance.
function specName(n, label) { return `${sliceId(n)}-${slug(label)}.md` }
function adrName(n, label) { return `${adrId(n)}-${slug(label)}.md` }

// siblingOutDir — the default output location for a given input dir: a SIBLING
// named "<input>_portkit", never nested inside the input. Pure (cwd is passed in,
// not read) so the "." case is deterministically testable.
//   - input carries a parent path -> derive directly, preserving its form:
//       "path/to/project"  -> "path/to/project_portkit"
//       "/src/myapp"        -> "/src/myapp_portkit"
//       "myapp"             -> "myapp_portkit"   (sibling in the same cwd)
//   - "." / "" (the cwd itself) -> resolve against cwd -> "<cwd>_portkit"
//       (an ABSOLUTE sibling when cwd is known).
//   - "." / "" with cwd unknown -> last-resort bare "portkit_portkit". This is the
//       ONLY case that would nest; the /portkit command avoids it by resolving an
//       absolute input path before invoking the workflow.
// Leading "./" is stripped so a "./project" input yields "project_portkit".
function siblingOutDir(inputDir, cwd) {
  const base = String(inputDir == null ? '' : inputDir).replace(/\/+$/, '')
  if (base === '' || base === '.') {
    const c = String(cwd == null ? '' : cwd).replace(/\/+$/, '')
    return c ? `${c}_portkit` : 'portkit_portkit'
  }
  return `${base}_portkit`.replace(/^\.\//, '')
}

// resolveOutputDir — the SINGLE precedence for a run's output directory. Pure (cwd
// is passed in, never read here), so it is unit-tested exactly like siblingOutDir,
// and it cannot throw at region-eval time. Returns `{ outDir, reason }`:
//   1. explicit cfg.outputDir || cfg.outDir            -> return it verbatim.
//   2. else the SIBLING of the input (siblingOutDir).
//   3. UNRESOLVABLE — input is "." / "" (i.e. "the cwd") AND cwd is empty — there is
//      no absolute parent to hang a sibling off, so return `{ outDir: null, reason }`
//      INSTEAD of siblingOutDir's `portkit_portkit` sentinel. The impure caller turns
//      that null into a loud throw, so we never silently nest a wrong tree inside the
//      source. (siblingOutDir keeps the sentinel as its raw last resort; it is simply
//      unreachable through this precedence.)
function resolveOutputDir(cfg, cwd) {
  const c = cfg || {}
  const explicit = c.outputDir || c.outDir
  if (explicit) return { outDir: String(explicit), reason: '' }
  const source = c.inputDir || c.sourcePath || '.'
  const base = String(source).replace(/\/+$/, '')
  const cwdStr = String(cwd == null ? '' : cwd).replace(/\/+$/, '')
  if ((base === '' || base === '.') && cwdStr === '') {
    return {
      outDir: null,
      reason: "cannot resolve an output directory: input is '.' and no cwd is available — pass an absolute inputDir, an explicit outputDir, or a cwd arg",
    }
  }
  return { outDir: siblingOutDir(source, cwd), reason: '' }
}

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
// tuning knobs like --maxFeatures still work. A bare --flag with no value becomes `true`.
function parseCliArgs(s) {
  const alias = {
    input: 'inputDir', inputdir: 'inputDir',
    output: 'outputDir', outputdir: 'outputDir', out: 'outputDir', outdir: 'outputDir',
    maxepics: 'maxFeatures', // legacy alias: --maxEpics still caps the feature inventory
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

// buildFeatureTree — group slices into an feature->slices tree, preserving first-
// appearance order of both features and slices (deterministic). Returns
// [{ featureKey, sliceIds: [id…] }…]. Slices with no featureKey are grouped under null.
function buildFeatureTree(slices) {
  const tree = new Map() // featureKey -> [sliceKey…]
  for (const s of slices) {
    const e = s.featureKey ?? null
    if (!tree.has(e)) tree.set(e, [])
    tree.get(e).push(s.id)
  }
  return Array.from(tree, ([featureKey, sliceIds]) => ({ featureKey, sliceIds }))
}

// projectAgents — estimate the total agent() calls a single full run would make,
// to decide whether to partition the write phase (the runtime caps a run at ~1000
// agents). Mirrors the actual fan-out: preflight + map + 2/feature (discover+behavior)
// + synthesize + index + acceptance + architecture + prd + adr:discover + 1/slice
// (write) + min(adrCount, maxAdrs) (adr writers) + critic (1 + gapfill rounds).
// Deliberately an upper-ish estimate; the per-gap fixers are unpredictable so they
// are folded into the gapfill term. The checkpoint agents (one loadIR at startup +
// a persist per stage/discovery-batch + one clearIR at the end) are deliberately NOT
// modeled here: they are a small constant the SAFE_BUDGET safety factor absorbs, and
// counting them would only make the over-scale guard trip slightly earlier.
function projectAgents({ featureCount = 0, sliceCount = 0, adrCount = 0, maxAdrs = 0, gapfillRounds = 0 } = {}) {
  // preflight, map, synthesize, index, acceptance, architecture, prd, adr:discover, critic(base)
  const fixed = 9
  const discovery = 2 * featureCount
  const writes = sliceCount
  const adrs = Math.min(adrCount, maxAdrs)
  return fixed + discovery + writes + adrs + gapfillRounds
}

// planFeatureBatches — partition features into ordered write batches so each batch's
// total slice count stays within `perBatch`, WITHOUT splitting an feature across
// batches (partition-by-feature). A single feature larger than `perBatch` becomes its
// own batch (we never split or drop slices — an over-budget batch is acceptable;
// a dropped slice is not). Returns [{ featureKeys:[…], sliceIds:[…] }…]; an featureKey of
// null is preserved as-is. With a non-positive limit, every feature is its own batch.
// (Param is `perBatch`, not `budget` — `budget` is a reserved runtime global.)
function planFeatureBatches(featureTree, perBatch) {
  const limit = perBatch > 0 ? perBatch : 1
  const batches = []
  let cur = null
  for (const { featureKey, sliceIds } of featureTree) {
    const size = sliceIds.length
    if (!cur) { cur = { featureKeys: [featureKey], sliceIds: [...sliceIds] }; continue }
    if (cur.sliceIds.length + size > limit && cur.sliceIds.length > 0) {
      batches.push(cur)
      cur = { featureKeys: [featureKey], sliceIds: [...sliceIds] }
    } else {
      cur.featureKeys.push(featureKey)
      cur.sliceIds.push(...sliceIds)
    }
  }
  if (cur) batches.push(cur)
  return batches
}

// STAGES — the linear checkpoint ladder the workflow advances through, persisted in
// the IR as `stage`. A resume skips every stage whose work is already done. The
// intermediate 'discovering' marks a PARTIALLY complete discovery phase (some
// features analyzed, more to go), so it sits between 'mapped' and 'discovered'.
// 'critiqued' and 'distilled' are the terminal stages (Critic + the default-on Distill
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
// feature discovery so each batch can checkpoint). A non-positive size yields a
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

// planResume — PURE. Decide, from the per-feature side-car scan, what each feature
// needs on RESUME. The analyzed source is STATIC, so its slice decomposition is a FIXED
// target: a feature's slice STRUCTURE (light.json) is a deterministic function of the
// source and, once written, DURABLE — it must be RELOADED, never re-discovered. Re-running
// discovery would produce a different slice set and RENUMBER every downstream spec, turning
// a resume into a duplicate rewrite (the exact bug this guards against). behavior.json is a
// DOWNSTREAM artifact (test-derived acceptance criteria); when it ALONE is missing we re-run
// ONLY the behavior agent against the reloaded slices — structure and numbering untouched.
// Returns { reload, behaviorOnly, discover } as feature-id arrays in `features` order:
//   - reload:       has light.json                  -> reload slices (structure is fixed)
//   - behaviorOnly: reload ∩ missing behavior.json  -> behavior re-run only (no re-discovery)
//   - discover:     no light.json                   -> full discovery (never analyzed yet)
function planResume(features, scan) {
  // Side-car filenames are slug-lowercased (slicesCarPath -> slug(featureKey)), so the resume-scan
  // agent reports lowercase ids ("cap-init") while checkpoint feature ids are uppercase ("CAP-INIT").
  // Match case-insensitively so resume actually reloads durable side-cars instead of dropping every
  // feature into re-discovery (which, past the 'discovered' stage, yieldszero slices).
  const norm = x => String(x || '').toLowerCase()
  const byId = new Map((scan || []).map(e => [e && norm(e.id), e]))
  const reload = [], behaviorOnly = [], discover = []
  for (const e of (features || [])) {
    const s = byId.get(norm(e.id))
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
// the first N slice specs (in build order), and `maxFeatures` analyzes only the first M features.
// Those omissions are BY DESIGN and are reported LOUDLY as a PARTIAL test kit — they are NOT defects.
// This builds the scope caveat prepended to the critic + gap-fix prompts so the gap-fill loop never
// "repairs" a deliberate truncation by regenerating the omitted specs (or reverse-engineering a
// dropped feature straight from source) — which would silently convert a partial test kit into a
// claimed-complete one, contradicting the run's own testLimited/slicesOmittedForTest report. Returns
// '' when NOTHING was intentionally omitted, so a full/unlimited run's prompts stay byte-identical.
function omissionScopeNote({ slicesOmittedForTest = 0, limitSlices = 0, featuresKept = 0, featuresTotal = 0 } = {}) {
  const parts = []
  if (slicesOmittedForTest > 0) {
    parts.push(`${slicesOmittedForTest} slice spec(s) were INTENTIONALLY omitted (limitSlices=${limitSlices}: only the first ${limitSlices} slice(s) in build order were written)`)
  }
  if (featuresTotal > featuresKept) {
    parts.push(`${featuresTotal - featuresKept} feature(ies) were INTENTIONALLY dropped (maxFeatures cap: only ${featuresKept} of ${featuresTotal} discovered feature(ies) were analyzed)`)
  }
  if (parts.length === 0) return ''
  return `INTENTIONAL TEST-SCOPE LIMITS — READ THIS FIRST: this is a deliberately PARTIAL test kit, NOT a complete recreation kit. ` +
    `${parts.join('; ')}. These omissions are BY DESIGN, not defects. Audit ONLY the slices and features actually present in the kit. ` +
    `Do NOT report an intentionally-omitted slice or feature as a "missing piece" or gap, do NOT mark such a gap fixable, and do NOT ` +
    `(and any fix agent MUST NOT) regenerate, back-fill, or reverse-engineer the omitted slice specs or features. A dependsOn that ` +
    `points at an intentionally-omitted slice is expected and MUST NOT be flagged. Editing INDEX/ACCEPTANCE to claim the full slice ` +
    `set is present is FORBIDDEN — the partial scope must remain accurately reported.`
}

// DOC_STRUCTURE — PURE data. The required SHAPE of every kit document keyed by docType: the
// frontmatter fields its metadata header must carry, and the `##` section headings it must contain
// IN ORDER. This is the machine-checkable projection of the prose skeletons (SLICE_SPEC_TEMPLATE,
// ADR_TEMPLATE, … which live OUTSIDE the fence). The two are kept in lockstep by a drift-guard test
// that asserts every field/heading here also appears in its template constant. Glossary has no `##`
// sections (it is a fixed term table), so only its frontmatter is checkable here.
const DOC_STRUCTURE = {
  'slice-spec': {
    frontmatter: ['Slice ID', 'Build #', 'Feature', 'Status', 'Depends on'],
    headings: ['Summary', 'Behavior Thread', 'Interface & Contract', 'Acceptance Criteria', 'Build Steps', 'Shared Conventions'],
  },
  adr: {
    frontmatter: ['ADR ID', 'Status'],
    headings: ['Context & Problem', 'Decision Drivers', 'Considered Options', 'Decision Outcome', 'Consequences', 'Rationale'],
  },
  prd: {
    frontmatter: ['Status'],
    headings: ['Overview', 'Goals', 'Non-Goals', 'Success Metrics', 'Users & Personas', 'Functional Requirements', 'Constraints & Assumptions'],
  },
  architecture: {
    frontmatter: ['Status'],
    headings: ['Tech Stack & Build/Test', 'Component Inventory', 'Data Model & Vocabulary', 'Data Flows', 'Cross-Cutting Concerns'],
  },
  index: {
    frontmatter: [],
    headings: ['Features & Slices', 'Recommended Build Order', 'Merged Slices'],
  },
  acceptance: {
    frontmatter: [],
    headings: ['Coverage Summary', 'Acceptance Criteria by Feature'],
  },
  glossary: {
    frontmatter: ['Status'],
    headings: [],
  },
}
// docStructure — PURE accessor so tests (which eval only this fenced region) can read the table.
function docStructure() { return DOC_STRUCTURE }

// checkDocStructure — PURE. Given a docType and the structure a reader EXTRACTED from one generated
// document ({ frontmatterKeys, headings, path }), return the conformance violations against
// DOC_STRUCTURE. Three kinds: a required `**Field:**` absent from the metadata header
// (`missing-frontmatter`), a required `## Section` absent (`missing-heading`), or the required
// sections present but out of the mandated order (`section-order`). Extra/unknown headings are NOT
// flagged — content legitimately varies. An unknown docType returns [] (nothing to check). Inputs are
// normalized (strip `*`/`#`/trailing `:`, trim) so the reader need not report them pre-cleaned.
function checkDocStructure(docType, doc) {
  const spec = DOC_STRUCTURE[docType]
  if (!spec) return []
  const d = doc || {}
  const path = d.path || ''
  const normFm = s => String(s == null ? '' : s).replace(/\*/g, '').replace(/:\s*$/, '').trim()
  const normH = s => String(s == null ? '' : s).replace(/^#+\s*/, '').trim()
  const fmGot = new Set((d.frontmatterKeys || []).map(normFm).filter(Boolean))
  const headGot = (d.headings || []).map(normH).filter(Boolean)
  const headSet = new Set(headGot)
  const violations = []
  for (const key of spec.frontmatter) {
    if (!fmGot.has(key)) violations.push({ docType, path, kind: 'missing-frontmatter', detail: `missing metadata field \`**${key}:**\`` })
  }
  for (const h of spec.headings) {
    if (!headSet.has(h)) violations.push({ docType, path, kind: 'missing-heading', detail: `missing required section \`## ${h}\`` })
  }
  // Order check runs only over the required headings that ARE present (missing ones are already
  // reported): their positions in the actual document must be strictly increasing.
  const present = spec.headings.filter(h => headSet.has(h))
  let last = -1, outOfOrder = false
  for (const h of present) {
    const idx = headGot.indexOf(h)
    if (idx <= last) { outOfOrder = true; break }
    last = idx
  }
  if (present.length > 1 && outOfOrder) {
    violations.push({ docType, path, kind: 'section-order', detail: `sections out of order; required order: ${spec.headings.map(h => `## ${h}`).join(' → ')}` })
  }
  return violations
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
// House style + document skeletons. These live OUTSIDE the <portkit:deterministic> fence: they
// are prose constants, not pure data helpers, and a template that happened to contain a fenced-
// banned token (e.g. "budget") would trip the purity gate. They are the SINGLE SOURCE OF TRUTH
// for how every kit document is shaped, so the whole family reads as one seasoned author wrote it
// (the user's ask: kill the per-writer variance in sections/formatting/ids). Each writer injects
// HOUSE_STYLE + its skeleton and is told to fill the EXACT headings verbatim. Guarded by source-grep
// tests (the consts live outside the fence, so loadDeterministic() can't see them).
// ---------------------------------------------------------------------------
const HOUSE_STYLE =
  'HOUSE STYLE (mandatory — every kit document obeys this so the whole kit reads as one author):\n' +
  '- Vocabulary: use ONLY "Feature", "Slice", and "ADR". A FEATURE is a coarse, externally-observable ' +
  'area of the system; a SLICE is one fine, independently-buildable behavior thread within a feature. ' +
  'NEVER write the words "epic", "capability", or "vertical thread" in output prose.\n' +
  '- Identifiers: reference every unit by the canonical id you are GIVEN, VERBATIM — Slice `SL-NNNN`, ' +
  'Feature `FEAT-NN`, ADR `ADR-NNNN`. Never invent, renumber, re-case, or reformat an id.\n' +
  '- Structure: reproduce the section skeleton EXACTLY — every heading, at its given level, in the ' +
  'given order. Do NOT add, rename, reorder, merge, or drop a heading. An empty section keeps its ' +
  'heading with `None observed.` (or `[INFERRED] none observable` for an intent section).\n' +
  '- Open with the metadata header block exactly as specified, fields in the given order.\n' +
  '- Voice: a senior engineer writing a precise, prescriptive spec — neutral, exact, no filler, no ' +
  'marketing, no emojis. One `#` H1; sections are `##`; ids, paths, and types in `backticks`.'

// The per-SLICE spec — the load-bearing, fanned-out document. Exact headings; {…} are filled from data.
const SLICE_SPEC_TEMPLATE =
  'SECTION SKELETON — reproduce these headings EXACTLY and in this order:\n\n' +
  '# {sliceId}: {name}\n\n' +
  '**Slice ID:** {sliceId}\n' +
  '**Build #:** {n}\n' +
  '**Feature:** {feature}\n' +
  '**Status:** Reconstructed\n' +
  '**Depends on:** {dependsOn — a list of Slice IDs, or "None"}\n\n' +
  '## Summary\n' +
  'One-line observable behavior this slice delivers.\n\n' +
  '## Behavior Thread\n' +
  'The end-to-end thread, each component with its source `path:line` (from the side-car), in execution order.\n\n' +
  '## Interface & Contract\n' +
  'Inputs, outputs, and EXACT behavior — every error, edge case, and ordering guarantee.\n\n' +
  '## Acceptance Criteria\n' +
  'The concrete, runnable-in-spirit checks from the behavior side-car; state coverage good/thin/none.\n\n' +
  '## Build Steps\n' +
  'Function/unit-sized steps, each individually checkable.\n\n' +
  '## Shared Conventions\n' +
  'Reference `ARCHITECTURE.md` for shared names/types/cross-cutting rules — do NOT restate them, and ' +
  'do NOT depend on any other slice\'s internals.'

const ARCHITECTURE_TEMPLATE =
  'SECTION SKELETON — reproduce these headings EXACTLY and in this order:\n\n' +
  '# Architecture\n\n' +
  '**Status:** Reconstructed\n\n' +
  '## Tech Stack & Build/Test\n' +
  'Languages, build system, test framework(s), where tests live, dependency manifests.\n\n' +
  '## Component Inventory\n' +
  'The internal building blocks and their responsibilities.\n\n' +
  '## Data Model & Vocabulary\n' +
  'Core types/entities and a naming glossary of shared names the slices rely on.\n\n' +
  '## Data Flows\n' +
  'For each feature (by `FEAT-NN`), how a request/event moves through the components.\n\n' +
  '## Cross-Cutting Concerns\n' +
  'Auth, config, logging, error handling, concurrency — stated as RULES the slices obey.'

const PRD_TEMPLATE =
  'SECTION SKELETON — reproduce these headings EXACTLY and in this order:\n\n' +
  '# Product Requirements\n\n' +
  '**Status:** Reconstructed\n\n' +
  '## Overview\n' +
  'What the software does and the problem it appears to solve.\n\n' +
  '## Goals\n`[INFERRED]` outcomes the software seems built to achieve.\n\n' +
  '## Non-Goals\n`[INFERRED]` from what it deliberately does NOT do.\n\n' +
  '## Success Metrics\n`[INFERRED]` — never fabricate numbers; `[INFERRED] none observable` if unclear.\n\n' +
  '## Users & Personas\n`[INFERRED]` who the observable interfaces serve.\n\n' +
  '## Functional Requirements\n' +
  'One grounded bullet per feature (by `FEAT-NN`), each citing `path:line`.\n\n' +
  '## Constraints & Assumptions\n' +
  'Observed constraints and the assumptions this reconstruction rests on.'

const ADR_TEMPLATE =
  'SECTION SKELETON — reproduce these headings EXACTLY and in this order:\n\n' +
  '# {adrId}: {title}\n\n' +
  '**ADR ID:** {adrId}\n' +
  '**Status:** Reconstructed\n\n' +
  '## Context & Problem\n' +
  'The observed situation the decision addresses — cite `path:line`.\n\n' +
  '## Decision Drivers\n' +
  'The forces that shaped the decision.\n\n' +
  '## Considered Options\n' +
  'The chosen option (grounded) and plausible rejected alternatives (`[INFERRED]`).\n\n' +
  '## Decision Outcome\n' +
  'What the source actually does — cite the EVIDENCE.\n\n' +
  '## Consequences\n' +
  'The resulting trade-offs a rebuilder inherits.\n\n' +
  '## Rationale\n`[INFERRED]` — the source rarely states why; do not present a guess as fact.'

const INDEX_TEMPLATE =
  'SECTION SKELETON — reproduce these headings EXACTLY and in this order:\n\n' +
  '# Recreation Index\n\n' +
  '## Features & Slices\n' +
  'A tree grouped by feature in the given order: each feature as `FEAT-NN <name>`, then its slices as ' +
  '`SL-NNNN <name>` each linked to its exact `spec` path.\n\n' +
  '## Recommended Build Order\n' +
  'A numbered list (#1 first); each entry: `SL-NNNN`, name, its feature `FEAT-NN`, and its `Depends on` Slice IDs.\n\n' +
  '## Merged Slices\n' +
  'Any slice whose `mergedFrom` is non-empty (it absorbed duplicates); `None` if there were none.'

const ACCEPTANCE_TEMPLATE =
  'SECTION SKELETON — reproduce these headings EXACTLY and in this order:\n\n' +
  '# Acceptance Criteria\n\n' +
  '## Coverage Summary\n' +
  'A table with columns in THIS order: `Feature (FEAT-NN) | Slice | Coverage (good/thin/none)`. ' +
  'Feature FIRST, Slice SECOND. For the Slice cell, use the slice\'s full `sliceLabel` (the ' +
  '`SL-NNNN-<slug>` spec-file form, e.g. `SL-0003-token-refresh`) transcribed VERBATIM — do NOT ' +
  'shorten it to the bare `SL-NNNN` and do NOT re-slugify the name. LOUDLY flag every thin/none ' +
  'slice as a rebuild risk.\n\n' +
  '## Acceptance Criteria by Feature\n' +
  'Grouped by feature (`FEAT-NN`); for each slice (`SL-NNNN`) its criteria with source test `path:line` refs.'

const GLOSSARY_TEMPLATE =
  'Write a GLOSSARY that defines, in a two-column Markdown table `| Term | Definition |`, EXACTLY these ' +
  'terms in this order — copy the definitions faithfully (this is the kit\'s canonical vocabulary; do ' +
  'not invent, drop, or reorder terms):\n\n' +
  '# Glossary\n\n' +
  '**Status:** Reconstructed\n\n' +
  '| Term | Definition |\n|---|---|\n' +
  '| **Feature** | A coarse, externally-observable area of the system (an endpoint group, CLI command, public API surface, event/job, or UI flow). The grouping level. |\n' +
  '| **Feature ID** | `FEAT-NN` — the canonical id of a feature, from its order in the recreation index. |\n' +
  '| **Slice** | One fine vertical behavior thread within a feature, independently buildable and testable end-to-end. The unit a spec documents. |\n' +
  '| **Slice ID** | `SL-NNNN` — the canonical id of a slice, from its build order. The only slice identifier used in the kit. |\n' +
  '| **Build number** | A slice\'s 1-based position in the recommended build order; the `NNNN` in its Slice ID and spec filename. |\n' +
  '| **Depends on** | The prerequisite slices a slice needs built first, listed by Slice ID. |\n' +
  '| **Acceptance criteria** | Concrete, language-neutral checks that verify a slice, derived from the source\'s tests. |\n' +
  '| **Coverage** | `good` / `thin` / `none` — how well the source\'s tests exercise a slice. |\n' +
  '| **ADR** | Architecture Decision Record — one significant, evidence-backed design decision. |\n' +
  '| **ADR ID** | `ADR-NNNN` — the canonical id of an ADR. |\n' +
  '| **Reconstructed** | Marks a document reverse-engineered from observed behavior, not an original artifact. |\n' +
  '| **`[INFERRED]`** | An intent statement (goal, metric, rationale) guessed from behavior, not observed as fact. |\n' +
  '| **`[UNVERIFIED]`** | A claim that could not be grounded in the source. |'

// ---------------------------------------------------------------------------
// Schemas (small, required-tight)
// ---------------------------------------------------------------------------
const SYSTEM_MAP = {
  type: 'object',
  required: ['features'],
  properties: {
    languages: { type: 'array', items: { type: 'string' } },
    buildSystem: { type: 'string' },
    testFrameworks: { type: 'array', items: { type: 'string' } },
    testPaths: { type: 'array', items: { type: 'string' } },
    dependencyManifests: { type: 'array', items: { type: 'string' } },
    features: {
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
        required: ['id', 'name', 'handle', 'summary'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          handle: { type: 'string', description: 'a TERSE 2-4 word kebab-case descriptor for the filename, e.g. "init-dispatch", "index-bootstrap", "json-flag-parse" — an action/subject handle, NOT a sentence' },
          summary: { type: 'string', description: 'the observable behavior this slice delivers' },
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
        required: ['sliceKey', 'coverage'],
        properties: {
          sliceKey: { type: 'string' },
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
        required: ['id', 'title', 'handle', 'evidence'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string', description: 'the decision, e.g. "Optimistic locking for account updates"' },
          handle: { type: 'string', description: 'a TERSE 2-4 word kebab-case descriptor for the filename, e.g. "optimistic-locking", "two-file-persistence", "write-acl-matrix" — NOT the full title sentence' },
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
          kind: { type: 'string', description: 'unresolved-citation | thin-coverage | inference-as-fact | not-self-contained | malformed-structure | missing | other' },
          detail: { type: 'string' },
          where: { type: 'string', description: 'doc path or slice id' },
          fixable: { type: 'boolean', description: 'can an agent fix this without human input?' },
        },
      },
    },
    // Per-document structure the critic EXTRACTED, fed to the deterministic checkDocStructure() check.
    docStructures: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'docType'],
        properties: {
          path: { type: 'string', description: 'the doc path under OUT' },
          docType: { type: 'string', description: 'slice-spec | adr | prd | architecture | index | acceptance | glossary' },
          frontmatterKeys: { type: 'array', items: { type: 'string' }, description: 'the `**Key:**` metadata labels present, key text only' },
          headings: { type: 'array', items: { type: 'string' }, description: 'the `##` section titles WITHOUT `##`, in document order' },
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
    features: { type: 'array', items: {}, description: 'the mapped feature inventory (after the maxFeatures cap)' },
    featuresTotal: { type: 'number', description: 'features discovered BEFORE the maxFeatures cap — lets the critic report an intentional maxFeatures drop as out-of-scope on resume' },
    featuresDone: { type: 'array', items: { type: 'string' }, description: 'ids of features whose discovery finished (slice data lives in side-cars, not here)' },
    merges: { type: 'array', items: {}, description: 'dedup merge groups (the build order is recomputed from these + the light slices)' },
    adrs: { type: 'array', items: {}, description: 'discovered decisions (authored once)' },
    slicesDiscovered: { type: 'number' },
    slicesOmittedForTest: { type: 'number' },
    scale: { type: 'object', description: 'the run\'s scale knobs {maxFeatures, limitSlices} — resume aborts on a mismatch' },
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
// Slice specs live flat under specs/ with global build-order numbering; the
// feature grouping (was features/<feature>/) lives in INDEX.md instead.
function sliceDocPath(s) { return `${OUT}/${specRelPath(s)}` }
// specRelPath — the spec path RELATIVE to OUT (`specs/<NNNN>-<slug>.md`). Used both to
// build sliceDocPath (the absolute write target) and as the exact INDEX link target, so
// the two can never diverge. Derives from specName (the single source of truth).
function specRelPath(s) { return `specs/${specName(s.n, s.handle || s.name)}` }

// Per-feature side-car paths (heavy analysis kept off the checkpoint). One file
// per feature per kind, each written by the agent that GENERATES it (discovery →
// slices+thread; behavior → acceptance criteria) and read back by the slice-spec
// and ACCEPTANCE writers. Keyed by slug(featureKey) so the path is filesystem-safe.
function slicesCarPath(featureKey) { return `${FEATURES_DIR}/${slug(featureKey)}.slices.json` }
function behaviorCarPath(featureKey) { return `${FEATURES_DIR}/${slug(featureKey)}.behavior.json` }
// LIGHT per-feature projection (id/name/summary/behaviorSummary/dependsOn — no
// thread, no criteria). Small enough to reload one feature at a time on resume
// without a large-string reproduction, so the orchestrator can rebuild its in-memory
// slice list from artifacts instead of carrying it in the (size-capped) checkpoint.
function lightCarPath(featureKey) { return `${FEATURES_DIR}/${slug(featureKey)}.light.json` }

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

// discoveryIncomplete — one or more feature-discovery agents DIED this turn (agent() returned
// null → filtered out of perFeatureDone), leaving NO side-cars for those features. Advancing
// would synthesize, write, and finalize an INCOMPLETE kit and then clearIR() — silently
// dropping the failed features AND destroying the only resume trail (the reported symptom).
// Instead we STOP here with the checkpoint INTACT at 'discovering' (its last saveStage recorded
// the successes): finalize()/clearIR() never run, so a plain re-run auto-resumes and
// re-discovers ONLY the missing features (structure/numbering of the done ones is preserved).
//   - progressed (≥1 feature discovered this turn) → resumeRequired:true so the /portkit command
//     auto-re-invokes and retries the (usually transient) deaths.
//   - no progress this turn → resumeRequired:false: a hard stop that avoids an infinite
//     auto-resume loop when a feature fails deterministically. The checkpoint is STILL kept, so
//     a manual re-run resumes; a human just gets to look first.
function discoveryIncomplete(failed, discoveredCount, progressed) {
  const ids = failed.map(f => f.id)
  const err = `Discovery INCOMPLETE: ${failed.length} feature(s) failed to analyze (agent died) — ` +
    `${ids.join(', ')}. The kit was NOT finalized and the checkpoint at \`${IR_PATH}\` was KEPT. ` +
    (progressed
      ? `Re-run (or /loop) with { resume: true } pointed at outputDir "${OUT}" to re-discover them.`
      : `NO features were analyzed this pass — investigate before re-running; a plain re-run with ` +
        `{ resume: true } pointed at outputDir "${OUT}" will resume from the checkpoint.`)
  log(`⛔ ${err}`); dropped.push(err)
  return {
    ok: false, outDir: OUT, resumeRequired: progressed, stage: 'discovering',
    error: err,
    failedFeatures: ids,
    resumeArgs: { resume: true, outputDir: OUT },
    counts: { featuresDiscovered: discoveredCount, featuresFailed: failed.length },
    truncations: dropped,
  }
}

// docsIncomplete — the doc family is missing ≥1 document even AFTER an in-run retry (a writer agent
// kept dying or leaving no file). Do NOT checkpoint 'docs' — that would let a resume SKIP the stage
// and never regenerate the missing document (the reported bug) — and do NOT finalize/clear. Stop
// with the checkpoint kept at 'synthesized'; a plain re-run re-authors the whole (idempotent) doc
// family. resumeRequired:false: we already retried in-run, so we do NOT auto-loop — a human sees the
// named missing document and re-runs (which resumes from the kept checkpoint).
function docsIncomplete(missing) {
  const err = `Doc family INCOMPLETE: ${missing.length} document(s) still missing after a retry — ${missing.join(', ')}. ` +
    `The 'docs' stage was NOT checkpointed and \`${IR_PATH}\` was KEPT; re-run with { resume: true } pointed at ` +
    `outputDir "${OUT}" to re-author the doc family.`
  log(`⛔ ${err}`); dropped.push(err)
  return {
    ok: false, outDir: OUT, resumeRequired: false, stage: 'docs',
    error: err, missingDocs: missing,
    resumeArgs: { resume: true, outputDir: OUT },
    counts: {},
    truncations: dropped,
  }
}

// adrsIncomplete — same guard as docsIncomplete, for the ADR stage: ≥1 ADR file is still absent
// after an in-run retry (a writer agent kept dying). Do NOT checkpoint 'adrs' (a resume would skip
// ADR writing and never regenerate the missing record) and do NOT finalize. Stop with the
// checkpoint kept at 'docs'; a re-run re-discovers + re-authors the ADRs. resumeRequired:false —
// already retried in-run, so no auto-loop; a human sees the named missing ADR and re-runs.
function adrsIncomplete(missing) {
  const err = `ADRs INCOMPLETE: ${missing.length} record(s) still missing after a retry — ${missing.join(', ')}. ` +
    `The 'adrs' stage was NOT checkpointed and \`${IR_PATH}\` was KEPT; re-run with { resume: true } pointed at ` +
    `outputDir "${OUT}" to re-author the ADR(s).`
  log(`⛔ ${err}`); dropped.push(err)
  return {
    ok: false, outDir: OUT, resumeRequired: false, stage: 'adrs',
    error: err, missingAdrs: missing,
    resumeArgs: { resume: true, outputDir: OUT },
    counts: {},
    truncations: dropped,
  }
}

async function writeSliceDocs(sliceList) {
  const written = await pooled(sliceList.map((s) => () => {
    const path = sliceDocPath(s)
    // Canonical DISPLAY fields (JS-owned) the writer transcribes VERBATIM into the metadata header.
    // The raw key `s.id` stays internal (used only to look up the side-car entries below).
    const deps = renderDeps(s.dependsOn)
    const ctx = {
      sliceId: sliceId(s.n), name: s.name, buildNumber: s.n,
      feature: featureRef(s.featureKey) || 'None',
      dependsOn: deps.length ? deps : ['None'],
      summary: s.summary, behaviorSummary: s.behaviorSummary,
    }
    return agent(
      `You are the PortKit SLICE-SPEC writer. Write ONE self-contained slice spec to \`${path}\`.\n\n` +
      `${FRESH ? rewriteClause(path) : `FIRST: if \`${path}\` already exists and is non-empty, a prior pass already wrote it — do NOT rewrite it; ` +
      `return \`{ "path": "${path}", "ok": true, "selfContained": true }\` immediately (its durable output stands).`}\n\n` +
      `This slice's heavy analysis is in two side-car files — READ them and pull out ONLY the entry whose ` +
      `key is \`${s.id}\`:\n` +
      `- Component thread: the entry with \`id == "${s.id}"\` in \`${slicesCarPath(s.featureKey)}\` (its \`thread\`).\n` +
      `- Acceptance criteria: the entry with \`sliceKey == "${s.id}"\` in \`${behaviorCarPath(s.featureKey)}\` ` +
      `(\`acceptanceCriteria\`, \`testRefs\`, \`coverage\`). If that file or entry is missing, say coverage is ` +
      `none — do NOT invent criteria.\n\n` +
      `The spec must let a LESS CAPABLE local model rebuild this slice from this spec + ARCHITECTURE.md ALONE, ` +
      `without the source. Re-read the cited source as needed to be exact. Source root: \`${SOURCE}\`.\n\n` +
      `${HOUSE_STYLE}\n\n${SLICE_SPEC_TEMPLATE}\n\n` +
      `Fill the skeleton from this data (metadata fields are AUTHORITATIVE — transcribe the ids VERBATIM, ` +
      `do NOT alter them):\nSLICE DATA:\n${JSON.stringify(ctx, null, 2)}\n\n${GROUND_RULE}\n\n` +
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
// at least { id, name, feature }; a feature with no slices needs no behavior side-car.
async function runBehaviorSpec(featureKey, slices, sysFacts) {
  const ids = (slices || []).map(s => ({ id: s.id, name: s.name, summary: s.summary }))
  if (ids.length === 0) return
  await agent(
    `You are the PortKit BEHAVIOR-SPEC agent. The source's existing tests are the behavioral contract.\n\n` +
    `Source root: \`${SOURCE}\`. Test setup: ${sysFacts}\n\n` +
    `For each slice below, find the source tests that exercise it and translate them into LANGUAGE-NEUTRAL ` +
    `acceptance criteria (concrete enough that a weak model can self-check its rebuild). Cite each source test ` +
    `as \`path:line\`. Rate coverage good/thin/none. FLAG thin/none LOUDLY — never paper over missing coverage.\n\n` +
    `WRITE the result as JSON \`{ "perSlice": [ { "sliceKey", "coverage", "acceptanceCriteria": [...], "testRefs": [...] } ] }\` ` +
    `to \`${behaviorCarPath(featureKey)}\` (create parent directories first). This side-car is read later by the ` +
    `ACCEPTANCE and slice-spec writers — write the file, do not just return.\n\n` +
    `SLICES:\n${JSON.stringify(ids, null, 2)}\n\n${GROUND_RULE}\n\nReturn perSlice behavioral specs.`,
    { schema: BEHAVIOR, phase: 'Discover slices', label: `behavior:${featureKey}` }
  )
}

// Discover ONE feature end-to-end: trace it into fine vertical slices (slices),
// then extract each slice's behavioral acceptance spec from the test suite. Returns
// { featureKey, slices } — or null if the discovery agent itself failed, so a failed
// feature is retried on the next resume rather than silently lost. A feature that
// legitimately has no slices returns { featureKey, slices: [] } (done, not retried).
async function discoverFeature(feature, sysFacts) {
  const r = await agent(
    `You are the PortKit SLICE-DISCOVERY agent for ONE feature of the source at \`${SOURCE}\`.\n\n` +
    `FEATURE: ${JSON.stringify(feature)}\n\n` +
    `Trace this feature END-TO-END through every layer it touches (entry → validation → business rule → ` +
    `data model → persistence → response/side-effects). Decompose it into fine, FUNCTION/UNIT-SIZED VERTICAL ` +
    `SLICES — each an independently buildable & testable thread. For each slice give: a stable id (prefix with ` +
    `the feature id), name, a TERSE 2-4 word kebab-case \`handle\` (used for the filename — an action/subject ` +
    `descriptor like "init-dispatch" or "json-flag-parse", NOT a sentence), the observable behavior, the \`thread\` ` +
    `(components touched, each with a \`path:line\` citation), a precise behaviorSummary, and dependsOn (other slice ` +
    `ids it needs first).\n\n` +
    `Then WRITE two side-car files (create parent directories first with \`mkdir -p\`):\n` +
    `1. \`${slicesCarPath(feature.id)}\` — the FULL slices array (every field, INCLUDING each slice's \`thread\`). ` +
    `This is the slice-spec writer's source for the component thread.\n` +
    `2. \`${lightCarPath(feature.id)}\` — a LIGHT projection: a JSON array of ` +
    `\`{ "id", "name", "handle", "summary", "behaviorSummary", "dependsOn" }\` for the same slices (NO thread). This ` +
    `lets a resume rebuild the build graph cheaply.\n` +
    `Write BOTH files — do not just return.\n\n` +
    `${GROUND_RULE}\n\nReturn the slices.`,
    { schema: SLICES, phase: 'Discover slices', label: `discover:${feature.id}` }
  )
  const prev = r ? { featureKey: feature.id, slices: r.slices || [] } : null
  if (!prev || prev.slices.length === 0) return prev
  // LIGHT per-feature result ONLY — the bulky thread + acceptance criteria live in the
  // side-cars (written by the discovery + behavior agents), never in the checkpoint
  // (that is what kept persist small enough to succeed). Heavy consumers read from disk.
  const lightSlices = prev.slices.map((s) => ({
    id: s.id, name: s.name, handle: s.handle, summary: s.summary,
    behaviorSummary: s.behaviorSummary, dependsOn: s.dependsOn || [],
  }))
  await runBehaviorSpec(feature.id, lightSlices, sysFacts)
  return { featureKey: feature.id, slices: lightSlices }
}

async function runCritic(scopeNote = '') {
  phase('Critic')
  const scopePrefix = scopeNote ? `${scopeNote}\n\n` : '' // '' on a full run ⇒ prompts byte-identical to today
  function criticPrompt(round, prior, deterministic) {
    return scopePrefix +
      `You are the PortKit CRITIC. Audit the generated recreation kit under \`${OUT}\` for whether a LESS ` +
      `CAPABLE local model could rebuild the project from it ALONE.\n\nCheck for:\n` +
      `- Unresolved/uncheckable \`path:line\` citations (sample and verify against \`${SOURCE}\`).\n` +
      `- Thin/missing test coverage not flagged in \`${OUT}/ACCEPTANCE.md\`.\n` +
      `- \`[INFERRED]\` misuse: an inference (goal, metric, rationale, "why") asserted as observed fact, OR an ` +
      `observed fact left uncited. Check PRD.md and every adr/*.md especially.\n` +
      `- Slice specs that are NOT actually self-contained or not end-to-end testable.\n` +
      `- Document STRUCTURE: every kit doc is generated from a FIXED template, so a dropped, renamed, or ` +
      `reordered \`##\` section — or a missing \`**Field:**\` in the metadata header — is a \`malformed-structure\` defect.\n` +
      `- Missing pieces (a feature with no slice spec, a dangling dependsOn, a spec with no acceptance criteria).\n\n` +
      `STRUCTURE REPORT (required): in \`docStructures\`, list EVERY kit document you inspected as ` +
      `{ path, docType, frontmatterKeys, headings }. \`docType\` is one of ` +
      `slice-spec (specs/*.md) | adr (adr/*.md) | prd (PRD.md) | architecture (ARCHITECTURE.md) | ` +
      `index (INDEX.md) | acceptance (ACCEPTANCE.md) | glossary (GLOSSARY.md). ` +
      `\`frontmatterKeys\` = the bold \`**Key:**\` labels in the metadata header (key text only, e.g. "Slice ID", "Build #"). ` +
      `\`headings\` = the document's \`##\` section titles WITHOUT the \`##\`, in the exact order they appear. ` +
      `Report faithfully what the file actually contains — a deterministic check compares this to the required skeleton.\n\n` +
      (prior ? `Previously reported gaps that fix agents attempted:\n${prior}\n\n` : '') +
      (deterministic ? `A DETERMINISTIC structural check ALSO flagged these conformance violations — record each in \`${OUT}/RISKS-AND-GAPS.md\`:\n${deterministic}\n\n` : '') +
      `Append findings to \`${OUT}/RISKS-AND-GAPS.md\` (create if absent; this is round ${round}). ` +
      `Mark each gap fixable=true only if an agent could resolve it WITHOUT human input.\n\n${GROUND_RULE}\n\n${INFER_RULE}\n\nReturn the gaps.`
  }
  // Deterministic structural gaps: run checkDocStructure() over the structure the critic EXTRACTED.
  // Computed in JS (not LLM-judged) so a dropped/reordered section is caught reliably; each becomes a
  // fixable `malformed-structure` gap that drives the existing gap-fill loop.
  function structuralGaps(critic) {
    const docs = (critic && critic.docStructures) || []
    const out = []
    for (const d of docs) {
      for (const v of checkDocStructure(d && d.docType, d)) {
        const where = (d && d.path) || v.path || (d && d.docType) || ''
        out.push({ kind: 'malformed-structure', detail: `${v.detail}${where ? ` in \`${where}\`` : ''}`, where, fixable: true })
      }
    }
    return out
  }
  let critic = await agent(criticPrompt(1, null, null), { schema: CRITIC, phase: 'Critic', label: 'critic:1' })
  let structural = structuralGaps(critic)
  let gaps = [...((critic && critic.gaps) || []), ...structural]
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
      `\`${OUT}/RISKS-AND-GAPS.md\`. If the gap is \`malformed-structure\`, restore the exact template heading or ` +
      `metadata field IN PLACE (correct order, no content invented); if you cannot, record it in \`${OUT}/RISKS-AND-GAPS.md\`.` +
      `\n\nGAP: ${JSON.stringify(g)}\n\n${GROUND_RULE}\n\n${INFER_RULE}`,
      { phase: 'Critic', label: `gapfix:${round}:${i + 1}` }
    )))
    // Carry the structural violations into the next audit so, fixed or not, they are recorded in RISKS.
    const priorStructural = structural.length ? JSON.stringify(structural, null, 2) : null
    critic = await agent(
      criticPrompt(round, JSON.stringify(fixable, null, 2), priorStructural),
      { schema: CRITIC, phase: 'Critic', label: `critic:${round}` }
    )
    structural = structuralGaps(critic)
    gaps = [...((critic && critic.gaps) || []), ...structural]
  }
  return gaps
}

// Distill (default-on): emit a citation-free MIRROR of the kit under <OUT>/distilled/ for the weaker
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
// (heavy analysis lives in generator-written side-cars, see FEATURES_DIR), so a single
// agent can write it verbatim / read it back structured without stalling — the thing
// that broke when the full accumulator went through here (see the FEATURES_DIR note).
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
    `checkpoint JSON AND the per-feature side-cars) so a later run starts fresh instead of auto-resuming a ` +
    `finished run: \`rm -rf "$(dirname "${IR_PATH}")"\`. Return when done.`,
    { phase: 'Checkpoint', label: 'ir:clear' }
  )
}
// missingDocs — VERIFY which of the listed files actually exist (and are non-empty) on disk. The
// orchestrator sandbox can't stat files, so an agent lists them (like scanFeatureSidecars). Used to
// GATE a stage's checkpoint (doc family AND ADRs): a dead writer agent leaves its file absent, and
// we must not record the stage done over a missing artifact. `files` are paths RELATIVE to OUT
// (e.g. "PRD.md" or "adr/ADR-0001-x.md"), so it works for both flat docs and the adr/ subdir. The
// agent echoes back the missing paths VERBATIM. Fail-SAFE: if the verify agent itself dies, treat
// ALL files as missing (→ retry/pause) rather than falsely reporting the stage complete.
async function missingDocs(files, { label = 'docs:verify', phase = 'Synthesize' } = {}) {
  const r = await agent(
    `You are the PortKit DOC-VERIFY agent. For EACH path below (relative to \`${OUT}\`), check whether the file ` +
    `EXISTS under \`${OUT}\` and is NON-EMPTY:\n${files.map(f => `- \`${f}\``).join('\n')}\n\n` +
    `Return \`{"missing": [ <the paths, EXACTLY as listed above, that are ABSENT or EMPTY> ]}\` — copy each path ` +
    `verbatim from the list; an empty array means every listed file is present.`,
    { schema: { type: 'object', properties: { missing: { type: 'array', items: { type: 'string' } } }, required: ['missing'] },
      phase, label }
  )
  const want = new Set(files)
  if (!r || !Array.isArray(r.missing)) return [...files] // verify died ⇒ assume all missing (fail-safe)
  return r.missing.filter(f => want.has(f))
}
// Resume helpers — completion is judged by the DURABLE ARTIFACTS on disk, not by the
// checkpoint, so no already-finished agent is ever re-run even if the checkpoint lagged.
// scanFeatureSidecars: for EACH feature under FEATURES_DIR, which side-cars exist. Slice
// STRUCTURE (light.json) and the BEHAVIOR spec (behavior.json) are INDEPENDENT artifacts —
// reporting them separately (rather than a single "both present = done" flag) lets
// planResume() reload durable structure and re-run ONLY a missing behavior spec, instead of
// re-discovering (and renumbering) a feature just because its behavior agent had failed.
// loadFeatureLight: rebuild ONE feature's light slice list from its small light.json
// (a small read, never the heavy slices.json).
async function scanFeatureSidecars() {
  const r = await agent(
    `You are the PortKit RESUME-SCAN agent. List \`${FEATURES_DIR}\` (it may not exist — then return \`{"features": []}\`). ` +
    `A feature id is a side-car file name with its \`.light.json\`, \`.slices.json\`, or \`.behavior.json\` suffix ` +
    `removed. For EVERY distinct feature id present, report which side-cars exist. Return ` +
    `\`{"features": [ { "id": <id>, "hasLight": <true iff <id>.light.json exists>, "hasBehavior": <true iff <id>.behavior.json exists> } ]}\`.`,
    { schema: { type: 'object', properties: { features: { type: 'array', items: {
        type: 'object',
        properties: { id: { type: 'string' }, hasLight: { type: 'boolean' }, hasBehavior: { type: 'boolean' } },
        required: ['id', 'hasLight', 'hasBehavior'] } } } },
      phase: 'Discover slices', label: 'resume:scan' }
  )
  return (r && Array.isArray(r.features)) ? r.features : []
}
async function loadFeatureLight(featureKey) {
  const r = await agent(
    `You are the PortKit LIGHT-LOAD agent. Read \`${lightCarPath(featureKey)}\` and return \`{"slices": <its JSON array>}\` ` +
    `EXACTLY (do not alter). If the file is missing or empty, return \`{"slices": []}\`.`,
    { schema: { type: 'object', properties: { slices: { type: 'array', items: {} } } },
      phase: 'Discover slices', label: `light:${featureKey}` }
  )
  return { featureKey, slices: (r && Array.isArray(r.slices)) ? r.slices : [] }
}

// The single mutable checkpoint object. saveStage() merges a phase's output into it,
// stamps the stage, and persists — so the on-disk IR always reflects the furthest
// completed stage. Initialized fresh below, or replaced by a loaded checkpoint on
// auto-resume.
let checkpoint = null
async function saveStage(stage, patch = {}) {
  // Carry the truncation ledger into every checkpoint so a resume can re-seed it —
  // otherwise notes from earlier passes (capped features, dedup/cycle notes) would be
  // lost and the final result would under-report what was dropped.
  checkpoint = { ...(checkpoint || {}), ...patch, stage, truncations: dropped }
  await persistIR(checkpoint)
  return checkpoint
}

// Write-specs stage. Writes the next un-written batch of slice specs and returns a
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
      // files, so we batch at SLICE granularity here (not feature) — this bounds the per-pass
      // overshoot to ~maxConcurrency specs even inside one very large feature. Build order is
      // preserved (pending is ordered), so prerequisites still precede dependents.
      thisPass = pending.slice(0, perBatch)
    } else if (partitioned) {
      // Agent over-scale (no token budget): keep whole features together per pass.
      const batch = planFeatureBatches(buildFeatureTree(pending), perBatch)[0]
      const ids = new Set((batch && batch.sliceIds) || [])
      thisPass = pending.filter(s => ids.has(s.id))
    }

    const docs = await writeSliceDocs(thisPass)
    // Mark only slices that actually wrote OK as done; failures stay pending and are
    // retried on the next pass (so a flaky write is never silently lost).
    const okThisPass = thisPass.filter((s, i) => docs[i] && docs[i].ok)
    okThisPass.forEach(s => writtenNs.add(s.n))
    if (okThisPass.length) didWorkThisTurn = true
    wroteThisInvocation += okThisPass.length
    const remaining = ordered.filter(s => !writtenNs.has(s.n)).length
    log(`Wrote ${okThisPass.length}/${thisPass.length} slice spec(s)` +
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
      const err = `Write pass made no progress: all ${thisPass.length} write(s) failed, ${remaining} slice(s) still pending${tokenBudgetSet() ? ' (token-budget chunked run)' : ''}.`
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
      const note = `${remaining} slice spec(s) remain after this ${stopForBudget ? 'token-budget ' : ''}pass — re-run with { resume: true } pointed at outputDir "${OUT}" to continue (nothing dropped).`
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
async function finalize({ ordered, adrs = [], gaps = [], distill = null, extraCounts = {}, cleared = true }) {
  // The checkpoint is DESTROYED only when EVERY ladder stage completed. Distillation is the terminal
  // stage; opting out (`distill: false`) means it never ran, so the run is not fully complete and we
  // KEEP the checkpoint (cleared=false). The cited kit is done, but a later `/portkit-distill` (or a
  // re-run without `distill: false`) can resume from 'critiqued' to add the rebuilder mirror WITHOUT
  // re-running the analysis. Only a run that reached 'distilled' clears.
  if (cleared) {
    await clearIR()
  } else {
    log(`ℹ️  Distillation opted out — the cited kit is complete, but the checkpoint at \`${IR_PATH}\` is ` +
      `KEPT (the terminal 'distilled' stage never ran). Run \`/portkit-distill\` (or re-run without ` +
      `\`distill: false\`) to add the citation-free \`distilled/\` mirror and finalize; use --fresh or ` +
      `delete \`.portkit/\` to discard it.`)
  }
  return {
    ok: true, outDir: OUT, resumeRequired: false,
    ...(cleared ? {} : { checkpointRetained: true, distillAvailable: true }),
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
      glossary: `${OUT}/GLOSSARY.md`,
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
      ((loaded.scale.maxFeatures ?? MAX_FEATURES) !== MAX_FEATURES || (loaded.scale.limitSlices ?? LIMIT_SLICES) !== LIMIT_SLICES)) {
      // Scope MISMATCH: the checkpoint was built with different scale knobs. Resuming would reuse
      // the checkpoint's (capped) feature list and limitSlices, silently continuing the smaller scope
      // with this run's flags. Abort loudly rather than produce a Frankenstein kit.
      return {
        ok: false,
        error: `Checkpoint at \`${IR_PATH}\` was built with maxFeatures=${loaded.scale.maxFeatures}, limitSlices=${loaded.scale.limitSlices}; ` +
          `this run uses maxFeatures=${MAX_FEATURES}, limitSlices=${LIMIT_SLICES}. Resuming would keep the checkpoint's smaller scope, ` +
          `not your new flags. Use { fresh: true } with a clean or new outputDir for a full run, or re-run with the same scale knobs to continue this checkpoint.`,
        outDir: OUT,
        checkpointScale: loaded.scale,
        requestedScale: { maxFeatures: MAX_FEATURES, limitSlices: LIMIT_SLICES },
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
// Stage: Map — survey the repo + draft the feature inventory.
// ===========================================================================
let sysFacts, features, featuresTotal
if (RESUMING && stageDone(savedStage, 'mapped')) {
  sysFacts = checkpoint.sysFacts || '{}'
  features = checkpoint.features || []
  // Pre-cap total for the critic's intentional-omission scope note; fall back to the kept
  // count for pre-featuresTotal checkpoints (⇒ no false "features dropped" claim).
  featuresTotal = checkpoint.featuresTotal ?? features.length
  log(`Skipping map (checkpointed): ${features.length} feature(ies).`)
} else {
  phase('Map')
  const map = await agent(
  `You are the PortKit MAP agent. Survey the source codebase rooted at \`${SOURCE}\`. ` +
  `This path has been preflight-verified to exist. If at any point it appears empty or unreadable, STOP and ` +
  `report it — do NOT survey any other directory or substitute a different path.\n\n` +
  `Tasks:\n` +
  `1. Identify languages, build system, test framework(s) and where tests live, and the dependency manifest file(s).\n` +
  `2. Discover the FEATURES of the system as a DRAFT FEATURE INVENTORY — coarse, user/externally-observable ` +
  `behaviors (HTTP endpoints, CLI commands, public API operations, event/message handlers, scheduled jobs, UI flows). ` +
  `These are VERTICAL threads, NOT horizontal layers. Do NOT list "the models" or "the controllers" — list what the ` +
  `system DOES. Give each a stable id, a name, a kind, and entry-point \`path:line\` anchors.\n\n` +
  `Return ONLY the structured inventory as data — do NOT write any file (ARCHITECTURE.md is authored later from this ` +
  `data plus the discovered slices).\n\n` +
  `${GROUND_RULE}\n\nReturn the structured inventory.`,
    { schema: SYSTEM_MAP, phase: 'Map', label: 'map:survey' }
  )
  if (!map || !Array.isArray(map.features) || map.features.length === 0) {
    return {
      ok: false,
      error: 'Map phase produced no features — cannot build a recreation kit.',
      outDir: OUT,
    }
  }
  sysFacts = JSON.stringify({
    languages: map.languages, buildSystem: map.buildSystem,
    testFrameworks: map.testFrameworks, testPaths: map.testPaths,
    dependencyManifests: map.dependencyManifests,
  }, null, 2)
  featuresTotal = map.features.length
  features = cap(map.features, MAX_FEATURES, 'features')
  log(`Mapped ${map.features.length} feature(ies); analyzing ${features.length}.`)
  // Persist the scale knobs so a later resume can detect a scope MISMATCH (e.g. resuming a
  // maxFeatures=5/limitSlices=3 smoke-test checkpoint with a full-run command) and refuse to silently
  // continue the smaller scope — the exact trap that produced the 5-feature Frankenstein kit.
  // featuresTotal (pre-cap) rides along so the critic can flag an intentional maxFeatures drop even on resume.
  await saveStage('mapped', {
    source: SOURCE, fileCount: probe.fileCount, sysFacts, features, featuresTotal,
    scale: { maxFeatures: MAX_FEATURES, limitSlices: LIMIT_SLICES },
  })
}
// Phase ceiling: /portkit-map stops here. Placed OUTSIDE the if/else so it fires on a
// resume that skipped the map agent too (re-running /portkit-map just re-reports).
if (stopAfter('mapped', UNTIL)) return pausedAfter('mapped', { features: features.length })

// ===========================================================================
// Stage: Discover — per feature, trace slices + extract the behavioral spec.
// Processed in CHECKPOINTED batches (CHECKPOINT_EVERY features per batch): after
// each batch the checkpoint advances, so an interruption keeps every already-analyzed
// feature instead of restarting the whole (most expensive) discovery phase.
// ===========================================================================
// perFeatureDone holds LIGHT slices in memory (fresh: from discovery returns; resume:
// rebuilt from the light side-cars). On resume, completion is judged by the durable
// side-cars — NOT the checkpoint — so no finished feature is ever re-analyzed. We
// rebuild in `features` order (not filesystem order) so the downstream build numbering is
// identical to a fresh run, keeping already-written spec file names valid.
let perFeatureDone = []
if (RESUMING && stageDone(savedStage, 'mapped')) {
  const plan = planResume(features, await scanFeatureSidecars())
  if (plan.reload.length) {
    // Structure is durable + deterministic: reload EVERY feature that has a light.json
    // (in `features` order, so numbering matches a fresh run) — NEVER re-discover it, which
    // would change the slice set and renumber every downstream spec.
    perFeatureDone = (await pooled(plan.reload.map(id => () => loadFeatureLight(id)))).filter(Boolean)
    // A feature whose behavior side-car is missing (its behavior agent failed on a prior
    // pass) re-runs ONLY the behavior agent, against the reloaded slices — structure and
    // numbering are untouched, so already-written specs keep matching their build numbers.
    const fill = new Set(plan.behaviorOnly)
    const behaviorTodo = perFeatureDone.filter(e => e && e.slices.length && fill.has(e.featureKey))
    if (behaviorTodo.length) {
      log(`Reusing ${perFeatureDone.length} feature(ies) from durable side-cars (structure unchanged); re-running behavior-spec only for ${behaviorTodo.length} missing a behavior side-car.`)
      await pooled(behaviorTodo.map(e => () => runBehaviorSpec(e.featureKey, e.slices, sysFacts)))
    } else {
      log(`Reusing ${perFeatureDone.length} feature(ies) already analyzed by a prior run (from side-cars).`)
    }
  }
}
if (!(RESUMING && stageDone(savedStage, 'discovered'))) {
  phase('Discover slices')
  const doneIds = new Set(perFeatureDone.map(e => e && e.featureKey))
  const todo = features.filter(e => !doneIds.has(e.id))
  if (perFeatureDone.length) log(`Discovery resuming: ${perFeatureDone.length} done, ${todo.length} feature(ies) to analyze.`)
  let discoveredThisTurn = 0 // features SUCCESSFULLY discovered this invocation (forward-progress signal)
  for (const group of chunk(todo, CHECKPOINT_EVERY)) {
    const results = await pooled(group.map((feature) => () => discoverFeature(feature, sysFacts)))
    const ok = results.filter(Boolean)
    perFeatureDone.push(...ok)
    discoveredThisTurn += ok.length
    didWorkThisTurn = true // a discovery batch completed this turn — the progress guard is now armed
    // TINY checkpoint: advance the stage + record only WHICH features are done
    // (their ids). The slice data itself lives in the durable side-cars, never here.
    await saveStage('discovering', { featuresDone: perFeatureDone.map(e => e.featureKey) })
    // Voluntary token-budget yield: discovery is the dominant early cost and is fully
    // mid-phase resumable (side-cars + featuresDone), so this is the cheapest place to chunk a
    // very large project. The just-checkpointed batch is durable before we stop.
    if (budgetYieldNow()) return yieldForBudget('discovering', { featuresDiscovered: perFeatureDone.length })
  }
  // A DEAD discovery agent (agent() → null) is filtered out above and left NO side-cars, so its
  // feature has no light.json. If ANY feature failed, DO NOT advance to 'discovered' — that would
  // synthesize/write/finalize an incomplete kit and clearIR() over it, silently dropping the
  // failed features AND the resume trail. Stop with the checkpoint intact at 'discovering' so a
  // re-run re-discovers ONLY the missing features (the durable ones are reloaded, never renumbered).
  const doneNow = new Set(perFeatureDone.map(e => e && e.featureKey))
  const failedFeatures = features.filter(e => !doneNow.has(e.id))
  if (failedFeatures.length) return discoveryIncomplete(failedFeatures, perFeatureDone.length, discoveredThisTurn > 0)
  await saveStage('discovered', { featuresDone: perFeatureDone.map(e => e.featureKey) })
  if (budgetYieldNow()) return yieldForBudget('discovered', { featuresDiscovered: perFeatureDone.length })
}
// Phase ceiling: /portkit-discover stops here (outside the block so it fires on resume too).
if (stopAfter('discovered', UNTIL)) return pausedAfter('discovered', { featuresDiscovered: perFeatureDone.length })

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
  for (const e of perFeatureDone) {
    if (!e) continue
    for (const s of (e.slices || [])) slices.push({ ...s, featureKey: e.featureKey })
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
    log(`Discovered ${slices.length} slice(s) across ${perFeatureDone.filter(Boolean).length} feature(ies).`)
    phase('Synthesize')
    const synthInput = slices.map(s => ({
      id: s.id, name: s.name, featureKey: s.featureKey, summary: s.summary, behaviorSummary: s.behaviorSummary,
    }))
    const synth = await agent(
      `You are the PortKit SYNTHESIS agent. You receive ALL discovered vertical slices (slices) in compact form.\n\n` +
      `Do ONE thing — DEDUP: identify sets of slices that are truly the SAME vertical thread discovered from different ` +
      `features/angles. For each set return a merge group { keep, merge: [ids…] } — \`keep\` is the surviving ` +
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

  // DEV/TEST cost cap (opt-in, LOUD). Keep only the first N slices in build order;
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
      const note = `🧪 TEST LIMIT: writing only ${ordered.length} of ${orderedFull.length} slice(s) (limitSlices=${LIMIT_SLICES}). ` +
        `PARTIAL end-to-end TEST kit — NOT a complete recreation kit; ${slicesOmittedForTest} slice(s) intentionally omitted.`
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

// ---------------------------------------------------------------------------
// Canonical DISPLAY-id lookups (JS-owned, deterministic). The raw discovery keys wire the
// build graph; these turn a key into the id a reader sees. Built ONCE here — after `ordered`
// is finalized and before BOTH the doc family and the write phase — so every writer, and a
// resume that skips the docs stage but still writes specs, shows the SAME SL-/FEAT- ids.
//   - sliceIdByKey: slice key -> SL-<NNNN> (build number)
//   - renderDeps:   a dependsOn list of raw slice KEYS -> their Slice IDs. A dep to a
//     merged-away or intentionally-omitted key cannot occur (rewriteEdges remaps merges;
//     topo order keeps prerequisites) but falls back to `<key> [omitted]` defensively.
//   - featureRef:   a slice's parent feature key -> "FEAT-<NN> <name>" (blank-safe).
// ---------------------------------------------------------------------------
const sliceIdByKey = new Map(ordered.map(s => [s.id, sliceId(s.n)]))
const renderDeps = (deps) => (deps || []).map(k => sliceIdByKey.get(k) || `${k} [omitted]`)
const featureNumByKey = new Map(features.map((f, i) => [f.id, i + 1]))
const featById = new Map(features.map(f => [f.id, f]))
const featureRef = (key) => {
  const n = featureNumByKey.get(key)
  const f = featById.get(key)
  return n ? `${featureId(n)}${f ? ` ${f.name}` : ''}` : (key || '')
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
  const featureTree = buildFeatureTree(ordered)

  // Compact briefs shared by the PRD / ARCHITECTURE / INDEX writers, carrying the canonical
  // DISPLAY ids (SL-/FEAT-) so the writers transcribe them and never see a raw key.
  const orderedBrief = ordered.map(s => ({
  sliceId: sliceId(s.n), n: s.n, name: s.name, feature: featureRef(s.featureKey), summary: s.summary,
  behaviorSummary: s.behaviorSummary, dependsOn: renderDeps(s.dependsOn),
}))
  const featuresBrief = features.map((f, i) => ({
    featureId: featureId(i + 1), name: f.name, kind: f.kind,
    summary: f.summary, entryPoints: f.entryPoints || [],
  }))

// INDEX writer — transcribes the JS-computed build order + feature tree into
// INDEX.md (the orchestrator sandbox cannot write files; an agent must). The data
// is AUTHORITATIVE: the agent must not reorder or invent.
//
// Each slice carries its EXACT `spec` path (specRelPath → specName, the same source
// of truth sliceDocPath uses to WRITE the file). The agent MUST link that verbatim and
// MUST NOT re-slugify the name: slug() truncates to 48 chars, so a recomputed link for a
// long name silently disagreed with the truncated file on disk — every such link 404'd
// even on a fully successful run. The feature tree is enriched with the same per-
// slice {n,id,name,spec} so its links use the exact path too (not just build order).
const byIdForIndex = new Map(ordered.map(s => [s.id, s]))
const indexData = {
  buildOrder: ordered.map(s => ({
    sliceId: sliceId(s.n), n: s.n, name: s.name, feature: featureRef(s.featureKey), spec: specRelPath(s),
    dependsOn: renderDeps(s.dependsOn), mergedFrom: (s.mergedFrom || []).map(k => sliceIdByKey.get(k) || k),
  })),
  featureTree: featureTree.map(({ featureKey, sliceIds }) => ({
    featureId: featureRef(featureKey),
    slices: sliceIds.map(id => {
      const s = byIdForIndex.get(id)
      return { sliceId: sliceId(s.n), n: s.n, name: s.name, spec: specRelPath(s) }
    }),
  })),
}
// ACCEPTANCE data — the single surface that flags coverage gaps loudly (each slice spec's
// acceptance criteria are drawn from here). Written from the extracted behavior data of the
// SURVIVING (post-merge) slices; the writer invents nothing. Criteria live in the per-feature
// behavior side-cars (written at discovery), NOT in the checkpoint — the writer reads them from
// disk. Each survivor carries its canonical Slice ID + Feature ref plus the raw `sliceKey` it uses
// to look the slice up. `sliceLabel` is the slice's spec-file form `SL-NNNN-<slug>` (specName minus
// `.md`) — precomputed so the Coverage Summary shows the slug-bearing id WITHOUT the writer
// re-slugifying the name (slug() truncates to 48 chars, so a recomputed label would drift from disk).
const survivors = ordered.map(s => ({
  sliceId: sliceId(s.n), sliceLabel: specName(s.n, s.handle || s.name).replace(/\.md$/, ''),
  feature: featureRef(s.featureKey), name: s.name, sliceKey: s.id,
}))
const behaviorFiles = [...new Set(ordered.map(s => s.featureKey))].map(behaviorCarPath)

// The doc family as RETRYABLE units keyed by output file. Before, all five ran fire-and-forget
// and 'docs' was checkpointed unconditionally — so a dead writer (agent()→null, or one that
// returned without writing) left its file ABSENT, the stage was recorded DONE, and a resume
// SKIPPED docs forever, leaving e.g. a missing PRD.md (the reported bug). Now we author, VERIFY on
// disk, retry the missing writers once, and refuse to checkpoint 'docs' if any file is still gone.
const docWriters = [
  { file: 'INDEX.md', run: () => agent(
    `You are the PortKit INDEX writer. ${rewriteClause(`${OUT}/INDEX.md`)} Write \`${OUT}/INDEX.md\` — the recreation roadmap — from the data below. ` +
    `The build order and feature→slice tree are AUTHORITATIVE (computed deterministically) — do NOT reorder, ` +
    `renumber, or invent, and transcribe every \`SL-\`/\`FEAT-\` id VERBATIM.\n\n` +
    `CRITICAL — spec links: every slice object carries an exact \`spec\` field (e.g. \`specs/0001-....md\`). Use that ` +
    `string VERBATIM as the markdown link target. Do NOT construct, slugify, shorten, or otherwise alter a spec path ` +
    `yourself — the filenames are truncated and a hand-built link will not match the file on disk.\n\n` +
    `${HOUSE_STYLE}\n\n${INDEX_TEMPLATE}\n\n` +
    `DATA:\n${JSON.stringify(indexData, null, 2)}`,
    { phase: 'Synthesize', label: 'index' }) },
  { file: 'ACCEPTANCE.md', run: () => agent(
    `You are the PortKit ACCEPTANCE writer. ${rewriteClause(`${OUT}/ACCEPTANCE.md`)} Write \`${OUT}/ACCEPTANCE.md\`: the full extracted acceptance criteria.\n\n` +
    `The criteria are in these behavior side-car files (JSON, each \`{ "perSlice": [ { "sliceKey", "coverage", ` +
    `"acceptanceCriteria", "testRefs" } ] }\`):\n${behaviorFiles.map(f => `- \`${f}\``).join('\n')}\n` +
    `READ them and index by \`sliceKey\`. For EACH surviving slice below, emit its criteria/testRefs/coverage from ` +
    `that index, NEVER by the raw sliceKey; if a slice's entry (or its file) is missing, treat coverage as 'none'. ` +
    `In the Coverage Summary table, name each slice by its \`sliceLabel\` (the \`SL-NNNN-<slug>\` spec-file form) ` +
    `with its \`feature\` first; in the by-feature criteria section, group by \`feature\` and name each slice by its ` +
    `\`sliceId\`. Transcribe both VERBATIM. Use ONLY what the side-cars contain — do NOT invent criteria. Never paper ` +
    `over missing coverage.\n\n` +
    `${HOUSE_STYLE}\n\n${ACCEPTANCE_TEMPLATE}\n\n` +
    `SURVIVING SLICES:\n${JSON.stringify(survivors, null, 2)}\n\n${GROUND_RULE}`,
    { phase: 'Synthesize', label: 'acceptance' }) },
  { file: 'ARCHITECTURE.md', run: () => agent(
    `You are the PortKit ARCHITECTURE writer. ${rewriteClause(`${OUT}/ARCHITECTURE.md`)} Write \`${OUT}/ARCHITECTURE.md\` — the system/technical spec a weak ` +
    `local model reads ONCE to understand how the pieces fit, then every slice spec references it.\n\n` +
    `${HOUSE_STYLE}\n\n${ARCHITECTURE_TEMPLATE}\n\n` +
    `Source facts: ${sysFacts}\nSource root: \`${SOURCE}\`.\n\nFEATURES (transcribe each \`featureId\` verbatim):\n${JSON.stringify(featuresBrief, null, 2)}\n\n` +
    `SLICES:\n${JSON.stringify(orderedBrief, null, 2)}\n\n${GROUND_RULE}\n\n${INFER_RULE}\n\nReturn when written.`,
    { phase: 'Synthesize', label: 'arch' }) },
  { file: 'PRD.md', run: () => agent(
    `You are the PortKit PRD writer. ${rewriteClause(`${OUT}/PRD.md`)} Write \`${OUT}/PRD.md\` — a Product Requirements Document RECONSTRUCTED from ` +
    `the observed behavior of the source (you are reverse-engineering; the source does not state its own intent).\n\n` +
    `${HOUSE_STYLE}\n\n${PRD_TEMPLATE}\n\n` +
    `Source facts: ${sysFacts}\nSource root: \`${SOURCE}\`.\n\nFEATURES (transcribe each \`featureId\` verbatim):\n${JSON.stringify(featuresBrief, null, 2)}\n\n` +
    `SLICES:\n${JSON.stringify(orderedBrief, null, 2)}\n\n${GROUND_RULE}\n\n${INFER_RULE}\n\nReturn when written.`,
    { phase: 'Synthesize', label: 'prd' }) },
  { file: 'GLOSSARY.md', run: () => agent(
    `You are the PortKit GLOSSARY writer. ${rewriteClause(`${OUT}/GLOSSARY.md`)} Write \`${OUT}/GLOSSARY.md\` — the kit's ` +
    `canonical vocabulary that every other document uses.\n\n${HOUSE_STYLE}\n\n${GLOSSARY_TEMPLATE}\n\n` +
    `Write exactly that content to \`${OUT}/GLOSSARY.md\` (do not add or drop terms). Return when written.`,
    { phase: 'Synthesize', label: 'glossary' }) },
]
const allDocFiles = docWriters.map(w => w.file)
for (const w of docWriters) await w.run()
let missingDocFiles = await missingDocs(allDocFiles)
if (missingDocFiles.length) {
  log(`⚠️  Doc family: ${missingDocFiles.length} document(s) missing after authoring (${missingDocFiles.join(', ')}) — retrying the missing writer(s).`)
  for (const w of docWriters.filter(w => missingDocFiles.includes(w.file))) await w.run()
  missingDocFiles = await missingDocs(allDocFiles)
}
// Refuse to checkpoint 'docs' over a missing document — that is the bug this guards against.
if (missingDocFiles.length) return docsIncomplete(missingDocFiles)
  await saveStage('docs', {})
  didWorkThisTurn = true // the doc family (5 agents: INDEX/ACCEPTANCE/ARCHITECTURE/PRD/GLOSSARY) ran this turn
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
  `each a stable id, a decision-shaped title, and a TERSE 2-4 word kebab-case \`handle\` for the filename ` +
  `(e.g. "two-file-persistence", "write-acl-matrix", "optimistic-locking" — NOT the full title).\n\n` +
  `Source facts: ${sysFacts}\nSource root: \`${SOURCE}\`.\n\nFEATURES:\n${JSON.stringify(features, null, 2)}\n\n` +
  `${GROUND_RULE}\n\nReturn the decisions.`,
  { schema: ADRS, phase: 'ADRs', label: 'adr:discover' }
)
  decisions = cap(((adrDisc && adrDisc.decisions) || []).filter(d => d && d.title && Array.isArray(d.evidence) && d.evidence.length),
    MAX_ADRS, 'ADRs')
if (decisions.length) {
  log(`Discovered ${decisions.length} architecturally significant decision(s).`)
  // Author each ADR as a RETRYABLE unit keyed by its output file, then VERIFY on disk — the same
  // guard as the doc family. Before, the writer results were discarded and 'adrs' was checkpointed
  // unconditionally, so a dead ADR writer left its file absent, the stage was recorded DONE, and a
  // resume skipped ADR writing forever. Verify → retry the missing writers once → refuse to
  // checkpoint 'adrs' if any ADR file is still absent (a re-run then re-authors them).
  const adrWriters = decisions.map((d, i) => {
    const aid = adrId(i + 1)
    const rel = `adr/${adrName(i + 1, d.handle || d.title)}`
    const adrPath = `${OUT}/${rel}`
    return { file: rel, run: () => agent(
      `You are the PortKit ADR writer. Write ONE Architecture Decision Record in MADR format to \`${adrPath}\`.\n\n` +
      `${rewriteClause(adrPath)}\n\n` +
      `${HOUSE_STYLE}\n\n${ADR_TEMPLATE}\n\n` +
      `Fill the skeleton for this decision (ADR ID \`${aid}\`, title \`${d.title}\` — transcribe both VERBATIM into ` +
      `the header):\nDECISION DATA:\n${JSON.stringify(d, null, 2)}\nSource root: \`${SOURCE}\`.\n\n${GROUND_RULE}\n\n${INFER_RULE}`,
      { phase: 'ADRs', label: `adr:write:${i + 1}` }) }
  })
  const allAdrFiles = adrWriters.map(w => w.file)
  await pooled(adrWriters.map(w => () => w.run()))
  let missingAdrFiles = await missingDocs(allAdrFiles, { label: 'adrs:verify', phase: 'ADRs' })
  if (missingAdrFiles.length) {
    log(`⚠️  ADRs: ${missingAdrFiles.length} record(s) missing after authoring (${missingAdrFiles.join(', ')}) — retrying the missing writer(s).`)
    await pooled(adrWriters.filter(w => missingAdrFiles.includes(w.file)).map(w => () => w.run()))
    missingAdrFiles = await missingDocs(allAdrFiles, { label: 'adrs:verify', phase: 'ADRs' })
  }
  // Refuse to checkpoint 'adrs' over a missing ADR — the bug this guards against.
  if (missingAdrFiles.length) return adrsIncomplete(missingAdrFiles)
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
// runtime ceiling, partition slice-spec writing into resumable passes.
// runWriteAndFinish advances the `written` checkpoint each pass and CLEARS the
// checkpoint on completion.
// ===========================================================================
// Two independent reasons to partition the write phase into resumable passes: AGENT over-scale
// (projected agents near the ~1000 ceiling) and a TOKEN budget (chunk to fit a subscription
// window). Either engages small/batched writes; a token budget additionally makes each pass small.
const finalCounts = {
  features: features.length, slicesDiscovered,
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
      featureCount: features.length, sliceCount: ordered.length,
      adrCount: decisions.length, maxAdrs: MAX_ADRS, gapfillRounds: MAX_GAPFILL_ROUNDS,
    })
    const overScale = projected > SAFE_BUDGET
    partitioned = overScale || tokenBudgetSet()
    if (overScale) {
      const note = `Over-scale: projected ~${projected} agents exceeds the safe budget (${SAFE_BUDGET}); partitioning slice-spec writing into resumable passes. Nothing dropped.`
      log(`⚖️  ${note}`); dropped.push(note)
    } else if (tokenBudgetSet()) {
      const note = `Token budget in effect (~${effectiveTokenTotal()} tokens, reserve ${TOKEN_RESERVE}); writing slice specs in small resumable passes sized to the subscription window. Nothing dropped.`
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
  // Tell the critic which omissions are INTENTIONAL (limitSlices trims specs, maxFeatures drops
  // features) so its gap-fill loop never "repairs" a deliberate truncation into a
  // claimed-complete kit. '' on a full run ⇒ the critic/gap-fix prompts are byte-identical to today.
  const scopeNote = omissionScopeNote({
    slicesOmittedForTest, limitSlices: LIMIT_SLICES,
    featuresKept: features.length, featuresTotal: featuresTotal ?? features.length,
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
// Stage: Distill (ON by default) — emit a citation-free distilled/ mirror for the weaker
// rebuilder, after the critic has validated the cited kit. Skipped on a resume past
// this stage. With `distill: false` this stage is inert and 'critiqued' is terminal.
// ===========================================================================
let distill = null
if (DISTILL) {
  if (RESUMING && stageDone(savedStage, 'distilled')) {
    distill = checkpoint.distill || null
    log('Skipping distill (checkpointed).')
  } else {
    const docPaths = [
      'ARCHITECTURE.md', 'PRD.md', 'INDEX.md', 'ACCEPTANCE.md', 'GLOSSARY.md',
      ...ordered.map(s => specRelPath(s)),
      ...decisions.map((d, i) => `adr/${adrName(i + 1, d.handle || d.title)}`),
    ]
    distill = await runDistill(docPaths)
    await saveStage('distilled', { distill })
    didWorkThisTurn = true
  }
  // 'distilled' is the terminal stage, so a ceiling of 'distilled' means "finish": fall
  // through to finalize rather than pause (pausing would leave a completed-but-uncleared
  // checkpoint that a plain /portkit would then have to clean up).
}

// Natural completion — assemble the final result. The checkpoint is cleared ONLY when the terminal
// 'distilled' stage ran; with `distill: false` (DISTILL off) it is deliberately KEPT so distillation
// can still be completed later (all-phases-done is the sole condition for destroying the checkpoint).
return await finalize({ ordered, adrs: decisions, gaps, distill, extraCounts: finalCounts, cleared: DISTILL })
