# portkit

A Claude Code plugin that reverse-engineers a codebase into a **stack-neutral recreation kit** — a
family of standard planning/design documents (PRD, architecture spec, per-slice specs, ADRs,
acceptance criteria) — so a *less capable downstream model* (e.g. a quantized local model under
ollama/omlx) can recreate the software **from the documents alone**, without reading the original
source.

It produces **documents only**. It does not perform the recreation.

## Why slice specs

The kit pairs a small number of system-wide documents (PRD, ARCHITECTURE, ADRs) with one
**slice spec** per feature. Each slice spec is one behavior thread running top-to-bottom
through every layer it touches (entry → validation → rule → data → persistence → **its acceptance
criteria**), self-contained and independently buildable/testable. Shared naming, types, and
cross-cutting conventions live once in `ARCHITECTURE.md`, which every slice spec references instead
of restating. This is what lets a weak model build one verifiable piece at a time instead of holding
the whole system in context.

## Terminology

The kit uses one word per concept, everywhere. Each generated kit also ships this as `GLOSSARY.md`.

| Term | Meaning | Canonical id |
|---|---|---|
| **Feature** | A coarse, externally-observable area of the system (an endpoint group, CLI command, public API surface, event/job, UI flow). The grouping level. | `FEAT-NN` |
| **Slice** | One fine vertical behavior thread within a feature — independently buildable & testable end-to-end. The unit a spec documents (one `specs/*.md` per slice, in build order). | `SL-NNNN` |
| **ADR** | An Architecture Decision Record for one significant, evidence-backed decision. | `ADR-NNNN` |

Canonical ids are **deterministic** (a slice's `SL-NNNN` is its build number; a feature's `FEAT-NN`
is its order in the map) and JS-owned, so specs, `INDEX.md`, and ADRs never disagree on how a unit is
named. Internally the engine still assigns each unit an opaque discovery **key** to wire the
dependency graph — that key never appears in the output; only the canonical id does.

> **Note (for maintainers):** earlier versions used `epic` (→ **Feature**) and `capability`
> (→ **Feature**) internally and called a slice a "feature" in the output. The vocabulary was unified
> to **Feature / Slice**; the `maxEpics` arg is still accepted as a legacy alias for `maxFeatures`.

## Usage

```
/portkit [input-dir] [--input <dir>] [--output <dir>]
```

Examples:

```
/portkit                                  # analyze the current repo
/portkit src/app --output build/kit       # explicit input + output dirs
/portkit --input services/api             # input via flag
```

- **input dir** — codebase to analyze: positional `[input-dir]` or `--input <dir>`. Default `.`.
- **`--output <dir>`** — where docs are written. Default `<input-dir>_portkit` (a sibling of the
  input dir; output is never nested inside the source tree).

> **cwd handoff (why the command captures `pwd`).** The default sibling output dir is derived from the
> current directory, but the workflow runs in a sandbox with **no cwd access** (`process.cwd()` is
> disabled there, alongside `Date.now()`/`Math.random()`, to keep resume caching reproducible). So the
> command layer captures the shell `pwd` and passes it as an explicit `cwd` arg — the deterministic
> channel the sandbox uses to compute `<cwd>_portkit`. It also resolves the input to an absolute path
> for the analysis agents. If the output dir is genuinely unresolvable (no `--output`, no absolute
> input, **and** no `cwd`), the run **aborts loudly** rather than silently writing `portkit_portkit`
> inside the source tree.

> **Prerequisite:** the Workflow tool (part of Claude Code) must be available. It is enabled via your
> Claude settings — there is no `CLAUDE_CODE_WORKFLOWS` shell env var to set. If a run errors because
> workflows are unavailable, enable them in Claude Code.

### Run it phase by phase

`/portkit` runs the whole pipeline end to end. To **review the output between phases** (or iterate on
one phase during development), run the per-phase commands instead — each advances the pipeline to its
stage, **pauses** for you to inspect the output, and leaves a resumable checkpoint the next command
continues from:

| Command | Stops after | Review |
|---|---|---|
| `/portkit-map` | Map | the feature inventory |
| `/portkit-discover` | Discover | slices + behavior side-cars |
| `/portkit-synthesize` | Synthesize | `INDEX` / `ACCEPTANCE` / `ARCHITECTURE` / `PRD` |
| `/portkit-adrs` | ADRs | `adr/*.md` |
| `/portkit-specs` | Write specs | `specs/*.md` |
| `/portkit-critic` | Critic | `RISKS-AND-GAPS.md` |
| `/portkit-distill` | Distill (terminal) | `distilled/` mirror — finishes and clears the checkpoint |

