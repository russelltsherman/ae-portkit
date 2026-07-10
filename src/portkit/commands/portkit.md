---
description: Analyze this codebase into a stack-neutral recreation kit (PRD, architecture spec, per-slice specs, ADRs, acceptance criteria) a weaker model can rebuild from.
argument-hint: [input-dir] [--input <dir>] [--output <dir>] [--fresh]
allowed-tools: Bash, Workflow
---

# /portkit

Run the **PortKit** workflow: a team of specialist agents deeply analyzes a codebase and emits a
family of standard planning/design documents — a **PRD**, an **architecture/technical spec**,
one **slice spec** per feature, **ADRs** for the significant decisions, and **acceptance
criteria** — detailed enough that a *less capable local model* can recreate the software **from the
docs alone**. The output is **stack-neutral**: it describes the software to rebuild, not a port to a
specific target language.

## Arguments

Raw arguments: `$ARGUMENTS`

Parse them as: `[input-dir] [--input <dir>] [--output <dir>]`

- **input dir** — the codebase root to analyze. Provide it either as the positional `[input-dir]`
  or via `--input <dir>` (the flag wins if both are given). Defaults to the current directory (`.`),
  which the command resolves to an **absolute path** before invoking (see Steps) — the workflow
  sandbox has no cwd access, so it must receive a concrete path.
- **`--output <dir>`** (optional): where to write the generated docs. Defaults to a **sibling** of
  the input dir named `<input-dir>_portkit` (e.g. `/src/myapp` → `/src/myapp_portkit`). The command
  passes the current dir (`pwd`) as an explicit `cwd` arg so the sandbox can derive that sibling
  deterministically; if neither an `--output`, an absolute input, nor a `cwd` is available, the run
  **aborts loudly** instead of guessing. Output is never nested inside the input dir, so it does not
  pollute the source tree.

When a path is ambiguous, prefer the explicit `--input` / `--output` flags.

## Steps

1. **Requires the Workflow tool** (part of Claude Code, enabled via your Claude settings — there is
   no `CLAUDE_CODE_WORKFLOWS` shell env var, contrary to earlier docs). If the workflow invocation
   below errors because workflows are unavailable, enable them in Claude Code, then retry.

