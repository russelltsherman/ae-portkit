// Unit tests for the PURE deterministic helpers in portkit.js.
//
// portkit.js is a Workflow script: it has top-level `await agent(...)` and relies
// on injected globals (agent/log/phase/budget) that do not exist under node:test,
// so it cannot be imported. Instead we read the file, slice out the fenced
// `<portkit:deterministic>` region, and evaluate ONLY that region via new Function().
// The fenced region is therefore the SINGLE SOURCE OF TRUTH — no second copy, no
// codegen, no drift guard: these tests run the exact code that ships in the workflow.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, 'portkit.js')
const OPEN = '// <portkit:deterministic>'
const CLOSE = '// </portkit:deterministic>'

// Exported helper names the region is expected to define (grown as slices land).
const EXPORTS = ['topoSort', 'rewriteEdges', 'buildFeatureTree', 'projectAgents', 'planFeatureBatches', 'parseArgs', 'stageDone', 'stageIndex', 'stageList', 'stopAfter', 'stageAfter', 'chunk', 'slug', 'pad', 'specName', 'adrName', 'sliceId', 'featureId', 'adrId', 'budgetExhausted', 'findSourceCitations', 'planResume', 'omissionScopeNote']

function readRegion() {
  const src = readFileSync(SRC, 'utf8')
  const start = src.indexOf(OPEN)
  const end = src.indexOf(CLOSE)
  assert.ok(start !== -1, `missing ${OPEN} marker in portkit.js`)
  assert.ok(end !== -1, `missing ${CLOSE} marker in portkit.js`)
  assert.ok(end > start, 'deterministic region markers are out of order')
  return src.slice(start + OPEN.length, end)
}

// Strip block + line comments so purity/scan checks see executable code only.
// The fence comments intentionally NAME banned tokens (agent/require/Date.now/…),
// so a naive substring scan would false-positive — we must scan code, not prose.
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // line comments (leave http:// alone-ish)
}

// Evaluate the region and return its helper functions. Uses typeof guards so an
// empty/partial region (early slices) yields `undefined` for not-yet-implemented
// helpers rather than throwing a ReferenceError.
function loadDeterministic() {
  const region = readRegion()
  const ret = `return { ${EXPORTS.map(n => `${n}: typeof ${n} === 'function' ? ${n} : undefined`).join(', ')} }`
  // eslint-disable-next-line no-new-func
  return new Function(`${region}\n;${ret}`)()
}

test('deterministic region exists and is delimited', () => {
  const region = readRegion()
  assert.ok(region.length > 0, 'deterministic region is empty')
})

