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
// ---------------------------------------------------------------------------
const MAX_EPICS = Number(cfg.maxEpics) || 40
const MAX_SLICES_TOTAL = Number(cfg.maxSlices) || 120
const MAX_HINTS_PER_TARGET = Number(cfg.maxHintsPerTarget) || 80
const MAX_GAPFILL_ROUNDS = Number(cfg.maxGapfillRounds) || 2

// Concurrency throttle. The runtime caps in-flight agents at min(16, cores-2),
// but that ceiling is high enough that the per-agent model requests trip API
// rate limits on a busy account. We bound in-flight agents to a gentler limit
// (overridable via args.maxConcurrency) and run every fan-out through pooled()
// instead of letting parallel()/pipeline() saturate the runtime cap.
const MAX_CONCURRENCY = Math.max(1, Number(cfg.maxConcurrency) || 8)

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

const SYNTH = {
  type: 'object',
  required: ['slices', 'buildOrder'],
  properties: {
    slices: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'epicId'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          epicId: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          mergedFrom: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    buildOrder: { type: 'array', items: { type: 'string' }, description: 'slice ids in topological build order' },
    wroteKernel: { type: 'boolean' },
    wroteIndex: { type: 'boolean' },
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
const slices = cap(allSlices, MAX_SLICES_TOTAL, 'slices')
log(`Discovered ${allSlices.length} slices across ${perEpic.filter(Boolean).length} epics; carrying ${slices.length}.`)

// ===========================================================================
// Phase 2 — Synthesize (BARRIER): the only place that needs ALL slices at once.
// Normalize/dedup overlapping threads, decide what is hoisted to the shared
// kernel vs kept in a slice, build the epic→slice tree + topological order.
// ===========================================================================
phase('Synthesize')
const synthInput = slices.map(s => ({
  id: s.id, name: s.name, epicId: s.epicId, capability: s.capability,
  thread: s.thread, behaviorSummary: s.behaviorSummary, dependsOn: s.dependsOn || [],
}))
const synth = await agent(
  `You are the PortKit SYNTHESIS agent. You receive ALL discovered vertical slices.\n\n` +
  `Do four things:\n` +
  `1. NORMALIZE & DEDUP: merge slices that are the same thread discovered from different epics; resolve ` +
  `contradictions. Record merges in \`mergedFrom\`.\n` +
  `2. DECIDE the kernel/slice boundary: shared naming, types, domain vocabulary, and cross-cutting CONVENTIONS ` +
  `(auth, config, logging, error handling, concurrency) are HOISTED into a thin shared kernel that slices ` +
  `reference; everything else stays inside its slice so each slice is self-contained for a weak model.\n` +
  `3. WRITE \`${OUT}/KERNEL.md\` (naming/type glossary + domain vocabulary) and \`${OUT}/kernel/cross-cutting.md\` ` +
  `(conventions stated as rules slices obey, not a layer to build).\n` +
  `4. COMPUTE a deterministic TOPOLOGICAL buildOrder over slice ids (dependencies first) and WRITE ` +
  `\`${OUT}/epics/INDEX.md\` — the epic→slice tree AND the build order.\n\n` +
  `Source facts: ${sysFacts}\n\nSLICES:\n${JSON.stringify(synthInput, null, 2)}\n\n` +
  `${GROUND_RULE}\n\nReturn the normalized slices and the buildOrder.`,
  { schema: SYNTH, phase: 'Synthesize', label: 'synthesize' }
)

// Build the canonical ordered slice list. Trust synth.buildOrder if usable;
// otherwise fall back to discovery order so the run still produces docs.
const sliceById = new Map(slices.map(s => [s.id, s]))
const synthById = new Map(((synth && synth.slices) || []).map(s => [s.id, s]))
let order = (synth && Array.isArray(synth.buildOrder) ? synth.buildOrder : []).filter(id => sliceById.has(id))
if (order.length === 0) {
  log('⚠️  Synthesis returned no usable build order; falling back to discovery order.')
  dropped.push('Synthesis returned no usable build order; used discovery order instead.')
  order = slices.map(s => s.id)
}
const ordered = order.map((id, i) => {
  const base = sliceById.get(id)
  const sy = synthById.get(id) || {}
  return { ...base, ...sy, id, n: i + 1, epicId: sy.epicId || base.epicId }
})

// Consolidated behavioral spec — the single surface that flags coverage gaps
// loudly (the per-slice tests are drawn from here). Written from the extracted
// behavior data; agent invents nothing.
const behaviorIndex = slices.map(s => ({
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
// Phase 3 — Write one self-contained, self-testing vertical-slice doc per unit.
// Distinct file paths → safe to fan out without worktree isolation.
// ===========================================================================
phase('Write slices')
const written = await pooled(ordered.map((s) => () => {
  const path = `${OUT}/epics/${slug(s.epicId)}/${pad(s.n)}-${slug(s.name)}.md`
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
const sliceDocs = written.filter(Boolean)
log(`Wrote ${sliceDocs.filter(d => d.ok).length}/${ordered.length} slice docs.`)

// ===========================================================================
// Phase 4 — Per-target prescriptive mapping layer (neutral core untouched).
// One dep-map + hazards doc per target, plus capped per-slice hints.
// ===========================================================================
if (TARGET) {
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

// ===========================================================================
// Phase 5 — Critic: grounding + completeness, then a budget-bounded gap-fill.
// ===========================================================================
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

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
return {
  ok: true,
  outDir: OUT,
  target: TARGET || null,
  counts: {
    epics: epics.length,
    slicesDiscovered: allSlices.length,
    slicesWritten: sliceDocs.filter(d => d.ok).length,
    slicesPlanned: ordered.length,
    gapsRemaining: gaps.length,
    gapsRemainingHumanDecision: gaps.filter(g => !g.fixable).length,
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
