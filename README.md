# Document Knowledge MCP Service

Self-hostable document knowledge service. Ingest files, index them locally, retrieve over HTTP and MCP. No hosted LLM required.

## Development (local)

```bash
bun install
bun db:migrate
AUTH_DISABLED=true bun dev
```

`AUTH_DISABLED=true` is required for the dashboard to call `/api/v1` without a key. It only skips auth when the **request's remote address** is loopback (`127.0.0.1` / `::1`). Binding `0.0.0.0` does not disable auth for non-local clients — but a reverse proxy on the same machine (nginx, Caddy, Cloudflare Tunnel, Tailscale Funnel) does, because every request then arrives from the proxy's own loopback address. **Don't set `AUTH_DISABLED=true` on an instance reachable through a reverse proxy** — that grants every proxied caller a free pass, not just you.

Dashboard, REST, and MCP share one `Bun.serve()` process (default `http://127.0.0.1:3000`). Retrieval playground: `/playground`.

### Generate an API key

Create an API key (once auth is on):

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/api-keys \
  -H 'content-type: application/json' \
  -d '{"name":"local","scopes":["admin"]}'
```

The response includes `secret` once (a `key_…` string). Copy it; only a hash is stored. Omit `scopes` to get `read`. Allowed scopes: `read`, `write`, `admin`.

```bash
curl -sS http://127.0.0.1:3000/api/v1/documents \
  -H "Authorization: Bearer <secret>"
```

Use the same header on `/mcp`. MCP tools are read-only. Creating further keys requires an `admin` key (unless the caller is a loopback remote with `AUTH_DISABLED=true`).

### Cursor / Claude MCP (Streamable HTTP)

```json
{
  "mcpServers": {
    "knowledge": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <secret>"
      }
    }
  }
}
```

With `AUTH_DISABLED=true` and a loopback client, the header can be omitted.

URL ingest: `POST /api/v1/documents/from-url` with `{ "url": "https://..." }`. Localhost, RFC1918, link-local, and cloud metadata targets are blocked (including redirects).
