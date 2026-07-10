---
description: PortKit phase 6 — audit the kit for grounding + completeness, write RISKS-AND-GAPS.md, then stop.
argument-hint: [input-dir] [--input <dir>] [--output <dir>]
allowed-tools: Bash, Workflow
---

# /portkit-critic

Run the PortKit pipeline **up to and including the Critic phase**, then **pause**. The critic audits
whether a weaker model could rebuild from the kit alone — unresolved citations, thin/missing coverage,
`[INFERRED]` misuse, non-self-contained specs, dangling deps, malformed document structure (frontmatter
+ required-section conformance, checked deterministically) — writes `<output>/RISKS-AND-GAPS.md`, and
runs a budget-bounded gap-fill loop (`maxGapfillRounds`, default 2).

Requires the slice specs; advances the ladder to here if the checkpoint is earlier. See `/portkit`
for knobs, `/portkit-map` for the phase list.

At this point the **cited kit is complete** (PRD, ARCHITECTURE, INDEX, ACCEPTANCE, specs, ADRs, risks).
In the step-by-step flow the citation-free rebuild mirror is the next, separate phase — run
`/portkit-distill`. (A full `/portkit` run includes distillation automatically by default.)

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

2. **Invoke the workflow** with `until: "critiqued"`:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "...", cwd: "...", until: "critiqued" }
   })
   ```

3. **When it returns `paused: true`**, report `gapsRemaining` (especially any that need a human
   decision) and where `RISKS-AND-GAPS.md` lives. Tell the user the cited kit is complete, and they
   can either:
   - run **`/portkit-distill`** to emit the citation-free `distilled/` mirror for the weaker model, or
   - stop here — the lingering checkpoint is harmless and is cleared automatically by the next full
     `/portkit` run on the same output dir (or by `--fresh`).
