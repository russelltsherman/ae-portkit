---
description: PortKit phase 5 — write one self-contained, self-testing slice spec per slice, then stop.
argument-hint: [input-dir] [--input <dir>] [--output <dir>]
allowed-tools: Bash, Workflow
---

# /portkit-specs

Run the PortKit pipeline **up to and including the Write-specs phase**, then **pause** before the
critic. One writer per slice emits a self-contained slice spec to `<output>/specs/<NNNN>-<slug>.md`,
reading its component thread + acceptance criteria back from the side-cars.

This phase can span several invocations on a large repo (over-scale partitioning or a token budget
chunk it into resumable passes — **nothing is dropped**); keep re-running until it pauses at
`writing`. Requires ADRs; advances the ladder to here if the checkpoint is earlier. See `/portkit`
for knobs, `/portkit-map` for the phase list.

## Arguments

Raw arguments: `$ARGUMENTS` — parse `[input-dir] [--input <dir>] [--output <dir>]` as `/portkit` does;
resolve the SAME output dir as the earlier phases.

## Steps

1. **Requires the Workflow tool** (part of Claude Code, enabled via your Claude settings — there is
   no `CLAUDE_CODE_WORKFLOWS` shell env var). If the invocation below errors because workflows are
   unavailable, enable them in Claude Code, then retry.

2. **Invoke the workflow** with `until: "writing"`:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "...", until: "writing" }
   })
   ```

3. **Handle the result:**
   - `resumeRequired: true` (with or without `stoppedForBudget`) — the write phase partitioned into
     passes. Re-run `/portkit-specs` (or `/loop` it), reporting `slicesWritten` / `slicesRemaining`
     between passes, until it pauses.
   - `paused: true` — every slice spec is written. Report the spec count and location, then tell the
     user to review `specs/*.md` and run **`/portkit-critic`** to continue.
