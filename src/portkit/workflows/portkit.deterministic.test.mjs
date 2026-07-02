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
const EXPORTS = ['topoSort', 'rewriteEdges', 'buildEpicTree', 'projectAgents', 'planEpicBatches', 'parseArgs', 'stageDone', 'chunk', 'slug', 'pad', 'specName', 'budgetExhausted', 'findSourceCitations']

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
const slE = (id, epicId, ...deps) => ({ id, epicId, dependsOn: deps })

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

// --- buildEpicTree -----------------------------------------------------------
test('buildEpicTree: groups by epic preserving first-appearance order', () => {
  const { buildEpicTree } = loadDeterministic()
  const tree = buildEpicTree([slE('A', 'e1'), slE('B', 'e2'), slE('C', 'e1')])
  assert.deepEqual(tree, [
    { epicId: 'e1', sliceIds: ['A', 'C'] },
    { epicId: 'e2', sliceIds: ['B'] },
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
  // fixed 9 + 2*epics + slices + 0 adrs + gapfill
  assert.equal(projectAgents({ epicCount: 4, sliceCount: 20, gapfillRounds: 2 }), 9 + 8 + 20 + 0 + 2)
})

test('projectAgents: ADR fan-out adds min(adrCount, maxAdrs)', () => {
  const { projectAgents } = loadDeterministic()
  // adrCount 30 exceeds maxAdrs 12 -> only 12 ADR writers counted
  assert.equal(projectAgents({ epicCount: 10, sliceCount: 200, adrCount: 30, maxAdrs: 12, gapfillRounds: 2 }),
    9 + 20 + 200 + 12 + 2)
})

test('projectAgents: ADR term is bounded by maxAdrs (fewer ADRs than the cap)', () => {
  const { projectAgents } = loadDeterministic()
  // adrCount 3 is under the cap -> exactly 3 ADR writers counted
  assert.equal(projectAgents({ epicCount: 0, sliceCount: 0, adrCount: 3, maxAdrs: 12 }), 9 + 0 + 0 + 3 + 0)
})

test('projectAgents: grows ~1 per feature (write phase dominates)', () => {
  const { projectAgents } = loadDeterministic()
  const base = projectAgents({ epicCount: 5, sliceCount: 100 })
  const more = projectAgents({ epicCount: 5, sliceCount: 101 })
  assert.equal(more - base, 1)
})

// --- planEpicBatches ---------------------------------------------------------
const epic = (epicId, n) => ({ epicId, sliceIds: Array.from({ length: n }, (_, i) => `${epicId}.${i}`) })

test('planEpicBatches: fits whole epics under budget into one batch', () => {
  const { planEpicBatches } = loadDeterministic()
  const batches = planEpicBatches([epic('a', 2), epic('b', 3)], 10)
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0].epicIds, ['a', 'b'])
  assert.equal(batches[0].sliceIds.length, 5)
})

test('planEpicBatches: starts a new batch when the next epic would exceed budget', () => {
  const { planEpicBatches } = loadDeterministic()
  const batches = planEpicBatches([epic('a', 3), epic('b', 3), epic('c', 3)], 5)
  assert.deepEqual(batches.map(b => b.epicIds), [['a'], ['b'], ['c']]) // 3+3>5 each time
})

test('planEpicBatches: never splits an epic; oversized epic is its own batch', () => {
  const { planEpicBatches } = loadDeterministic()
  const batches = planEpicBatches([epic('big', 12), epic('small', 2)], 5)
  assert.equal(batches[0].epicIds.length, 1)
  assert.equal(batches[0].sliceIds.length, 12) // not split despite > budget
  assert.deepEqual(batches[1].epicIds, ['small'])
})

test('planEpicBatches: partitions cover every slice exactly once (no drops)', () => {
  const { planEpicBatches } = loadDeterministic()
  const tree = [epic('a', 4), epic('b', 4), epic('c', 4), epic('d', 4)]
  const batches = planEpicBatches(tree, 6)
  const all = batches.flatMap(b => b.sliceIds)
  assert.equal(all.length, 16)
  assert.equal(new Set(all).size, 16) // every slice present once
})

