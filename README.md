# ae-portkit

A Claude Code plugin marketplace (`ae-portkit`) exposing the `portkit` plugin: reverse-engineer a
codebase into a **stack-neutral recreation kit** — a PRD, an architecture spec, per-feature specs,
ADRs, and acceptance criteria — so a weaker downstream model can recreate the software from the
documents alone.

## Install

From inside Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add russelltsherman/ae-portkit
/plugin install portkit@ae-portkit
```

See [`src/portkit/README.md`](src/portkit/README.md) for usage and
[`src/portkit/VERIFICATION.md`](src/portkit/VERIFICATION.md) for validation.
