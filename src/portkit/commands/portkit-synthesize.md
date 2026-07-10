---
description: PortKit phase 3 — dedup slices, compute the build order, and author the doc family, then stop.
argument-hint: [input-dir] [--input <dir>] [--output <dir>]
allowed-tools: Bash, Workflow
---

# /portkit-synthesize

Run the PortKit pipeline **up to and including the Synthesize phase**, then **pause**. This dedups
duplicate slices (the one LLM judgment step), computes the deterministic build order, and authors the
system-wide doc family: **INDEX.md, ACCEPTANCE.md, ARCHITECTURE.md, PRD.md**. (The dedup `synthesized`
sub-stage has no standalone artifact, so this command runs through to the `docs` stage where the
reviewable docs land.)

Requires discovery to have run; if the checkpoint is earlier it advances the ladder to here first.
See `/portkit` for knobs, `/portkit-map` for the phase list.

## Arguments

Raw arguments: `$ARGUMENTS` — parse `[input-dir] [--input <dir>] [--output <dir>]` as `/portkit` does;
resolve the SAME output dir as the earlier phases. **Capture the current dir with the shell builtin
`CWD=$(pwd)` and pass it as the `cwd` arg** — the deterministic channel the sandbox uses to derive the
default sibling output dir. Still resolve the input dir to an ABSOLUTE path (`realpath "${dir:-.}"`) for
the analysis agents. If the sandbox gets a bare `.` AND no `cwd`, the run **aborts loudly** rather than
silently writing `portkit_portkit` inside the source.

## Steps

1. **Requires the Workflow tool** (part of Claude Code, enabled via your Claude settings — there is
   no `CLAUDE_CODE_WORKFLOWS` shell env var). If the invocation below errors because workflows are
   unavailable, enable them in Claude Code, then retry.

2. **Invoke the workflow** with `until: "docs"`:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "...", cwd: "...", until: "docs" }
   })
   ```

3. **Handle the result:**
   - `paused: true` — report that PRD / ARCHITECTURE / INDEX / ACCEPTANCE were written under `outDir`,
     surface any dedup/build-order `truncations`, and tell the user to review those docs, then run
     **`/portkit-adrs`** to continue.
   - `stoppedForBudget` / `resumeRequired` — re-run to continue until it pauses at `docs`.
