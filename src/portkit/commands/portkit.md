---
description: Analyze this codebase into a target-neutral, vertical-slice build kit for porting to another language/framework.
argument-hint: <target-lang> [input-dir] [--input <dir>] [--output <dir>]
allowed-tools: Bash, Workflow
---

# /portkit

Run the **PortKit** workflow: a team of specialist agents deeply analyzes a codebase and emits a
collection of planning documents — organized as small, self-contained, self-testing **vertical
slices** — so a *less capable local model* can recreate the project in a different language or
framework from the docs alone.

## Arguments

Raw arguments: `$ARGUMENTS`

Parse them as: `<target-lang> [input-dir] [--input <dir>] [--output <dir>]`

- **target-lang** (optional but recommended): a single target language/framework (e.g. `go`, `rust`,
  `typescript`). It gets a prescriptive mapping layer under `targets/<lang>/`. If omitted, produce
  only the target-neutral core. (One target per run — to cover several, run again with the same
  `--output` and the neutral core is reused.)
- **input dir** — the codebase root to analyze. Provide it either as the positional `[input-dir]`
  or via `--input <dir>` (the flag wins if both are given). Defaults to the current directory (`.`).
- **`--output <dir>`** (optional): where to write the generated docs. Defaults to a **sibling** of
  the input dir named `<input-dir>_<target>` (e.g. `/src/mulch` → `/src/mulch_rust`), or
  `<input-dir>_portkit` if no target. Output is never nested inside the input dir, so it does not
  pollute the source tree.

When a path could be confused with a target language, prefer the explicit `--input` / `--output`
flags.

## Steps

1. **Confirm the Workflow tool is enabled.** It is gated behind an env var. Run:
   ```bash
   echo "${CLAUDE_CODE_WORKFLOWS:-<not set>}"
   ```
   If it is `<not set>`, STOP and tell the user to enable it before this command can run, either:
   - per session: `export CLAUDE_CODE_WORKFLOWS=1 && claude`, or
   - persistently in `.claude/settings.local.json`: `{ "env": { "CLAUDE_CODE_WORKFLOWS": "1" } }`

2. **Build the args object** from the parsed arguments:
   - `target`: the single target language (omit if none given).
   - `inputDir`: the resolved input dir (`--input` flag, else positional `[input-dir]`, else `"."`).
   - `outputDir`: the `--output` value if given; otherwise omit it and let the workflow default to
     `<inputDir>/<target-language>` (`<inputDir>/.portkit` if no target).
   - Optional tuning knobs the user may pass through (only if they ask): `maxEpics`, `maxSlices`,
     `maxHintsPerTarget`, `maxGapfillRounds`, and `maxConcurrency` (max agents in flight at once;
     defaults to `8` — lower it if the run is being API-rate-limited/throttled, raise it to go faster
     on an account with generous limits).

3. **Invoke the workflow** with the `Workflow` tool, pointing `scriptPath` at the bundled script and
   passing the args object:
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/portkit.js",
     args: { target: "rust", inputDir: "...", outputDir: "..." }
   })
   ```
   The workflow runs in the background; watch it live with `/workflows`.

4. **When it completes**, report the returned summary: where the docs were written (`outDir`), the
   slice counts, any **truncations** (capped epics/slices — these are real coverage gaps, surface
   them), and the **remaining gaps** — especially `gapsRemainingHumanDecision`, which are items a
   human must resolve (e.g. dependencies with no clean target equivalent).

## Notes

- Output lands in the sibling dir `<input-dir>_<target-language>/` by default (or
  `<input-dir>_portkit/` with no target), never inside the input dir. The **neutral core** (system
  map, kernel, vertical-slice docs, build-order index,
  behavioral spec) is reusable across targets; each `targets/<lang>/` layer is additive and
  prescriptive. To cover several targets, run again pointed at the same `--output`: the neutral core
  is reused and only the new `targets/<lang>/` layer is added.
- This command produces **documents only** — it does not perform the recreation.
