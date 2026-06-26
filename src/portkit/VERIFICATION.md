# Verifying portkit

This plugin produces documents via a gated background Workflow, so verification has two tiers:
**static** (runnable now, no prerequisites) and **runtime** (requires enabling the Workflow tool and
a source fixture).

## Tier 1 — Static validation (no prerequisites)

These check the plugin is well-formed and the workflow is loadable. All currently **PASS**.

```bash
# from the marketplace repo root

# unit + integration tests + a full-file syntax gate. Covers three layers:
#  - portkit.deterministic.test.mjs — unit-tests the pure helpers in the
#    <portkit:deterministic> region (topoSort, rewriteEdges, buildEpicTree,
#    projectAgents, planEpicBatches), extracted from the file so the shipped code
#    IS the tested code; plus a full-file async-wrap parse gate.
#  - portkit.run.test.mjs — RUNS the whole workflow body with a mock runtime
#    (stub agent()/log()/phase()), validating the normal path, slice merging, and
#    the over-scale partition + resume passes (no slice dropped) — no model calls.
# NOTE: plain `node --check` CANNOT validate the workflow — its body has top-level
# `return`/`await`, legal only because the runtime wraps it in an async function;
# the parse gate mimics that wrap.
npm test

# workflow-creator linter (meta block, determinism bans, size)
node ~/.claude/plugins/cache/ae-skills/skills/0.1.0/skills/workflow-creator/scripts/validate-workflow.mjs \
  src/portkit/workflows/portkit.js

# manifests are valid JSON and the marketplace source resolves
node -e 'const fs=require("fs");
  JSON.parse(fs.readFileSync("src/portkit/.claude-plugin/plugin.json"));
  const m=JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json"));
  const e=m.plugins.find(x=>x.name==="portkit");
  if(!fs.existsSync(e.source.replace(/^\.\//,"")+"/.claude-plugin/plugin.json")) throw "source unresolved";
  console.log("static checks OK");'
```

Plus the `plugin-dev:plugin-validator` agent reports overall **PASS** for the manifest, marketplace
entry, command frontmatter/`Workflow` wiring, workflow presence, and auto-discovery layout.

## Tier 2 — Runtime (the real test)

> **Not yet executed.** Requires: (1) enabling the gated Workflow tool, and (2) a source fixture.
> Until this tier runs, the plugin is verified as *well-formed*, not as *producing good docs*.

### Prerequisites

1. Enable the Workflow tool:
   ```bash
   export CLAUDE_CODE_WORKFLOWS=1 && claude
   ```
2. A small **source fixture with good test coverage** — one language, modest size. **No fixture
   ships in this repo yet** (`src/examples/` does not exist); Tier 2 is blocked until one is added.
   The intended fixture is a tested Go HTTP JSON service (~4 vertical capabilities, `go test ./...`
   passing at high coverage). Use a target language other than `go` (e.g. `rust`, `typescript`) so
   the mapping layer is meaningful.

### Run

```
/portkit <target-lang> src/examples/seeds-go
```

### Acceptance gates

| # | Gate | How to check |
|---|---|---|
| 1 | Full doc set produced | `00-system-map.md`, `KERNEL.md`, `kernel/cross-cutting.md`, `epics/INDEX.md`, ≥1 `epics/**/NNNN-*.md`, `RISKS-AND-GAPS.md` all exist under the fixture's `.portkit/` |
| 2 | Grounding | Sample `path:line` citations in the neutral core; each resolves to real source |
| 3 | Slice integrity | `epics/INDEX.md` order is topological; pick 3 slices — each is end-to-end, self-contained, has acceptance tests, references only the kernel (no dangling cross-slice refs) |
| 4 | Behavioral spec | Acceptance criteria trace back to actual fixture tests; thin areas are flagged |
| 5 | Truncations surfaced | The workflow result's `truncations` array and `RISKS-AND-GAPS.md` name anything capped (no silent drops) |
| 6 | Human-decision deps | Non-portable deps appear as `HUMAN-DECISION-REQUIRED` in `targets/<lang>/dependency-map.md`, not silent guesses |

### Gate 7 — the core bet (stretch, the only test that truly validates the premise)

Hand a handful of ordered slices (+ the kernel) to an **actual weak local model** (ollama/omlx) and
confirm it can produce passing units **from the docs alone**, without the source. If it can't, the
IR — not the orchestration — is what needs work.

## Known limitation

The plugin cannot prove its own output is good (it produces docs only). Gate 7 is the real proof and
must be run by a human with a local model; Gates 1–6 are necessary but not sufficient.
