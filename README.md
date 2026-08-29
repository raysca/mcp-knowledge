# Document Knowledge MCP Service

Self-hostable document knowledge service. Ingest files, index them locally, retrieve over HTTP and MCP.

## Development (local)

```bash
bun install
bun db:migrate   # from M1
bun dev          # from M1
```

Until M1 lands, only the M0 spikes exist:

```bash
bun run spike:anydoc
bun run spike:anydoc:spawn
bun run spike:embed
bun run spike:embed:worker
```

See `docs/spikes/bun-native.md` for Bun + AnyDoc + MiniLM results.
