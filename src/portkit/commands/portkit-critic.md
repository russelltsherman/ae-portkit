---
description: PortKit phase 6 — audit the kit for grounding + completeness, write RISKS-AND-GAPS.md, then stop.
argument-hint: [input-dir] [--input <dir>] [--output <dir>]
allowed-tools: Bash, Workflow
---

# /portkit-critic

Run the PortKit pipeline **up to and including the Critic phase**, then **pause**. The critic audits
whether a weaker model could rebuild from the kit alone — unresolved citations, thin/missing coverage,
`[INFERRED]` misuse, non-self-contained specs, dangling deps — writes `<output>/RISKS-AND-GAPS.md`, and
runs a budget-bounded gap-fill loop (`maxGapfillRounds`, default 2).

Requires the feature specs; advances the ladder to here if the checkpoint is earlier. See `/portkit`
for knobs, `/portkit-map` for the phase list.

At this point the **cited kit is complete** (PRD, ARCHITECTURE, INDEX, ACCEPTANCE, specs, ADRs, risks).
The optional citation-free rebuild mirror is a separate phase, `/portkit-distill`.

## Arguments

Raw arguments: `$ARGUMENTS` — parse `[input-dir] [--input <dir>] [--output <dir>]` as `/portkit` does;
resolve the SAME output dir as the earlier phases.

## Steps

1. **Requires the Workflow tool** (part of Claude Code, enabled via your Claude settings — there is
   no `CLAUDE_CODE_WORKFLOWS` shell env var). If the invocation below errors because workflows are
   unavailable, enable them in Claude Code, then retry.

2. **Invoke the workflow** with `until: "critiqued"`:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { inputDir: "...", outputDir: "...", until: "critiqued" }
   })
   ```

3. **When it returns `paused: true`**, report `gapsRemaining` (especially any that need a human
   decision) and where `RISKS-AND-GAPS.md` lives. Tell the user the cited kit is complete, and they
   can either:
   - run **`/portkit-distill`** to emit the citation-free `distilled/` mirror for the weaker model, or
   - stop here — the lingering checkpoint is harmless and is cleared automatically by the next full
     `/portkit` run on the same output dir (or by `--fresh`).
