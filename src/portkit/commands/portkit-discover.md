---
description: PortKit phase 2 — trace each feature into vertical slices and extract acceptance criteria, then stop.
argument-hint: [input-dir] [--input <dir>] [--output <dir>]
allowed-tools: Bash, Workflow
---

# /portkit-discover

Run the PortKit pipeline **up to and including the Discover phase**, then **pause**. For each
feature, one agent traces it end-to-end into fine **vertical slices** (slices) and another
extracts **acceptance criteria** from the existing tests. Heavy analysis is written to per-feature
side-car files under `<output>/.portkit/features/`.

If no checkpoint exists yet it auto-runs Map first, then Discover (resume is forgiving — a later phase
command simply advances the ladder from the start). See `/portkit` for the full knob reference and
`/portkit-map` for the phase list.

## Arguments

Raw arguments: `$ARGUMENTS` — parse `[input-dir] [--input <dir>] [--output <dir>]` as `/portkit` does.
Resolve the SAME output dir used by the earlier phase so the shared checkpoint is found.

## Steps

1. **Requires the Workflow tool** (part of Claude Code, enabled via your Claude settings — there is
   no `CLAUDE_CODE_WORKFLOWS` shell env var). If the invocation below errors because workflows are
   unavailable, enable them in Claude Code, then retry.

2. **Invoke the workflow** with `until: "discovered"`:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "...", until: "discovered" }
   })
   ```

3. **Handle the result:**
   - `paused: true` — report the discovered slice/feature counts and tell the user to review the
     side-cars, then run **`/portkit-synthesize`** to continue.
   - `stoppedForBudget: true` / `resumeRequired: true` — discovery was chunked to fit a token window
     (or interrupted). Re-run `/portkit-discover` (or `/loop` it) until it pauses at `discovered`.
