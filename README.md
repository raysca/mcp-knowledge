# Document Knowledge MCP Service

Self-hostable document knowledge service. Ingest files, index them locally, retrieve over HTTP and MCP. No hosted LLM required.

## Development (local)

```bash
bun install
bun db:migrate
AUTH_DISABLED=true bun dev
```

`AUTH_DISABLED=true` is required for the dashboard to call `/api/v1` without a key. It only skips auth when the **request's remote address** is loopback (`127.0.0.1` / `::1`). Binding `0.0.0.0` does not disable auth for non-local clients.

Dashboard, REST, and MCP share one `Bun.serve()` process (default `http://127.0.0.1:3000`).

Create an API key (once auth is on):

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/api-keys \
  -H 'content-type: application/json' \
  -d '{"name":"local","scopes":["admin"]}'
```

The `secret` is shown once. Send `Authorization: Bearer <secret>` on `/api/v1` and `/mcp`. Scopes: `read`, `write`, `admin`. MCP tools are read-only.

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
