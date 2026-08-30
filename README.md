# Document Knowledge MCP Service

Self-hostable document knowledge service. Ingest files, index them locally, retrieve over HTTP and MCP. No hosted LLM required.

## Development (local)

```bash
bun install
bun db:migrate
bun dev
```

No `DASHBOARD_PASSPHRASE` set means the instance has no auth at all — the dashboard, REST API, and MCP all just work. There's no network-position check anywhere (no loopback bypass, no bind-host special-casing) — auth here means "protected the same way for everyone, or not protected at all." Set `DASHBOARD_PASSPHRASE` any time you want the dashboard behind a login, including on the local profile.

Dashboard, REST, and MCP share one `Bun.serve()` process (default `http://127.0.0.1:3000`). Retrieval playground: `/playground`.

### With a passphrase set

```bash
DASHBOARD_PASSPHRASE=correct-horse-battery-staple bun dev
```

Opening the dashboard now prompts for the passphrase. On success the server sets an `HttpOnly`, `SameSite=Strict` session cookie (`mk_session`, 30 days) — the browser carries it automatically from then on, no token to copy anywhere. Logging in also unlocks `/api/v1/*` for that browser session, so you can mint your first API key from the dashboard itself. Wrong-passphrase attempts are rate-limited per remote address.

This is what makes it safe to put a real reverse proxy in front of an instance: the proxy can forward a session cookie, but it can't mint one — the passphrase is still required to establish it. `APP_PROFILE=server` refuses to boot without `DASHBOARD_PASSPHRASE` set, for exactly this reason.

### Generate an API key

API keys are for MCP clients and scripts — separate from the dashboard's passphrase/session. Once a passphrase is set, minting a key requires either an active dashboard session or an existing `admin` key:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/v1/api-keys \
  -H 'content-type: application/json' \
  -b 'mk_session=<value from the dashboard login response>' \
  -d '{"name":"local","scopes":["admin"]}'
```

The response includes `secret` once (a `key_…` string). Copy it; only a hash is stored. Omit `scopes` to get `read`. Allowed scopes: `read`, `write`, `admin`.

```bash
curl -sS http://127.0.0.1:3000/api/v1/documents \
  -H "Authorization: Bearer <secret>"
```

Use the same header on `/mcp`. MCP tools are read-only.

Empty the corpus: `POST /api/v1/documents/purge` with `{ "confirm": "purge" }`. Collections and API keys stay.

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

If no `DASHBOARD_PASSPHRASE` is set, the header can be omitted entirely.

URL ingest: `POST /api/v1/documents/from-url` with `{ "url": "https://..." }`. Localhost, RFC1918, link-local, and cloud metadata targets are blocked (including redirects).
