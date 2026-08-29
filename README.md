# Document Knowledge MCP Service

Self-hostable document knowledge service. Ingest files, index them locally, retrieve over HTTP and MCP.

## Development (local)

```bash
bun install
bun db:migrate
bun dev
```

Dashboard and API share one `Bun.serve()` process on port 3000. Uploaded files stay `pending` until M2 parsing.

```bash
bun run spike:anydoc
bun run spike:anydoc:spawn
bun run spike:embed
bun run spike:embed:worker
```

See `docs/spikes/bun-native.md` for Bun + AnyDoc + MiniLM results.