test('deterministic region is pure (no injected globals / nondeterminism)', () => {
  const code = stripComments(readRegion())
  const banned = [
    /\bagent\s*\(/, /\blog\s*\(/, /\bphase\s*\(/, /\bbudget\b/,
    /\brequire\s*\(/, /\bimport\s+/, /\bDate\s*\.\s*now/, /\bMath\s*\.\s*random/,
    /\bnew\s+Date\b/,
  ]
  for (const re of banned) {
    assert.ok(!re.test(code), `deterministic region must not use ${re} (impurity/nondeterminism)`)
  }
})

test('region evaluates without throwing', () => {
  assert.doesNotThrow(() => loadDeterministic())
})

// --- topoSort ---------------------------------------------------------------
const sl = (id, ...deps) => ({ id, dependsOn: deps })

test('topoSort: empty input', () => {
  const { topoSort } = loadDeterministic()
  assert.deepEqual(topoSort([]), { order: [], notes: [] })
})

test('topoSort: linear chain orders prerequisites first', () => {
  const { topoSort } = loadDeterministic()
  const { order, notes } = topoSort([sl('C', 'B'), sl('B', 'A'), sl('A')])
  assert.deepEqual(order, ['A', 'B', 'C'])
  assert.deepEqual(notes, [])
})

test('topoSort: diamond keeps discovery order for ties', () => {
  const { topoSort } = loadDeterministic()
  const { order } = topoSort([sl('A'), sl('B', 'A'), sl('C', 'A'), sl('D', 'B', 'C')])
  assert.deepEqual(order, ['A', 'B', 'C', 'D']) // B before C (discovery order), not C before B
})

test('topoSort: disconnected roots both appear', () => {
  const { topoSort } = loadDeterministic()
  const { order } = topoSort([sl('A'), sl('B'), sl('C', 'A')])
  assert.deepEqual(order, ['A', 'B', 'C'])
})

test('topoSort: unknown dep is ignored + noted, slice still ordered', () => {
  const { topoSort } = loadDeterministic()
  const { order, notes } = topoSort([sl('A', 'Z')])
  assert.deepEqual(order, ['A'])
  assert.equal(notes.length, 1)
  assert.match(notes[0], /unknown id "Z"/)
})

test('topoSort: self-edge ignored + noted', () => {
  const { topoSort } = loadDeterministic()
  const { order, notes } = topoSort([sl('A', 'A')])
  assert.deepEqual(order, ['A'])
  assert.equal(notes.length, 1)
  assert.match(notes[0], /dependsOn itself/)
})

test('topoSort: duplicate dep counted once (parallel-edge dedupe)', () => {
  const { topoSort } = loadDeterministic()
  const { order, notes } = topoSort([sl('A'), sl('B', 'A', 'A')])
  assert.deepEqual(order, ['A', 'B'])
  assert.deepEqual(notes, [])
})

test('topoSort: 2-cycle appended in discovery order + noted, nothing dropped', () => {
  const { topoSort } = loadDeterministic()
  const { order, notes } = topoSort([sl('A', 'B'), sl('B', 'A')])
  assert.deepEqual(order.slice().sort(), ['A', 'B'])
  assert.deepEqual(order, ['A', 'B']) // discovery order
  assert.equal(notes.length, 1)
  assert.match(notes[0], /cycle/i)
})

test('topoSort: 3-cycle, all members retained', () => {
  const { topoSort } = loadDeterministic()
  const { order, notes } = topoSort([sl('A', 'C'), sl('B', 'A'), sl('C', 'B')])
  assert.deepEqual(order, ['A', 'B', 'C'])
  assert.equal(notes.length, 1)
})

test('topoSort: partial cycle keeps acyclic prefix then cyclic remainder', () => {
  const { topoSort } = loadDeterministic()
  // root R is acyclic; X<->Y form a cycle that also depends on R
  const { order, notes } = topoSort([sl('R'), sl('X', 'R', 'Y'), sl('Y', 'X')])
  assert.equal(order[0], 'R') // acyclic prefix first
  assert.deepEqual(order.slice(1).sort(), ['X', 'Y'])
  assert.equal(notes.length, 1)
})

// --- rewriteEdges ------------------------------------------------------------
const slE = (id, featureKey, ...deps) => ({ id, featureKey, dependsOn: deps })

test('rewriteEdges: simple merge removes merged-away slice + records provenance', () => {
  const { rewriteEdges } = loadDeterministic()
  const { slices } = rewriteEdges([sl('A'), sl('B'), sl('C', 'B')], { B: 'A' })
  assert.deepEqual(slices.map(s => s.id), ['A', 'C'])
  assert.deepEqual(slices.find(s => s.id === 'A').mergedFrom, ['B'])
  assert.deepEqual(slices.find(s => s.id === 'C').dependsOn, ['A']) // dep B remapped to A
})

test('rewriteEdges: self-edge created by merge is dropped', () => {
  const { rewriteEdges } = loadDeterministic()
  const { slices } = rewriteEdges([sl('A', 'B'), sl('B')], { B: 'A' })
  assert.deepEqual(slices.map(s => s.id), ['A'])
  assert.deepEqual(slices[0].dependsOn, []) // A->B became A->A, dropped
})

test('rewriteEdges: parallel edges deduped after merge', () => {
  const { rewriteEdges } = loadDeterministic()
  const { slices } = rewriteEdges([sl('A'), sl('B'), sl('C', 'A', 'B')], { B: 'A' })
  assert.deepEqual(slices.find(s => s.id === 'C').dependsOn, ['A']) // [A,B]->[A,A]->[A]
})

test('rewriteEdges: survivor inherits absorbed slice deps (enables cycle detection)', () => {
  const { rewriteEdges, topoSort } = loadDeterministic()
  // X->Y, Z->X, merge Z into Y: Y inherits Z's dep on X, X depends on Y => cycle
  const { slices } = rewriteEdges([sl('X', 'Y'), sl('Y'), sl('Z', 'X')], { Z: 'Y' })
  assert.deepEqual(slices.map(s => s.id), ['X', 'Y'])
  assert.deepEqual(slices.find(s => s.id === 'Y').dependsOn, ['X']) // inherited from Z
  const { order, notes } = topoSort(slices)
  assert.deepEqual(order.slice().sort(), ['X', 'Y']) // nothing dropped
  assert.equal(notes.length, 1)
  assert.match(notes[0], /cycle/i)
})

test('rewriteEdges: merge target that is not a real slice is ignored (no drop)', () => {
  const { rewriteEdges } = loadDeterministic()
  const { slices } = rewriteEdges([sl('A'), sl('B')], { B: 'GHOST' })
  assert.deepEqual(slices.map(s => s.id).sort(), ['A', 'B']) // B kept, not merged into a ghost
})

test('rewriteEdges: transitive 3-way merge collapses to one survivor', () => {
  const { rewriteEdges } = loadDeterministic()
  // C->B->A in the merge map; all collapse into A
  const { slices } = rewriteEdges([sl('A'), sl('B'), sl('C')], { B: 'A', C: 'B' })
  assert.deepEqual(slices.map(s => s.id), ['A'])
  assert.deepEqual(slices[0].mergedFrom.slice().sort(), ['B', 'C'])
})

// --- buildFeatureTree -----------------------------------------------------------
test('buildFeatureTree: groups by feature preserving first-appearance order', () => {
  const { buildFeatureTree } = loadDeterministic()
  const tree = buildFeatureTree([slE('A', 'e1'), slE('B', 'e2'), slE('C', 'e1')])
  assert.deepEqual(tree, [
    { featureKey: 'e1', sliceIds: ['A', 'C'] },
    { featureKey: 'e2', sliceIds: ['B'] },
  ])
})

// --- synthesis composition (the workflow's merge -> rewrite -> topo pipeline) --
// Mirrors the glue in the Synthesize phase: turn agent merge groups into a merge
// map, rewriteEdges, topoSort, then number survivors. Guards the end-to-end
// contract: merged-away ids vanish, every survivor is ordered once, no slice lost.
test('synthesis pipeline: merge groups -> ordered survivors, nothing dropped', () => {
  const { rewriteEdges, topoSort } = loadDeterministic()
  const discovered = [
    sl('A'), sl('B', 'A'), sl('C', 'A'), // C is a duplicate of B
    sl('D', 'B', 'C'),
  ]
  const merges = [{ keep: 'B', merge: ['C'] }] // agent says B and C are the same
  const mergeMap = {}
  for (const m of merges) for (const f of m.merge) if (f !== m.keep) mergeMap[f] = m.keep

  const rewritten = rewriteEdges(discovered, mergeMap)
  const { order } = topoSort(rewritten.slices)
  const survivorById = new Map(rewritten.slices.map(s => [s.id, s]))
  const ordered = order.map((id, i) => ({ ...survivorById.get(id), n: i + 1 }))

  assert.deepEqual(ordered.map(s => s.id), ['A', 'B', 'D']) // C merged away, gone from order
  assert.deepEqual(ordered.map(s => s.n), [1, 2, 3]) // sequential numbering
  assert.deepEqual(survivorById.get('B').mergedFrom, ['C'])
  assert.deepEqual(survivorById.get('D').dependsOn, ['B']) // [B,C] -> [B,B] -> [B]
})

test('topoSort: large chain retains every slice (no truncation)', () => {
  const { topoSort } = loadDeterministic()
  const N = 500
  const big = Array.from({ length: N }, (_, i) => sl(`s${i}`, ...(i ? [`s${i - 1}`] : [])))
  const { order, notes } = topoSort(big)
  assert.equal(order.length, N) // nothing dropped at scale
  assert.deepEqual(notes, [])
  assert.equal(order[0], 's0')
  assert.equal(order[N - 1], `s${N - 1}`)
})

// Regression guard: no SILENT, always-on slice truncation. Slices are the
// deliverable; re-introducing the removed silent `MAX_SLICES` cap or a
// `cap(allSlices, …)` would drop them from every run. The ONLY permitted trim is the
// opt-in, off-by-default `limitSlices` DEV/TEST knob (loudly reported), so we also
// assert it defaults to unlimited (0) rather than some nonzero production default.
test('portkit.js does not silently truncate the slice list (limitSlices stays opt-in)', () => {
  const src = readFileSync(SRC, 'utf8')
  assert.ok(!/MAX_SLICES/.test(src), 'a MAX_SLICES cap was reintroduced')
  assert.ok(!/cap\(\s*allSlices/.test(src), 'cap(allSlices, …) truncation was reintroduced')
  assert.ok(/Number\(cfg\.limitSlices\)\s*\|\|\s*0/.test(src), 'limitSlices must default to 0 (unlimited)')
})

// --- projectAgents -----------------------------------------------------------
test('projectAgents: base run (no ADRs) sums the fan-out', () => {
  const { projectAgents } = loadDeterministic()
  // fixed 9 + 2*features + slices + 0 adrs + gapfill
  assert.equal(projectAgents({ featureCount: 4, sliceCount: 20, gapfillRounds: 2 }), 9 + 8 + 20 + 0 + 2)
})

test('projectAgents: ADR fan-out adds min(adrCount, maxAdrs)', () => {
  const { projectAgents } = loadDeterministic()
  // adrCount 30 exceeds maxAdrs 12 -> only 12 ADR writers counted
  assert.equal(projectAgents({ featureCount: 10, sliceCount: 200, adrCount: 30, maxAdrs: 12, gapfillRounds: 2 }),
    9 + 20 + 200 + 12 + 2)
})

test('projectAgents: ADR term is bounded by maxAdrs (fewer ADRs than the cap)', () => {
  const { projectAgents } = loadDeterministic()
  // adrCount 3 is under the cap -> exactly 3 ADR writers counted
  assert.equal(projectAgents({ featureCount: 0, sliceCount: 0, adrCount: 3, maxAdrs: 12 }), 9 + 0 + 0 + 3 + 0)
})

test('projectAgents: grows ~1 per slice (write phase dominates)', () => {
  const { projectAgents } = loadDeterministic()
  const base = projectAgents({ featureCount: 5, sliceCount: 100 })
  const more = projectAgents({ featureCount: 5, sliceCount: 101 })
  assert.equal(more - base, 1)
})

// --- planFeatureBatches ---------------------------------------------------------
const feature = (featureKey, n) => ({ featureKey, sliceIds: Array.from({ length: n }, (_, i) => `${featureKey}.${i}`) })

test('planFeatureBatches: fits whole features under budget into one batch', () => {
  const { planFeatureBatches } = loadDeterministic()
  const batches = planFeatureBatches([feature('a', 2), feature('b', 3)], 10)
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0].featureKeys, ['a', 'b'])
  assert.equal(batches[0].sliceIds.length, 5)
})

test('planFeatureBatches: starts a new batch when the next feature would exceed budget', () => {
  const { planFeatureBatches } = loadDeterministic()
  const batches = planFeatureBatches([feature('a', 3), feature('b', 3), feature('c', 3)], 5)
  assert.deepEqual(batches.map(b => b.featureKeys), [['a'], ['b'], ['c']]) // 3+3>5 each time
})

test('planFeatureBatches: never splits an feature; oversized feature is its own batch', () => {
  const { planFeatureBatches } = loadDeterministic()
  const batches = planFeatureBatches([feature('big', 12), feature('small', 2)], 5)
  assert.equal(batches[0].featureKeys.length, 1)
  assert.equal(batches[0].sliceIds.length, 12) // not split despite > budget
  assert.deepEqual(batches[1].featureKeys, ['small'])
})

test('planFeatureBatches: partitions cover every slice exactly once (no drops)', () => {
  const { planFeatureBatches } = loadDeterministic()
  const tree = [feature('a', 4), feature('b', 4), feature('c', 4), feature('d', 4)]
  const batches = planFeatureBatches(tree, 6)
  const all = batches.flatMap(b => b.sliceIds)
  assert.equal(all.length, 16)
  assert.equal(new Set(all).size, 16) // every slice present once
})

// --- parseArgs ---------------------------------------------------------------
// Normalizes the workflow's `args` input (object / JSON string / CLI string /
// missing) into a structured config. The CLI-string branch is the regression
// fix: when the slash-command bridge forwards the RAW argument string verbatim
// (e.g. "--input /src/myapp" or just "/src/myapp") instead of a built object,
// parsing must still recover inputDir — otherwise the run drifts to SOURCE="."
// (cwd). This is a STACK-NEUTRAL kit: there is no target-language argument.

test('parseArgs: object passed through unchanged (happy path)', () => {
  const { parseArgs } = loadDeterministic()
  const o = { inputDir: '/src/myapp', outputDir: '/out' }
  assert.equal(parseArgs(o), o) // same reference — no copy, no mangling
})

test('parseArgs: JSON object string is parsed', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs('{"inputDir":"/src/myapp","outputDir":"/out"}'),
    { inputDir: '/src/myapp', outputDir: '/out' })
})

test('parseArgs: regression — raw CLI string "--input <dir>"', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs('--input /Users/x/reference/myapp'),
    { inputDir: '/Users/x/reference/myapp' })
})

