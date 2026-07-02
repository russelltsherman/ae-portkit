---
description: Analyze this codebase into a stack-neutral recreation kit (PRD, architecture spec, per-feature specs, ADRs, acceptance criteria) a weaker model can rebuild from.
argument-hint: [input-dir] [--input <dir>] [--output <dir>] [--fresh]
allowed-tools: Bash, Workflow
---

# /portkit

Run the **PortKit** workflow: a team of specialist agents deeply analyzes a codebase and emits a
family of standard planning/design documents — a **PRD**, an **architecture/technical spec**,
one **feature spec** per capability, **ADRs** for the significant decisions, and **acceptance
criteria** — detailed enough that a *less capable local model* can recreate the software **from the
docs alone**. The output is **stack-neutral**: it describes the software to rebuild, not a port to a
specific target language.

## Arguments

Raw arguments: `$ARGUMENTS`

Parse them as: `[input-dir] [--input <dir>] [--output <dir>]`

- **input dir** — the codebase root to analyze. Provide it either as the positional `[input-dir]`
  or via `--input <dir>` (the flag wins if both are given). Defaults to the current directory (`.`).
- **`--output <dir>`** (optional): where to write the generated docs. Defaults to a **sibling** of
  the input dir named `<input-dir>_recreation` (e.g. `/src/mulch` → `/src/mulch_recreation`).
  Output is never nested inside the input dir, so it does not pollute the source tree.

When a path is ambiguous, prefer the explicit `--input` / `--output` flags.

## Steps

1. **Confirm the Workflow tool is enabled.** It is gated behind an env var. Run:
   ```bash
   echo "${CLAUDE_CODE_WORKFLOWS:-<not set>}"
   ```
   If it is `<not set>`, STOP and tell the user to enable it before this command can run, either:
   - per session: `export CLAUDE_CODE_WORKFLOWS=1 && claude`, or
   - persistently in `.claude/settings.local.json`: `{ "env": { "CLAUDE_CODE_WORKFLOWS": "1" } }`

