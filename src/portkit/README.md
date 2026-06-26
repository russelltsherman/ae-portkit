# portkit

A Claude Code plugin that analyzes a codebase into a **target-neutral, vertical-slice build kit** so
a *less capable downstream model* (e.g. a quantized local model under ollama/omlx) can recreate the
project in a different language or framework **from the documents alone** — without reading the
original source.

It produces **documents only**. It does not perform the recreation.

## Why vertical slices

The output is organized by **capability**, not by layer. Each slice is one behavior thread running
top-to-bottom through every layer it touches (entry → validation → rule → data → persistence →
**its tests**), self-contained and independently buildable/testable. Horizontal "all-the-models" /
"all-the-endpoints" docs are demoted to a thin shared **kernel** that slices reference. This is what
lets a weak model build one verifiable piece at a time instead of holding the whole system in
context.

## Usage

```
/portkit <target-lang> [input-dir] [--input <dir>] [--output <dir>]
```

Examples:

```
/portkit go                                  # analyze the current repo; add a Go mapping layer
/portkit rust src/app --output build/portkit # explicit input + output dirs
/portkit rust --input services/api           # input via flag
/portkit                                     # neutral core only, no target layer
```

- **target-lang** — a single target language; one target per run.
- **input dir** — codebase to analyze: positional `[input-dir]` or `--input <dir>`. Default `.`.
- **`--output <dir>`** — where docs are written. Default `<input-dir>/<target-language>`
  (`<input-dir>/.portkit` if no target).

To cover several targets, run again pointed at the same `--output`: the neutral core is reused and
only the new `targets/<lang>/` layer is added.

> **Prerequisite:** the Workflow tool is gated behind an env var. Enable it first:
> `export CLAUDE_CODE_WORKFLOWS=1 && claude`, or persist
> `{ "env": { "CLAUDE_CODE_WORKFLOWS": "1" } }` in `.claude/settings.local.json`.

## Output (`<source>/.portkit/`)

| Path | What |
|---|---|
| `00-system-map.md` | Orientation: languages, build, tests, deps, epic inventory |
| `KERNEL.md` | Naming/type glossary + shared domain vocabulary |
| `kernel/cross-cutting.md` | Auth/config/logging/error/concurrency conventions |
| `epics/INDEX.md` | Epic→slice tree **and topological build order** |
| `epics/<epic>/<NNNN>-<slice>.md` | One self-contained, self-testing vertical slice |
| `targets/<lang>/dependency-map.md` | Per-dep target strategy (equivalent / reimplement / drop / human-decision) |
| `targets/<lang>/porting-hazards.md` | Source-language assumptions that break in the target |
| `targets/<lang>/slice-hints/<NNNN>.md` | Prescriptive per-slice target guidance |
| `RISKS-AND-GAPS.md` | Unverified claims, thin coverage, non-portable deps, open questions |

## How it works

A single dynamic Workflow (`workflows/portkit.js`) runs six phases, fanning out fresh-context
specialist agents:

1. **Map** — survey the repo, draft the capability/epic inventory.
2. **Discover slices** — per epic, trace each capability end-to-end into fine vertical slices, then
   extract the behavioral acceptance spec from the existing tests (pipelined per epic).
3. **Synthesize** — normalize/dedup overlapping slices, decide the kernel/slice boundary, write the
   kernel + index, compute the topological build order.
4. **Write slices** — one self-contained, self-testing slice doc per unit.
5. **Target mapping** — per target: dependency map, porting hazards, prescriptive per-slice hints.
6. **Critic** — grounding + completeness audit → `RISKS-AND-GAPS.md`, with a budget-bounded gap-fill
   loop.

### Tuning knobs (optional `args`)

`inputDir` (default `.`), `outputDir` (default `<inputDir>/<target-language>`, or
`<inputDir>/.portkit` if no target), `maxEpics` (40), `maxHintsPerTarget` (80),
`maxGapfillRounds` (2), `maxAgents` (1000, the over-scale guard's per-run ceiling), `resume`
(internal — set automatically on a continued over-scale pass). (`sourcePath`/`outDir` are accepted as
legacy aliases for `inputDir`/`outputDir`.) **Slices are never capped** — they are the deliverable,
so dropping them is never an option; genuine over-scale is handled by epic-partitioned resumable
passes (see below). The remaining caps exist because the Workflow runtime limits a run to ~1000
agents; anything capped is **logged and recorded in the result's `truncations`** — silent truncation
would read as "complete" when it isn't.

### Over-scale: partition, never truncate

If a single run's projected agent count would approach the runtime's ~1000-agent ceiling, PortKit
runs map/discover/**synthesize once**, persists the synthesized IR under `<outputDir>/.portkit/`,
then writes slice docs in **epic-batched passes**. The run returns `resumeRequired: true` with
`resumeArgs`; re-invoking with those args drains the next batch against the same `outputDir` until
every slice is written. Synthesis (and the shared kernel) is computed exactly once, so the build kit
stays coherent across passes and **no slice is ever dropped**.

## Design constraints baked in

- **Grounding is mandatory** — every nontrivial claim cites `path:line`; unverifiable claims are
  marked `[UNVERIFIED]`, not asserted.
- **Neutral core / target layer separation** — the core is reusable across multiple targets.
- **Tests are the behavioral contract** — thin/missing coverage is flagged loudly, never hidden.
- **Non-portable deps become explicit human-decision items**, not silent guesses.

See `VERIFICATION.md` for how to validate the plugin and the docs it produces.
