# sydes-pi

Foundation for a Sydes graph-aware coding-agent policy extension on the Pi harness.

Phase 0 keeps the implementation intentionally small:

- Pi owns the normal agent loop, model/provider calls, filesystem tools, shell tools, sessions, and compaction.
- Sydes exposes only foundation wiring for now.
- Codebase Memory is treated as a local structural graph backend through its one-shot CLI.
- No model-facing CBM tools, verification policy, telemetry, benchmark runner, model calls, custom editor, custom patch tool, or tool overrides are included.
- Sydes uses a narrow internal CBM transport for local graph calls; it is not exposed to Pi's model/tool surface.

## Local Commands

```sh
npm run build
npm test
```

## Codebase Memory

The wrapper expects `codebase-memory-mcp` to be available on `PATH`, or an explicit binary path through `SYDES_CBM_BIN`.

Example CLI shape used by this project:

```sh
codebase-memory-mcp cli list_projects
codebase-memory-mcp cli index_repository --repo-path /path/to/repo
codebase-memory-mcp cli search_graph --project name --query "handler"
```