2. **Build the args object** from the parsed arguments:
   - `cwd`: **capture the current directory with the shell builtin `pwd`** (e.g. `CWD=$(pwd)`) and
     pass it as an explicit `cwd` arg. This is the **deterministic channel** the sandbox trusts to
     derive the default sibling output dir: the workflow runs in a sandbox with no cwd access of its
     own (`process.cwd()` is disabled there, like `Date.now()`), so it relies on this arg. If it is
     omitted **and** `inputDir` is a bare `.`, the run **aborts loudly** with a remediation message
     rather than silently writing `portkit_portkit` **inside** the source tree.
   - `inputDir`: **resolve the input dir to an ABSOLUTE path** with Bash before invoking — take
     `--input` flag, else positional `[input-dir]`, else `.`, and run
     `realpath "<that>"` (e.g. `INPUT=$(realpath "${dir:-.}")`). Pass the absolute result. This feeds
     the analysis agents a concrete path and lets the default output land as a proper sibling even if
     `cwd` were somehow missing.
   - `outputDir`: the `--output` value if given (also resolve it to absolute); otherwise omit it and
     let the workflow default to the sibling `<absolute-inputDir>_portkit`.
   - `fresh: true` (from `--fresh`): ignore any existing checkpoint at the output dir and reprocess
     from scratch (see **Resuming** below). Omit it for the normal auto-resume behavior.
   - Optional tuning knobs the user may pass through (only if they ask): `maxFeatures`, `maxAdrs`
     (cap on discovered ADRs; defaults to `12`), `maxGapfillRounds`, `maxConcurrency` (max agents in
     flight at once; defaults to `8` — lower it if the run is being API-rate-limited/throttled, raise
     it to go faster on an account with generous limits), `checkpointEvery` (features analyzed
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
   - `distill` (**default `true`** — pass `distill: false` to opt out): after the critic validates the
     kit, emit a **citation-free mirror** under `<output>/distilled/` for the weaker downstream model
     that rebuilds from the docs. The top-level docs keep their `path:line` source citations (useful to
     *you* for auditing grounding), but those references point at source the rebuilder can't open — so
     the `distilled/` copy strips them while keeping `[INFERRED]`/`[UNVERIFIED]` flags and real
     artifact paths. **The `distilled/` mirror is the artifact the weaker model rebuilds from, so a
     full run produces it by default**; point the rebuilder at `distilled/` and keep the top level for
     review. Reported via `counts.distilledDocs` / `counts.residualCitations` and `keyDocs.distilledDir`.
     Opting out (`distill: false`) yields the cited kit only, with `'critiqued'` as the terminal stage —
     and because the checkpoint is destroyed **only when every phase completed**, an opted-out run
     **keeps** its checkpoint (result: `checkpointRetained: true`). Run `/portkit-distill` (or re-run
     without `distill: false`) later to add the mirror and finalize, or `--fresh` to discard it.
   - `limitSlices` (DEV/TEST ONLY, default `0` = unlimited): write only the first N slice specs
     (in build order) so a live run exercises the WHOLE pipeline (map → discover → synthesize →
     adrs → write → critic) cheaply. The output is a **partial, self-consistent TEST kit** —
     reported loudly (`counts.testLimited`, `counts.slicesOmittedForTest`, and a `🧪 TEST LIMIT`
     truncation) and **never a complete recreation kit**. For the cheapest end-to-end smoke test,
     pair it with a low `maxFeatures` to also cut discovery cost, e.g. `{ maxFeatures: 2, limitSlices: 3 }`.

3. **Invoke the workflow** with the `Workflow` tool, pointing `scriptPath` at the bundled script and
   passing the args object:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "...", cwd: "..." }
   })
   ```
   The workflow runs in the background; watch it live with `/workflows`.

4. **When it completes**, check `resumeRequired` first:
   - If `resumeRequired` is `true`, the codebase was large enough that the workflow partitioned
     slice-spec writing into resumable passes (nothing is dropped). It returns `resumeArgs` (e.g.
     `{ resume: true, outputDir: "<dir>" }`). **Re-invoke the workflow with those args** (or just
     re-run the same command — it auto-resumes; see **Resuming**), and keep re-invoking until
     `resumeRequired` is `false`. Each pass writes the next batch of slice specs against the same
     `outputDir`. Report progress (`slicesWritten` / `slicesRemaining`) between passes.
   - When `resumeRequired` is `false`, report the final summary: where the docs were written
     (`outDir`), the slice/ADR counts, any **truncations** (real coverage gaps — surface them),
     and the **remaining gaps**, especially `gapsRemainingHumanDecision`, which are items a human
     must resolve. If `checkpointRetained` is `true` (distillation was opted out), also note that
     the checkpoint is kept and `/portkit-distill` can still add the rebuilder mirror.
   - If `stoppedForBudget` is `true`, the run **voluntarily paused** because it reached its token
     budget (`maxTokensPerRun` or a `+Nk` directive), not because of an error. Treat it exactly like
     any other `resumeRequired` result — re-run (or `/loop`) to continue the next chunk. It reports
     the `stage` it paused at.
   - If `ok` is `false` **with** `resumeRequired: true` and a `failedFeatures` list, one or more
     **discovery agents died** mid-run. The workflow deliberately did NOT finalize an incomplete
     kit or clear the checkpoint — it stopped so the dropped features are not lost. Re-invoke with
     `resumeArgs` (or re-run the command): it auto-resumes and **re-discovers only the failed
     features** (`failedFeatures`), then continues. Report which features are being retried.
   - If `ok` is `false` **without** `resumeRequired` (e.g. discovery made **no** forward progress —
     every feature failed), do NOT blindly loop. Surface the `error` and `failedFeatures`; the
     checkpoint is still kept, so the user can investigate (rate limits, a bad `inputDir`) and then
     re-run to resume.
   - If `ok` is `false` with a `missingDocs` (or `missingAdrs`) list, a **doc-family or ADR writer
     died** (e.g. `PRD.md`, or an `adr/ADR-NNNN-*.md`) and the file was still absent after an in-run
     retry. The workflow deliberately did NOT checkpoint that stage (which would let a resume skip it)
     or finalize. Surface the missing files and re-run: it resumes (from `synthesized` for docs, or
     `docs` for ADRs) and re-authors the missing family.
   - If the run is **interrupted** (crash, timeout, spend limit, API outage), just re-run the same
     command: it checkpoints after every stage and resumes from where it stopped (see **Resuming**).

## Resuming

PortKit checkpoints its progress to `<output>/.portkit/ir.json` after every stage — map, each
discovery batch, synthesis, the doc family, ADRs, and each slice-spec write pass. If a run is
interrupted anywhere, **re-running the same command auto-resumes** from the last completed stage
instead of reprocessing: the expensive per-feature discovery, in particular, is preserved batch
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
  `maxFeatures`/`limitSlices` than the current run (e.g. resuming a `limitSlices` smoke test with a
  full-run command), rather than silently continuing the smaller scope. Use `--fresh` (clean dir)
  for a full run, or match the original knobs to continue.
- `resume: true` — demand a checkpoint and continue it; errors if none exists (auto-resume is the
  normal path, so you rarely need this explicitly).
- `checkpointEvery` — features analyzed per discovery checkpoint (default `maxConcurrency`).

## Notes

- Output lands in the sibling dir `<input-dir>_portkit/` by default, never inside the input dir —
  the command passes the current dir as an explicit `cwd` arg (and resolves the input to an absolute
  path) so the default output is a true sibling beside it. The old failure mode — a bare `.` making
  the sandbox silently write `portkit_portkit` *inside* the source tree — is gone: if the output dir
  is genuinely unresolvable (no `cwd`, no absolute input, no `--output`) the run now **aborts loudly**
  with a remediation message instead.
  The kit is **stack-neutral** — a PRD, an architecture spec, per-slice specs, MADR-style ADRs,
  and an acceptance-criteria rollup — so it describes what to rebuild without prescribing a target
  language.
- **Grounding vs. inference:** observed facts cite `path:line`; reverse-engineered *intent* (PRD
  goals/non-goals/success metrics, ADR rationale/"why") is tagged `[INFERRED]` — never presented as
  observed fact.
- This command produces **documents only** — it does not perform the recreation.
- **Per-phase commands:** to run the pipeline one stage at a time and review the output between phases
  (or iterate on a single phase during development), use `/portkit-map`, `/portkit-discover`,
  `/portkit-synthesize`, `/portkit-adrs`, `/portkit-specs`, `/portkit-critic`, `/portkit-distill`. Each
  advances the pipeline to its stage, pauses, and leaves a resumable checkpoint the next command
  continues from. They share this command's arguments and checkpoint; `/portkit` remains the full
  end-to-end run.
