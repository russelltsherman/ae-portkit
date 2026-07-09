---
description: PortKit phase 1 — survey the codebase and draft the feature inventory, then stop for review.
argument-hint: [input-dir] [--input <dir>] [--output <dir>] [--fresh]
allowed-tools: Bash, Workflow
---

# /portkit-map

Run **only the Map phase** of the PortKit pipeline: a single agent surveys the codebase (languages,
build system, test frameworks, dependency manifests) and drafts the **feature inventory** — the
coarse, externally-observable behaviors the system delivers. The run then **pauses** so you can
review the inventory before discovery fans out.

This is the first of the per-phase commands. The full end-to-end run is `/portkit`; the phases are
`/portkit-map` → `/portkit-discover` → `/portkit-synthesize` → `/portkit-adrs` → `/portkit-specs` →
`/portkit-critic` → `/portkit-distill`. Each stops after its stage and leaves a resumable
checkpoint; the next command continues from it. See `/portkit` for the full argument/knob reference.

## Arguments

Raw arguments: `$ARGUMENTS`

Parse them as `[input-dir] [--input <dir>] [--output <dir>]` exactly as `/portkit` does:
- **input dir** — positional `[input-dir]` or `--input <dir>` (flag wins); defaults to `.`.
- **`--output <dir>`** — defaults to the sibling `<input-dir>_portkit`. All phase commands must
  resolve the SAME output dir so they share one checkpoint (`<output>/.portkit/ir.json`).
- **`--fresh`** — start over, ignoring/overwriting any existing checkpoint and kit.

## Steps

1. **Requires the Workflow tool** (part of Claude Code, enabled via your Claude settings — there is
   no `CLAUDE_CODE_WORKFLOWS` shell env var). If the invocation below errors because workflows are
   unavailable, enable them in Claude Code, then retry.

2. **Invoke the workflow** with `until: "mapped"`:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "...", until: "mapped" }
   })
   ```
   Pass `fresh: true` if `--fresh` was given.

3. **When it returns `paused: true`**, report: the run stopped after the **Map** phase, the number of
   features in the inventory, and where the checkpoint lives. Tell the user to review the
   feature inventory (in the checkpoint) and then run **`/portkit-discover`** to continue.
   Do NOT auto-continue — the pause is the review point.