test('parseArgs: sole positional is the input dir', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs('/src/myapp'), { inputDir: '/src/myapp' })
})

test('parseArgs: --input flag wins over positional input dir', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs('/positional --input /flagged'),
    { inputDir: '/flagged' })
})

test('parseArgs: --output and its aliases map to outputDir', () => {
  const { parseArgs } = loadDeterministic()
  assert.equal(parseArgs('/m --output /a').outputDir, '/a')
  assert.equal(parseArgs('/m --out /b').outputDir, '/b')
  assert.equal(parseArgs('/m --outputDir /c').outputDir, '/c')
})

test('parseArgs: --flag=value form', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs('--input=/src/myapp --output=/out'),
    { inputDir: '/src/myapp', outputDir: '/out' })
})

test('parseArgs: unknown tuning knobs pass through (camelCase preserved)', () => {
  const { parseArgs } = loadDeterministic()
  assert.equal(parseArgs('--input /m --maxAdrs 20').maxAdrs, '20')
})

test('parseArgs: legacy --maxEpics aliases to maxFeatures (epic→feature rename compat)', () => {
  const { parseArgs } = loadDeterministic()
  assert.equal(parseArgs('--input /m --maxEpics 5').maxFeatures, '5')
  assert.equal(parseArgs('--maxEpics=7').maxFeatures, '7')
})