All phase commands take the same `[input-dir] [--input <dir>] [--output <dir>]` arguments as `/portkit`
and must resolve the same output dir so they share one checkpoint. Resume is forgiving: running a later
command first simply advances the ladder from the start and stops at that phase. Because pausing keeps
the checkpoint, a phase command does **not** re-run an already-completed phase (resume skips it) — to
re-iterate a phase during development, use `--fresh` or a throwaway `--output` dir.

## Output (`<input-dir>_portkit/`)

| Path | What |
|---|---|
| `PRD.md` | Product requirements reconstructed from observed behavior (intent fields tagged `[INFERRED]`) |
| `ARCHITECTURE.md` | Tech stack, component inventory, data model + domain vocabulary, data flows, cross-cutting concerns |
| `INDEX.md` | Recreation roadmap: feature→slice tree **and recommended build order** (`FEAT-NN` / `SL-NNNN`) |
| `ACCEPTANCE.md` | Acceptance-criteria rollup + coverage-gap table |
| `GLOSSARY.md` | The kit's canonical vocabulary (Feature, Slice, `SL-NNNN`, `FEAT-NN`, ADR, …) |
| `specs/<NNNN>-<slice>.md` | One self-contained, self-testing slice spec, opening with a metadata header (`Slice ID SL-NNNN`, Build #, parent `Feature FEAT-NN`, Depends on) then a fixed section skeleton (exact behavior, I/O, edge cases, errors, acceptance criteria) |
| `adr/<NNNN>-<decision>.md` | One MADR-style Architecture Decision Record per significant decision (id `ADR-NNNN`, status `Reconstructed`) |
| `RISKS-AND-GAPS.md` | Unverified claims, thin coverage, `[INFERRED]` misuse, open questions |

Every document is written to a single **house style** with a fixed section skeleton and canonical
identifiers, so the whole kit reads as one author produced it. See [Terminology](#terminology).

## How it works

A single dynamic Workflow (`workflows/portkit.js`) runs these phases, fanning out fresh-context
specialist agents:

1. **Map** — survey the repo, draft the feature inventory (data only; no file written).
2. **Discover slices** — per feature, trace each behavior end-to-end into fine slices, then
   extract the behavioral acceptance spec from the existing tests.
3. **Synthesize** — normalize/dedup overlapping slices, compute the topological build order, and
   author the system-wide docs (PRD, ARCHITECTURE, INDEX, ACCEPTANCE, GLOSSARY).
4. **ADRs** — discover architecturally significant decisions (each with `path:line` evidence), write
   one MADR-style ADR each.
5. **Write specs** — one self-contained, self-testing slice spec per unit.
6. **Critic** — grounding + completeness audit (including a deterministic frontmatter + required-section
   conformance check on every generated doc) → `RISKS-AND-GAPS.md`, with a budget-bounded gap-fill loop.

### Tuning knobs (optional `args`)

`inputDir` (default `.`), `outputDir` (default `<inputDir>_portkit`), `maxFeatures` (40), `maxAdrs`
(12), `maxGapfillRounds` (2), `maxConcurrency` (8), `checkpointEvery` (default `maxConcurrency` —
features analyzed per discovery checkpoint), `maxAgents` (1000, the over-scale guard's per-run
ceiling), `maxTokensPerRun` (0 = unlimited — a per-invocation token ceiling for subscription-window
chunking, see below), `tokenReserve` (50000 — tokens held back for the finishing critic pass),
`distill` (**true** by default; `false` to opt out — after the critic, emit a citation-free `distilled/`
mirror for the weaker rebuilder; see below), `fresh` (ignore any checkpoint and reprocess), `resume` (demand an existing checkpoint;
auto-resume is the normal path). (`sourcePath`/`outDir` are accepted as legacy aliases for
`inputDir`/`outputDir`, and `maxEpics` for `maxFeatures` — renamed when the vocabulary was unified to
Feature/Slice.) **Features are never capped** — they are the deliverable, so dropping them is
never an option; genuine over-scale is handled by feature-partitioned resumable passes (see
below). The remaining caps exist because the Workflow runtime limits a run to ~1000 agents; anything
capped is **logged and recorded in the result's `truncations`** — silent truncation would read as
"complete" when it isn't.

### Resumability: checkpoint every stage, resume anywhere

PortKit persists a checkpoint to `<outputDir>/.portkit/ir.json` after **every stage** — map, each
discovery batch (`checkpointEvery` features), synthesis, the doc family, ADRs, and each
slice-spec write pass. If a run is interrupted (crash, timeout, spend limit, API outage),
**re-running the same command auto-resumes** from the last completed stage rather than reprocessing —
the expensive per-feature discovery is preserved batch by batch, so a large project never starts
over. The checkpoint is fingerprinted by `source`, so one for a different input dir is ignored (never
a wrong-codebase resume), and it is deleted when the run completes. Pass `--fresh` to ignore an
existing checkpoint.

Two things stay stable across a resume so the kit remains coherent: the synthesized build order (and
its `#NNNN` numbering) and the discovered ADR set are computed once and reloaded, so slice specs
already written keep matching their numbers.

**Over-scale** is the same machinery taken further: if a single run's projected agent count would
approach the runtime's ~1000-agent ceiling, the analysis + doc family + ADRs run once and slice
specs are written in **feature-batched passes**, returning `resumeRequired: true` until every
slice is written. **No slice is ever dropped.**

**Token/subscription-window chunking** rides the same substrate for very large projects. Set
`maxTokensPerRun` (or use a runtime `+Nk` directive — that takes precedence) and the run **voluntarily
pauses** the moment its actual spend nears the ceiling: at the next checkpoint boundary — after a
discovery batch, at a stage boundary, or between small write batches — it persists progress and
returns `stoppedForBudget: true` + `resumeRequired: true`, rather than pushing until the subscription
wall hard-aborts it mid-agent (which wastes the in-flight agent's tokens). Re-running (or
`/loop /portkit …`) continues the next chunk on a fresh window. Two guarantees make this safe: the
ceiling is **per run**, not cumulative (each resume refills), and a progress guard ensures every turn
completes **at least one unit of work** before pausing, so it can never no-progress-loop even if the
window is smaller than a single phase. Token-budgeted write passes batch at **slice granularity**
(≈`maxConcurrency` specs), so overshoot is bounded even inside one very large feature. With no
budget set, none of this engages — behavior is byte-identical.

**Distill for the rebuilder (default-on).** Every doc is grounded with `path:line` source citations — the
anti-hallucination receipts the generator and critic depend on, and what lets *you* audit a claim.
But the downstream consumer is a *weaker* model that rebuilds from the docs **without the source**, so
those references point at files it can't open — inert clutter at best, a hallucination/cargo-cult
vector at worst. By default (opt out with `distill: false`), after the critic validates the kit PortKit emits a citation-free
**mirror** under `<outputDir>/distilled/` (ARCHITECTURE/PRD/INDEX/ACCEPTANCE + every spec + every ADR,
internal links intact): verified `path:line` refs are stripped, while `[INFERRED]`/`[UNVERIFIED]` flags
and real artifact paths (e.g. `.config/settings.yaml`) are kept. Hand the rebuilder `distilled/`; keep the
top-level cited kit for review. Each distilled doc self-checks for leftover citations
(`counts.residualCitations`).

**Fresh & scope safety.** A `fresh` run clears the old checkpoint and **overwrites** the prior kit's
docs/specs (no half-old/half-new "Frankenstein"); and auto-resume **refuses** a checkpoint whose
`maxFeatures`/`limitSlices` differ from the current run (e.g. resuming a `limitSlices` smoke test with a
full-run command) instead of silently continuing the smaller scope.

## Design constraints baked in

- **Grounding is mandatory** — every nontrivial claim about the source cites `path:line`;
  unverifiable claims are marked `[UNVERIFIED]`, not asserted.
- **Inference is inverted and tagged** — reverse-engineering yields *intent* (PRD goals/non-goals/
  metrics, ADR rationale/"why") that the source does not state; every such statement is tagged
  `[INFERRED]` and never presented as observed fact.
- **Tests are the behavioral contract** — thin/missing coverage is flagged loudly, never hidden.
- **ADRs require evidence** — a decision with no observable `path:line` support is not recorded.

See `VERIFICATION.md` for how to validate the plugin and the docs it produces.
