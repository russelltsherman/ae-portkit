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
#    <portkit:deterministic> region (topoSort, rewriteEdges, buildFeatureTree,
#    projectAgents, planFeatureBatches, parseArgs), extracted from the file so the
#    shipped code IS the tested code; plus a full-file async-wrap parse gate.
#  - portkit.run.test.mjs — RUNS the whole workflow body with a mock runtime
#    (stub agent()/log()/phase()), validating the normal path, slice merging, the
#    doc-family + ADR fan-out, staged checkpoint/auto-resume (resume from map,
#    partial discovery, or synthesized; source-fingerprint mismatch; --fresh), and
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

1. The Workflow tool (part of Claude Code) must be available — enabled via your Claude settings, not
   a `CLAUDE_CODE_WORKFLOWS` shell env var (that variable is not used).
2. A small **source fixture with good test coverage** — one language, modest size. **No fixture
   ships in this repo yet** (`src/examples/` does not exist); Tier 2 is blocked until one is added.
   The intended fixture is a tested Go HTTP JSON service (~4 vertical features, `go test ./...`
   passing at high coverage).

### Run

```
/portkit src/examples/seeds-go
```

### Acceptance gates

| # | Gate | How to check |
|---|---|---|
| 1 | Full doc set produced | `PRD.md`, `ARCHITECTURE.md`, `INDEX.md`, `ACCEPTANCE.md`, `RISKS-AND-GAPS.md`, ≥1 `specs/NNNN-*.md` all exist under the fixture's `_portkit/` dir |
| 2 | Grounding | Sample `path:line` citations in ARCHITECTURE.md and the slice specs; each resolves to real source |
| 3 | Slice-spec integrity | `INDEX.md` order is topological; pick 3 slice specs — each is end-to-end, self-contained, has acceptance criteria, references only ARCHITECTURE.md (no dangling cross-slice refs) |
| 4 | Acceptance spec | `ACCEPTANCE.md` criteria trace back to actual fixture tests; thin areas are flagged |
| 5 | Truncations surfaced | The workflow result's `truncations` array and `RISKS-AND-GAPS.md` name anything capped (no silent drops) |
| 6 | ADRs present + evidenced | ≥1 `adr/NNNN-*.md`, each in MADR form with status `Reconstructed`, a `path:line`-evidenced decision, and rationale/"why" tagged `[INFERRED]` |
| 7 | Inference tagged, not asserted | PRD goals/non-goals/success-metrics and ADR rationale carry `[INFERRED]`; functional requirements cite `path:line`. No inference is presented as observed fact |
| 8 | Resumability | Interrupt a run mid-discovery (Ctrl-C / kill), confirm `<output>/.portkit/ir.json` exists with a `stage`, then re-run the SAME command: it logs `↩️ Resuming from checkpoint stage '…'`, does NOT re-run `map:survey` or already-analyzed `discover:*` features, and finishes. On clean completion the checkpoint file is gone. `--fresh` forces a full reprocess |
| 9 | Token-budget chunking | Run with a small `maxTokensPerRun` (or a `+Nk` directive). The run returns `stoppedForBudget: true` + `resumeRequired: true`, having advanced past `mapped`, and `.portkit/ir.json` reflects the paused `stage`. Repeated resumes (or `/loop`) complete the kit with **every** slice spec written exactly once and no dangling `INDEX.md` links; the checkpoint is cleared on final completion. With **no** budget set, a normal run finishes in one pass (byte-identical) |
| 10 | Scope/fresh safety | Resuming a checkpoint built with different `maxFeatures`/`limitSlices` aborts loudly (does not silently continue the smaller scope). A `--fresh` run over an existing kit clears `.portkit` and overwrites the prior docs (no stale 5-feature `INDEX.md` left behind) |

### Gate 11 — the core bet (stretch, the only test that truly validates the premise)

Hand a handful of ordered slice specs (+ ARCHITECTURE.md) to an **actual weak local model**
(ollama/omlx) and confirm it can produce passing units **from the docs alone**, without the source.
If it can't, the IR — not the orchestration — is what needs work.

## Known limitation

The plugin cannot prove its own output is good (it produces docs only). Gate 9 is the real proof and
must be run by a human with a local model; Gates 1–10 are necessary but not sufficient.