test('parseArgs: empty / missing / non-string-non-object -> {}', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs(''), {})
  assert.deepEqual(parseArgs('   '), {})
  assert.deepEqual(parseArgs(undefined), {})
  assert.deepEqual(parseArgs(null), {})
  assert.deepEqual(parseArgs(42), {})
})

test('parseArgs: bare positional only', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs('some-dir'), { inputDir: 'some-dir' })
})

// --- stageDone (checkpoint ladder) ------------------------------------------
test('stageDone: fresh run (unknown/undefined stage) has done nothing', () => {
  const { stageDone } = loadDeterministic()
  assert.equal(stageDone(undefined, 'mapped'), false)
  assert.equal(stageDone(null, 'writing'), false)
  assert.equal(stageDone('bogus', 'mapped'), false)
})

test('stageDone: a saved stage counts itself and all earlier stages as done', () => {
  const { stageDone } = loadDeterministic()
  assert.equal(stageDone('synthesized', 'mapped'), true)
  assert.equal(stageDone('synthesized', 'discovered'), true)
  assert.equal(stageDone('synthesized', 'synthesized'), true)
})

test('stageDone: later stages are NOT done', () => {
  const { stageDone } = loadDeterministic()
  assert.equal(stageDone('mapped', 'discovered'), false)
  assert.equal(stageDone('discovered', 'writing'), false)
})

test('stageDone: partial discovery is not complete discovery', () => {
  const { stageDone } = loadDeterministic()
  assert.equal(stageDone('discovering', 'mapped'), true) // map is done
  assert.equal(stageDone('discovering', 'discovered'), false) // discovery is not
})

test('stageDone: an unknown target is never satisfied', () => {
  const { stageDone } = loadDeterministic()
  assert.equal(stageDone('writing', 'bogus'), false)
})

// --- stage ladder: critiqued/distilled promoted to first-class stages --------
test('stageList: is the ordered ladder incl. the new terminal critiqued/distilled', () => {
  const { stageList } = loadDeterministic()
  assert.deepEqual(stageList(), ['mapped', 'discovering', 'discovered', 'synthesized', 'docs', 'adrs', 'writing', 'critiqued', 'distilled'])
})