2. **Build the args object** from the parsed arguments:
   - `inputDir`: the resolved input dir (`--input` flag, else positional `[input-dir]`, else `"."`).
   - `outputDir`: the `--output` value if given; otherwise omit it and let the workflow default to
     `<inputDir>_recreation`.
   - `fresh: true` (from `--fresh`): ignore any existing checkpoint at the output dir and reprocess
     from scratch (see **Resuming** below). Omit it for the normal auto-resume behavior.
   - Optional tuning knobs the user may pass through (only if they ask): `maxEpics`, `maxAdrs`
     (cap on discovered ADRs; defaults to `12`), `maxGapfillRounds`, `maxConcurrency` (max agents in
     flight at once; defaults to `8` — lower it if the run is being API-rate-limited/throttled, raise
     it to go faster on an account with generous limits), `checkpointEvery` (capabilities analyzed
     per discovery checkpoint; defaults to `maxConcurrency` — lower it to checkpoint more often on a
     flaky connection), and `maxAgents` (the per-run agent ceiling used for the over-scale guard;
     defaults to `1000` — the runtime's hard cap).
   - **Token/subscription-budget knobs** (for very large projects — process the kit in chunks that
     each fit within a subscription usage window): `maxTokensPerRun` (default `0` = unlimited): a
     per-invocation output-token ceiling. When reached, the run **voluntarily pauses** at the next
     checkpoint (persisting progress) and returns `stoppedForBudget: true` + `resumeRequired: true`
     instead of pushing until a hard spend-limit abort. `tokenReserve` (default `50000`): tokens
     held back for the finishing critic pass. Precedence: a runtime `+Nk` directive (`budget.total`)
     wins over `maxTokensPerRun`; with neither set, behavior is exactly as before (no pausing). Pair
     with `/loop /portkit …` to drive a huge project to completion across many budget-sized chunks.
   - `limitSlices` (DEV/TEST ONLY, default `0` = unlimited): write only the first N feature specs
     (in build order) so a live run exercises the WHOLE pipeline (map → discover → synthesize →
     adrs → write → critic) cheaply. The output is a **partial, self-consistent TEST kit** —
     reported loudly (`counts.testLimited`, `counts.slicesOmittedForTest`, and a `🧪 TEST LIMIT`
     truncation) and **never a complete recreation kit**. For the cheapest end-to-end smoke test,
     pair it with a low `maxEpics` to also cut discovery cost, e.g. `{ maxEpics: 2, limitSlices: 3 }`.

3. **Invoke the workflow** with the `Workflow` tool, pointing `scriptPath` at the bundled script and
   passing the args object:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "..." }
   })
   ```
   The workflow runs in the background; watch it live with `/workflows`.

4. **When it completes**, check `resumeRequired` first:
   - If `resumeRequired` is `true`, the codebase was large enough that the workflow partitioned
     feature-spec writing into resumable passes (nothing is dropped). It returns `resumeArgs` (e.g.
     `{ resume: true, outputDir: "<dir>" }`). **Re-invoke the workflow with those args** (or just
     re-run the same command — it auto-resumes; see **Resuming**), and keep re-invoking until
     `resumeRequired` is `false`. Each pass writes the next batch of feature specs against the same
     `outputDir`. Report progress (`slicesWritten` / `slicesRemaining`) between passes.
   - When `resumeRequired` is `false`, report the final summary: where the docs were written
     (`outDir`), the feature/ADR counts, any **truncations** (real coverage gaps — surface them),
     and the **remaining gaps**, especially `gapsRemainingHumanDecision`, which are items a human
     must resolve.
   - If `stoppedForBudget` is `true`, the run **voluntarily paused** because it reached its token
     budget (`maxTokensPerRun` or a `+Nk` directive), not because of an error. Treat it exactly like
     any other `resumeRequired` result — re-run (or `/loop`) to continue the next chunk. It reports
     the `stage` it paused at.
   - If the run is **interrupted** (crash, timeout, spend limit, API outage), just re-run the same
     command: it checkpoints after every stage and resumes from where it stopped (see **Resuming**).

## Resuming

PortKit checkpoints its progress to `<output>/.portkit/ir.json` after every stage — map, each
discovery batch, synthesis, the doc family, ADRs, and each feature-spec write pass. If a run is
interrupted anywhere, **re-running the same command auto-resumes** from the last completed stage
instead of reprocessing: the expensive per-capability discovery, in particular, is preserved batch
by batch. The checkpoint is fingerprinted by the input dir, so a checkpoint for a different source is
ignored (never a wrong-codebase resume), and it is deleted automatically when the run completes.

- **Token/subscription-window chunking** uses this same machinery: with `maxTokensPerRun` (or a
  `+Nk` directive) set, a run stops at the token ceiling and hands back a resume point, so a very
  large project is completed as a series of budget-sized chunks (`/loop /portkit …` drives it). The
  ceiling is **per run**, not cumulative — each resume is a fresh window. Nothing is ever dropped.
- `--fresh` — ignore any existing checkpoint and reprocess from scratch. A fresh run also
  **clears the old checkpoint and OVERWRITES** the prior kit's docs/specs (so you never get a
  half-old/half-new "Frankenstein" kit). Orphaned specs from a *larger* prior run may remain — use a
  clean or new `--output` dir if that matters.
- **Scope guard:** auto-resume **refuses** and errors if the checkpoint was built with different
  `maxEpics`/`limitSlices` than the current run (e.g. resuming a `limitSlices` smoke test with a
  full-run command), rather than silently continuing the smaller scope. Use `--fresh` (clean dir)
  for a full run, or match the original knobs to continue.
- `resume: true` — demand a checkpoint and continue it; errors if none exists (auto-resume is the
  normal path, so you rarely need this explicitly).
- `checkpointEvery` — capabilities analyzed per discovery checkpoint (default `maxConcurrency`).

## Notes

- Output lands in the sibling dir `<input-dir>_recreation/` by default, never inside the input dir.
  The kit is **stack-neutral** — a PRD, an architecture spec, per-feature specs, MADR-style ADRs,
  and an acceptance-criteria rollup — so it describes what to rebuild without prescribing a target
  language.
- **Grounding vs. inference:** observed facts cite `path:line`; reverse-engineered *intent* (PRD
  goals/non-goals/success metrics, ADR rationale/"why") is tagged `[INFERRED]` — never presented as
  observed fact.
- This command produces **documents only** — it does not perform the recreation.
