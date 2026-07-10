---
description: PortKit phase 7 (terminal) — emit the citation-free distilled/ mirror for the weaker model, then finish.
argument-hint: [input-dir] [--input <dir>] [--output <dir>]
allowed-tools: Bash, Workflow
---

# /portkit-distill

Run the PortKit pipeline **through the Distill phase — the terminal stage** — then **finish** (this
clears the checkpoint). Distill emits a **citation-free mirror** of every consumer-facing doc under
`<output>/distilled/`: the `path:line` source citations that help you audit grounding are stripped
(the weaker rebuilder can't open them), while `[INFERRED]` / `[UNVERIFIED]` flags and real artifact
paths are kept. This command implies `distill: true`.

Requires the critic to have run; advances the ladder to here if the checkpoint is earlier. Because
this is the last phase it runs to natural completion rather than pausing. See `/portkit` for knobs,
`/portkit-map` for the phase list.

## Arguments

Raw arguments: `$ARGUMENTS` — parse `[input-dir] [--input <dir>] [--output <dir>]` as `/portkit` does;
resolve the SAME output dir as the earlier phases. Resolve the input dir to an ABSOLUTE path
(`realpath "${dir:-.}"`), never a bare `.` — the sandbox has no cwd, so `.` writes inside the input dir.

## Steps

1. **Requires the Workflow tool** (part of Claude Code, enabled via your Claude settings — there is
   no `CLAUDE_CODE_WORKFLOWS` shell env var). If the invocation below errors because workflows are
   unavailable, enable them in Claude Code, then retry.

2. **Invoke the workflow** with `distill: true` (no `until` — this is the terminal phase, so it runs
   to completion and clears the checkpoint):
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "...", distill: true }
   })
   ```

3. **When it returns `resumeRequired: false`**, report the final summary: `outDir`, the
   `distilledDocs` count and `residualCitations` (should be 0 — surface loudly if not), the
   `keyDocs.distilledDir`, and any remaining gaps. Point the rebuilder at `distilled/` and keep the
   top-level cited docs for review. If `stoppedForBudget` / `resumeRequired` is `true`, re-run (or
   `/loop`) to continue until it completes.