test('stageIndex/stageDone extend cleanly to the new stages', () => {
  const { stageIndex, stageDone } = loadDeterministic()
  assert.ok(stageIndex('critiqued') > stageIndex('writing'))
  assert.ok(stageIndex('distilled') > stageIndex('critiqued'))
  // a resume past the critic counts writing/adrs/etc as done, and the critic itself
  assert.equal(stageDone('critiqued', 'writing'), true)
  assert.equal(stageDone('critiqued', 'critiqued'), true)
  assert.equal(stageDone('critiqued', 'distilled'), false)
  assert.equal(stageDone('distilled', 'critiqued'), true)
})

// --- stopAfter (per-phase ceiling) ------------------------------------------
test('stopAfter: no ceiling (null/undefined) never pauses — the /portkit full-run path', () => {
  const { stopAfter } = loadDeterministic()
  for (const s of ['mapped', 'discovered', 'docs', 'adrs', 'writing', 'critiqued', 'distilled']) {
    assert.equal(stopAfter(s, null), false, `${s} must not pause without a ceiling`)
    assert.equal(stopAfter(s, undefined), false)
  }
})

test('stopAfter: pauses once the current stage reaches or passes the ceiling', () => {
  const { stopAfter } = loadDeterministic()
  // ceiling = 'docs': earlier stages keep going, docs and beyond pause
  assert.equal(stopAfter('mapped', 'docs'), false)
  assert.equal(stopAfter('discovered', 'docs'), false)
  assert.equal(stopAfter('docs', 'docs'), true)
  assert.equal(stopAfter('adrs', 'docs'), true) // already past the ceiling -> still pauses
})

test('stopAfter: /portkit-map stops only at mapped, not before', () => {
  const { stopAfter } = loadDeterministic()
  assert.equal(stopAfter('mapped', 'mapped'), true)
  // there is no earlier real stage than mapped; unknown current stage never pauses
  assert.equal(stopAfter('bogus', 'mapped'), false)
})

test('stopAfter: an unknown ceiling fails open to a full run (never pauses)', () => {
  const { stopAfter } = loadDeterministic()
  assert.equal(stopAfter('mapped', 'bogus'), false)
  assert.equal(stopAfter('distilled', 'typo'), false)
})

// --- stageAfter (next-phase hint) -------------------------------------------
test('stageAfter: returns the following ladder stage, null past the end', () => {
  const { stageAfter } = loadDeterministic()
  assert.equal(stageAfter('mapped'), 'discovering')
  assert.equal(stageAfter('adrs'), 'writing')
  assert.equal(stageAfter('writing'), 'critiqued')
  assert.equal(stageAfter('critiqued'), 'distilled')
  assert.equal(stageAfter('distilled'), null)
  assert.equal(stageAfter('bogus'), null)
})

