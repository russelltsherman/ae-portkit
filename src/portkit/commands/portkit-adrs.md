---
description: PortKit phase 4 — discover architecturally significant decisions and write one MADR ADR each, then stop.
argument-hint: [input-dir] [--input <dir>] [--output <dir>]
allowed-tools: Bash, Workflow
---

# /portkit-adrs

Run the PortKit pipeline **up to and including the ADRs phase**, then **pause**. One agent finds the
architecturally significant decisions that carry observable `path:line` evidence (no evidence, no
ADR; capped at `maxAdrs`, default 12), and one writer per decision emits a **MADR-format** ADR (status
`Reconstructed`) under `<output>/adr/`.

Requires the doc family; advances the ladder to here if the checkpoint is earlier. See `/portkit` for
knobs, `/portkit-map` for the phase list.

## Arguments

Raw arguments: `$ARGUMENTS` — parse `[input-dir] [--input <dir>] [--output <dir>]` as `/portkit` does;
resolve the SAME output dir as the earlier phases.

## Steps

1. **Requires the Workflow tool** (part of Claude Code, enabled via your Claude settings — there is
   no `CLAUDE_CODE_WORKFLOWS` shell env var). If the invocation below errors because workflows are
   unavailable, enable them in Claude Code, then retry.

2. **Invoke the workflow** with `until: "adrs"`:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "...", until: "adrs" }
   })
   ```

3. **Handle the result:**
   - `paused: true` — report the ADR count and location, then tell the user to review `adr/*.md` and
     run **`/portkit-specs`** to continue.
   - `stoppedForBudget` / `resumeRequired` — re-run to continue until it pauses at `adrs`.
