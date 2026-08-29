# Document Knowledge MCP Service

Self-hostable document knowledge service. Ingest files, index them locally, retrieve over HTTP and MCP. No hosted LLM required.

## Development (local)

```bash
bun install
bun db:migrate
bun dev
```

The local profile skips auth for loopback remotes (`127.0.0.1` / `::1`) so the dashboard and MCP can call `/api/v1` without a key. Binding `0.0.0.0` does not disable auth for non-local clients. Set `AUTH_DISABLED=false` to require a key even on localhost. `APP_PROFILE=server` always requires a key unless you explicitly set `AUTH_DISABLED=true`.

Dashboard, REST, and MCP share one `Bun.serve()` process (default `http://127.0.0.1:3000`).

### Generate an API key

Loopback `bun dev` skips auth, so the first key can be minted with no bearer:

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

Use the same header on `/mcp`. MCP tools are read-only. Creating further keys requires an `admin` key once auth is on (`AUTH_DISABLED=false`, or any non-loopback client).

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

On the local profile, a loopback client can omit the header.

URL ingest: `POST /api/v1/documents/from-url` with `{ "url": "https://..." }`. Localhost, RFC1918, link-local, and cloud metadata targets are blocked (including redirects).