// --- parseArgs ---------------------------------------------------------------
// Normalizes the workflow's `args` input (object / JSON string / CLI string /
// missing) into a structured config. The CLI-string branch is the regression
// fix: when the slash-command bridge forwards the RAW argument string verbatim
// (e.g. "--input /src/mulch" or just "/src/mulch") instead of a built object,
// parsing must still recover inputDir — otherwise the run drifts to SOURCE="."
// (cwd). This is a STACK-NEUTRAL kit: there is no target-language argument.

test('parseArgs: object passed through unchanged (happy path)', () => {
  const { parseArgs } = loadDeterministic()
  const o = { inputDir: '/src/mulch', outputDir: '/out' }
  assert.equal(parseArgs(o), o) // same reference — no copy, no mangling
})

test('parseArgs: JSON object string is parsed', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs('{"inputDir":"/src/mulch","outputDir":"/out"}'),
    { inputDir: '/src/mulch', outputDir: '/out' })
})

test('parseArgs: regression — raw CLI string "--input <dir>"', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs('--input /Users/x/reference/mulch'),
    { inputDir: '/Users/x/reference/mulch' })
})

test('parseArgs: sole positional is the input dir', () => {
  const { parseArgs } = loadDeterministic()
  assert.deepEqual(parseArgs('/src/mulch'), { inputDir: '/src/mulch' })
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
  assert.deepEqual(parseArgs('--input=/src/mulch --output=/out'),
    { inputDir: '/src/mulch', outputDir: '/out' })
})

test('parseArgs: unknown tuning knobs pass through (camelCase preserved)', () => {
  const { parseArgs } = loadDeterministic()
  assert.equal(parseArgs('--input /m --maxAdrs 20').maxAdrs, '20')
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
// for its links, so any feature name longer than 48 chars produced a link that 404'd
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

test('specName: <NNNN>-<slug>.md with the slug truncated to 48 chars', () => {
  const { specName, slug, pad } = loadDeterministic()
  // The exact case observed on disk that dangled: a >48-char name is truncated.
  const name = 'Default config schema and DEFAULT_CONFIG constant'
  const got = specName(1, name)
  assert.equal(got, '0001-default-config-schema-and-default-config-constan.md')
  // It is exactly pad + '-' + capped slug + '.md' (the file writer's construction).
  assert.equal(got, `${pad(1)}-${slug(name)}.md`)
  // And the name part is capped: a re-slugified FULL name (the old buggy INDEX link)
  // would NOT match — which is precisely why the link must reuse specName, not rebuild.
  const untruncated = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  assert.notEqual(`0001-${untruncated}.md`, got)
})

test('specName: short names are not truncated (round-trip stable)', () => {
  const { specName } = loadDeterministic()
  assert.equal(specName(3, 'outputJson helper structured success envelope'),
    '0003-outputjson-helper-structured-success-envelope.md')
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
    findSourceCitations('`getMulchDir` (`src/utils/config.ts:191-193`) delegates to resolveWorktreeRoot.'),
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
  assert.deepEqual(findSourceCitations('write to `.mulch/config.yaml` and `.mulch/expertise/`'), [])
  assert.deepEqual(findSourceCitations('`[INFERRED]` the goal is to accumulate expertise.'), [])
  assert.deepEqual(findSourceCitations('This is `[UNVERIFIED]` — no test covers it.'), [])
  assert.deepEqual(findSourceCitations('a ratio of 10:30 and a time 09:05'), [])
  assert.deepEqual(findSourceCitations('the src/utils/ directory holds helpers'), []) // no file:line
})

test('findSourceCitations: none in already-clean prose', () => {
  const { findSourceCitations } = loadDeterministic()
  assert.deepEqual(findSourceCitations('The config is a YAML map keyed by domain name. `[INFERRED]` intent.'), [])
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