// --- chunk -------------------------------------------------------------------
test('chunk: splits into fixed-size, order-preserving groups', () => {
  const { chunk } = loadDeterministic()
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('chunk: exact multiple splits evenly', () => {
  const { chunk } = loadDeterministic()
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
})

test('chunk: empty input -> no groups', () => {
  const { chunk } = loadDeterministic()
  assert.deepEqual(chunk([], 3), [])
})

test('chunk: non-positive size -> a single group (or none when empty)', () => {
  const { chunk } = loadDeterministic()
  assert.deepEqual(chunk([1, 2, 3], 0), [[1, 2, 3]])
  assert.deepEqual(chunk([], 0), [])
})

test('chunk: covers every item exactly once (no drops)', () => {
  const { chunk } = loadDeterministic()
  const items = Array.from({ length: 37 }, (_, i) => i)
  const flat = chunk(items, 8).flat()
  assert.equal(flat.length, 37)
  assert.deepEqual(flat, items)
})

// --- slug / pad / specName (spec filename = INDEX link, single source of truth) ---
// Regression guard for the dangling-INDEX-link bug: spec FILES are named with a
// 48-char-truncated slug, but the INDEX writer used to recompute an UNtruncated slug
// for its links, so any slice name longer than 48 chars produced a link that 404'd
// against the file on disk — even on a fully successful run. Both sides now derive from
// specName(), so these tests pin that the filename is stable and truncated.

test('slug: truncates to 48 characters', () => {
  const { slug } = loadDeterministic()
  const long = 'a'.repeat(100)
  assert.equal(slug(long).length, 48)
})

test('slug: kebab-cases, lowercases, trims, and never empty', () => {
  const { slug } = loadDeterministic()
  assert.equal(slug('Hello World!'), 'hello-world')
  assert.equal(slug('  __Foo__  '), 'foo')
  assert.equal(slug('***'), 'slice') // no alphanumerics -> fallback
})

test('pad: zero-pads a build number to 4 digits', () => {
  const { pad } = loadDeterministic()
  assert.equal(pad(1), '0001')
  assert.equal(pad(42), '0042')
  assert.equal(pad(1234), '1234')
})

test('specName: <SliceID>-<slug>.md, id-prefixed + slug truncated to 48 chars', () => {
  const { specName, slug, sliceId } = loadDeterministic()
  // Normal case: a terse handle produces a clean, short, self-identifying filename.
  assert.equal(specName(1, 'init-dispatch'), 'SL-0001-init-dispatch.md')
  // A long label is still capped (regression guard for the dangling-INDEX-link bug: both
  // the file writer and the INDEX link derive from specName, so they can't disagree).
  const label = 'Default config schema and DEFAULT_CONFIG constant'
  const got = specName(1, label)
  assert.equal(got, `${sliceId(1)}-${slug(label)}.md`)
  assert.ok(got.startsWith('SL-0001-'), 'filename carries the canonical Slice ID')
  const untruncated = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  assert.notEqual(`${sliceId(1)}-${untruncated}.md`, got)
})

test('adrName: <ADR-ID>-<slug>.md, id-prefixed single source of truth', () => {
  const { adrName, slug, adrId } = loadDeterministic()
  assert.equal(adrName(1, 'two-file-persistence'), 'ADR-0001-two-file-persistence.md')
  assert.equal(adrName(5, 'write-acl-matrix'), 'ADR-0005-write-acl-matrix.md')
  assert.equal(adrName(5, 'write-acl-matrix'), `${adrId(5)}-${slug('write-acl-matrix')}.md`)
})

// --- canonical DISPLAY ids (SL-/FEAT-/ADR-) — deterministic, user-facing, tested like specName ---
test('sliceId: SL-<NNNN> zero-padded to 4 digits, composes with pad', () => {
  const { sliceId, pad } = loadDeterministic()
  assert.equal(sliceId(1), 'SL-0001')
  assert.equal(sliceId(42), 'SL-0042')
  assert.equal(sliceId(1234), 'SL-1234')
  assert.equal(sliceId(7), `SL-${pad(7)}`)
})

test('featureId: FEAT-<NN> zero-padded to 2 digits, overflows to 3 past 99', () => {
  const { featureId } = loadDeterministic()
  assert.equal(featureId(1), 'FEAT-01')
  assert.equal(featureId(9), 'FEAT-09')
  assert.equal(featureId(10), 'FEAT-10')
  assert.equal(featureId(100), 'FEAT-100') // documented overflow: never truncates
})

test('adrId: ADR-<NNNN> zero-padded to 4 digits, composes with pad', () => {
  const { adrId, pad } = loadDeterministic()
  assert.equal(adrId(1), 'ADR-0001')
  assert.equal(adrId(12), 'ADR-0012')
  assert.equal(adrId(12), `ADR-${pad(12)}`)
})

// --- house style + document templates (source-grep: they live OUTSIDE the fence, so
// loadDeterministic() can't see them — assert on the file text, like existing source guards).
// These pin the single-source-of-truth document skeletons that kill per-writer variance.
const FULL_SRC = readFileSync(SRC, 'utf8')

test('HOUSE_STYLE: names the canonical id prefixes and BANS the old vocabulary', () => {
  assert.match(FULL_SRC, /const HOUSE_STYLE\s*=/, 'HOUSE_STYLE constant is defined')
  for (const prefix of ['SL-NNNN', 'FEAT-NN', 'ADR-NNNN']) {
    assert.ok(FULL_SRC.includes(prefix), `HOUSE_STYLE-era text references ${prefix}`)
  }
  // the ban list must literally name the retired words so writers never emit them
  assert.match(FULL_SRC, /"epic", "capability", or "vertical thread"/, 'HOUSE_STYLE forbids epic/capability/vertical thread')
})

test('SLICE_SPEC_TEMPLATE: exact metadata header + section headings, single source of truth', () => {
  assert.match(FULL_SRC, /const SLICE_SPEC_TEMPLATE\s*=/, 'SLICE_SPEC_TEMPLATE is defined')
  for (const label of ['**Slice ID:**', '**Build #:**', '**Feature:**', '**Status:**', '**Depends on:**']) {
    assert.ok(FULL_SRC.includes(label), `slice spec metadata header has ${label}`)
  }
  for (const h of ['## Summary', '## Behavior Thread', '## Interface & Contract',
    '## Acceptance Criteria', '## Build Steps', '## Shared Conventions']) {
    assert.ok(FULL_SRC.includes(h), `slice spec skeleton has heading ${h}`)
  }
})

test('doc-family templates are all defined with their signature headings', () => {
  for (const name of ['ARCHITECTURE_TEMPLATE', 'PRD_TEMPLATE', 'ADR_TEMPLATE',
    'INDEX_TEMPLATE', 'ACCEPTANCE_TEMPLATE', 'GLOSSARY_TEMPLATE']) {
    assert.match(FULL_SRC, new RegExp(`const ${name}\\s*=`), `${name} is defined`)
  }
  assert.ok(FULL_SRC.includes('## Tech Stack & Build/Test'), 'ARCHITECTURE heading present')
  assert.ok(FULL_SRC.includes('## Functional Requirements'), 'PRD heading present')
  assert.ok(FULL_SRC.includes('**ADR ID:**'), 'ADR metadata present')
  assert.ok(FULL_SRC.includes('## Recommended Build Order'), 'INDEX heading present')
  assert.ok(FULL_SRC.includes('## Coverage Summary'), 'ACCEPTANCE heading present')
})

test('regression: the old free-form "Include, in this order" checklist is gone', () => {
  assert.ok(!FULL_SRC.includes('Include, in this order:'),
    'writers must fill the rigid skeleton, not a free-form content checklist')
})

// --- budgetExhausted (token/subscription-window voluntary-yield decision) ---
// PURE decision: takes plain numbers (never the `budget` object), so the impure wrapper
// that reads the runtime `budget` global can delegate the comparison here and stay testable.

test('budgetExhausted: unlimited ceiling never yields (byte-identical to no-budget today)', () => {
  const { budgetExhausted } = loadDeterministic()
  for (const total of [undefined, null, 0, -1, Infinity, NaN]) {
    assert.equal(budgetExhausted(total, 999_999, 50_000), false, `total=${total}`)
  }
})

test('budgetExhausted: yields only once remaining falls to the reserve', () => {
  const { budgetExhausted } = loadDeterministic()
  assert.equal(budgetExhausted(100_000, 40_000, 50_000), false) // 60k remaining > 50k reserve
  assert.equal(budgetExhausted(100_000, 60_000, 50_000), true)  // 40k remaining <= 50k reserve
  assert.equal(budgetExhausted(100_000, 50_000, 50_000), true)  // boundary: exactly reserve -> yield
})

test('budgetExhausted: overspend (spent > total) yields', () => {
  const { budgetExhausted } = loadDeterministic()
  assert.equal(budgetExhausted(100_000, 130_000, 50_000), true)
})

test('budgetExhausted: zero reserve yields only when fully spent', () => {
  const { budgetExhausted } = loadDeterministic()
  assert.equal(budgetExhausted(100_000, 99_999, 0), false)
  assert.equal(budgetExhausted(100_000, 100_000, 0), true)
  assert.equal(budgetExhausted(100_000, undefined, 0), false) // spent defaults to 0
})

// --- findSourceCitations (contract for the distill pass) ---
// The single definition of "a source citation" that the distiller strips and its verify step
// checks. Samples are drawn from real generated kit prose.

test('findSourceCitations: matches backticked and bare path:line refs, with ranges and lists', () => {
  const { findSourceCitations } = loadDeterministic()
  assert.deepEqual(
    findSourceCitations('`getConfigDir` (`src/utils/config.ts:191-193`) delegates to resolveWorktreeRoot.'),
    ['`src/utils/config.ts:191-193`'])
  assert.deepEqual(
    findSourceCitations('normalized to a map on read, src/utils/config.ts:219-229.'),
    ['src/utils/config.ts:219-229'])
  assert.deepEqual(
    findSourceCitations('the six built-in types (`src/schemas/record.ts:1-7`, `builtins.ts:12`).'),
    ['`src/schemas/record.ts:1-7`', '`builtins.ts:12`'])
  // comma-list of lines
  assert.deepEqual(findSourceCitations('see `record.ts:41,43`'), ['`record.ts:41,43`'])
})

test('findSourceCitations: does NOT match artifact paths, tags, or ratios (kept in the clean kit)', () => {
  const { findSourceCitations } = loadDeterministic()
  assert.deepEqual(findSourceCitations('write to `.config/settings.yaml` and `.config/templates/`'), [])
  assert.deepEqual(findSourceCitations('`[INFERRED]` the goal is to accumulate expertise.'), [])
  assert.deepEqual(findSourceCitations('This is `[UNVERIFIED]` — no test covers it.'), [])
  assert.deepEqual(findSourceCitations('a ratio of 10:30 and a time 09:05'), [])
  assert.deepEqual(findSourceCitations('the src/utils/ directory holds helpers'), []) // no file:line
})

test('findSourceCitations: none in already-clean prose', () => {
  const { findSourceCitations } = loadDeterministic()
  assert.deepEqual(findSourceCitations('The config is a YAML map keyed by domain name. `[INFERRED]` intent.'), [])
})

// --- planResume (resume decision core) --------------------------------------
// The static source has a FIXED slice decomposition, so a resume must RELOAD durable
// structure (light.json), never re-discover it — re-discovery changes the slice set and
// renumbers every downstream spec (the duplicate-rewrite bug). A missing behavior.json
// ALONE triggers a behavior-only re-run, not re-discovery.
const ep = (id) => ({ id })

test('planResume: light-only features are RELOADED, never re-discovered', () => {
  const { planResume } = loadDeterministic()
  const scan = [{ id: 'a', hasLight: true, hasBehavior: true }, { id: 'b', hasLight: true, hasBehavior: true }]
  const plan = planResume([ep('a'), ep('b')], scan)
  assert.deepEqual(plan.reload, ['a', 'b'])
  assert.deepEqual(plan.discover, []) // NOTHING re-discovered when structure is on disk
  assert.deepEqual(plan.behaviorOnly, [])
})

test('planResume: REGRESSION — missing behavior side-car re-runs behavior only (no re-discovery/renumber)', () => {
  const { planResume } = loadDeterministic()
  // The failure case: structure present, behavior agent had failed for 3 features.
  const scan = [
    { id: 'cli-init', hasLight: true, hasBehavior: true },
    { id: 'cli-edit', hasLight: true, hasBehavior: false },
    { id: 'cli-query', hasLight: true, hasBehavior: false },
    { id: 'cli-setup', hasLight: true, hasBehavior: false },
  ]
  const plan = planResume([ep('cli-init'), ep('cli-edit'), ep('cli-query'), ep('cli-setup')], scan)
  // Every feature's STRUCTURE is reloaded — so the slice set (and numbering) is invariant.
  assert.deepEqual(plan.reload, ['cli-init', 'cli-edit', 'cli-query', 'cli-setup'])
  // The three with a missing behavior spec re-run behavior ONLY.
  assert.deepEqual(plan.behaviorOnly, ['cli-edit', 'cli-query', 'cli-setup'])
  // Critically: NONE are re-discovered. Re-discovery is what renumbered and duplicated.
  assert.deepEqual(plan.discover, [])
})

test('planResume: a feature with no light.json needs full discovery', () => {
  const { planResume } = loadDeterministic()
  const scan = [{ id: 'a', hasLight: true, hasBehavior: true }]
  const plan = planResume([ep('a'), ep('b')], scan) // b never analyzed
  assert.deepEqual(plan.reload, ['a'])
  assert.deepEqual(plan.discover, ['b'])
  assert.deepEqual(plan.behaviorOnly, [])
})

test('planResume: preserves `features` order (build numbering stays identical to a fresh run)', () => {
  const { planResume } = loadDeterministic()
  const scan = [ // deliberately scrambled vs. features order
    { id: 'c', hasLight: true, hasBehavior: true },
    { id: 'a', hasLight: true, hasBehavior: false },
    { id: 'b', hasLight: true, hasBehavior: true },
  ]
  const plan = planResume([ep('a'), ep('b'), ep('c')], scan)
  assert.deepEqual(plan.reload, ['a', 'b', 'c']) // features order, NOT scan order
})

test('planResume: every feature is classified exactly once (no drops, no double-count)', () => {
  const { planResume } = loadDeterministic()
  const scan = [
    { id: 'a', hasLight: true, hasBehavior: true },
    { id: 'b', hasLight: true, hasBehavior: false },
    // c absent from scan entirely
  ]
  const features = [ep('a'), ep('b'), ep('c')]
  const plan = planResume(features, scan)
  // reload ∪ discover covers all; behaviorOnly ⊆ reload.
  assert.deepEqual([...plan.reload, ...plan.discover].sort(), ['a', 'b', 'c'])
  assert.ok(plan.behaviorOnly.every(id => plan.reload.includes(id)))
  assert.equal(plan.reload.length + plan.discover.length, features.length)
})

test('planResume: empty / missing inputs are safe', () => {
  const { planResume } = loadDeterministic()
  assert.deepEqual(planResume([], []), { reload: [], behaviorOnly: [], discover: [] })
  assert.deepEqual(planResume(undefined, undefined), { reload: [], behaviorOnly: [], discover: [] })
  assert.deepEqual(planResume([ep('a')], null), { reload: [], behaviorOnly: [], discover: ['a'] })
})

// --- omissionScopeNote (tell the critic/gap-fill that a DEV/TEST truncation is INTENTIONAL) ---

test('omissionScopeNote: no intentional omission -> empty string (full run prompts byte-identical)', () => {
  const { omissionScopeNote } = loadDeterministic()
  assert.equal(omissionScopeNote({ slicesOmittedForTest: 0, limitSlices: 0, featuresKept: 3, featuresTotal: 3 }), '')
  assert.equal(omissionScopeNote({}), '')
  assert.equal(omissionScopeNote(), '')
  // featuresKept >= featuresTotal (no cap) and no slices omitted is also empty.
  assert.equal(omissionScopeNote({ featuresKept: 5, featuresTotal: 3 }), '')
})

test('omissionScopeNote: limitSlices omission names the count + the do-NOT-backfill directives', () => {
  const { omissionScopeNote } = loadDeterministic()
  const note = omissionScopeNote({ slicesOmittedForTest: 7, limitSlices: 3, featuresKept: 2, featuresTotal: 2 })
  assert.match(note, /INTENTIONAL TEST-SCOPE/)
  assert.match(note, /7 slice spec\(s\) were INTENTIONALLY omitted/)
  assert.match(note, /limitSlices=3/)
  assert.match(note, /do NOT .*regenerate|back-fill/i)
  // it must NOT mention a maxFeatures cap when none happened
  assert.ok(!/feature\(ies\) were INTENTIONALLY dropped/.test(note))
})

test('omissionScopeNote: maxFeatures cap names kept-of-total', () => {
  const { omissionScopeNote } = loadDeterministic()
  const note = omissionScopeNote({ slicesOmittedForTest: 0, limitSlices: 0, featuresKept: 2, featuresTotal: 4 })
  assert.match(note, /INTENTIONAL TEST-SCOPE/)
  assert.match(note, /2 feature\(ies\) were INTENTIONALLY dropped/)
  assert.match(note, /2 of 4/)
  assert.ok(!/slice spec\(s\) were INTENTIONALLY omitted/.test(note))
})

test('omissionScopeNote: both arms fire together', () => {
  const { omissionScopeNote } = loadDeterministic()
  const note = omissionScopeNote({ slicesOmittedForTest: 7, limitSlices: 3, featuresKept: 2, featuresTotal: 4 })
  assert.match(note, /7 slice spec\(s\) were INTENTIONALLY omitted/)
  assert.match(note, /2 feature\(ies\) were INTENTIONALLY dropped/)
})

// Full-file syntax gate. portkit.js has top-level `return`/`await`, legal only
// because the runtime wraps the body in an async function — so `node --check`
// (which parses as a plain script) cannot validate it. We mimic the runtime wrap
// and assert the whole body parses. This catches syntax errors `npm test` would
// otherwise miss until a live run.
test('portkit.js body parses as an async function (runtime wrap)', () => {
  let src = readFileSync(SRC, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.doesNotThrow(() =>
    new AsyncFunction('agent', 'parallel', 'pipeline', 'pooled', 'phase', 'log', 'args', 'budget', 'workflow', src))
})
