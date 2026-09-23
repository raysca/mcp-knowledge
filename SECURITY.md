# Security

This is a local, single-tenant document knowledge service. It is designed to
be exposed to whoever you choose to expose it to, no more.

## Default exposure

`docker compose up` binds the service to `127.0.0.1:3000` only — nothing
outside the host can reach it. There is no other default network boundary:
with no `DASHBOARD_PASSPHRASE` set, anyone who can reach that address has full
read/write access to the dashboard, REST API, and MCP endpoint. That is fine
for a service only your own machine can reach.

**Before exposing the service beyond loopback** — a LAN address, a reverse
proxy, a tunnel, anything not `127.0.0.1` — set `DASHBOARD_PASSPHRASE`. There
is no network-position exception anywhere in auth (no loopback bypass, no
"trust this proxy" special case): a passphrase is checked the same way for
every caller once it's set, which is what makes it safe to put a real reverse
proxy in front at all. `APP_PROFILE=server` enforces this by refusing to boot
without `DASHBOARD_PASSPHRASE` set; the local profile trusts you to set it
yourself before widening exposure.

## API keys and sessions

Dashboard logins use an `HttpOnly`, `SameSite=Strict` session cookie.
MCP clients and scripts use API keys (`key_…`, scopes `read`/`write`/`admin`)
instead — shown once at creation, only a hash is stored afterward. Treat a
captured API key or session cookie as equivalent to full dashboard access at
its scope; rotate a key by deleting it and minting a new one if you suspect
exposure.

## Backups

A backup archive (see [backup-and-restore.md](docs/backup-and-restore.md))
contains every document original, extracted text, embeddings, job history,
and API-key hash records — treat it with the same access controls as the
running service, not as a plain file to leave in a shared folder.

## URL ingest and SSRF

`POST /api/v1/documents/from-url` fetches an operator-supplied URL from the
server, so it is a standard SSRF surface. Requests to loopback, RFC1918/link-
local ranges, `0.0.0.0/8`, and known cloud metadata hostnames are blocked,
including through a redirect, and the eventual HTTP connection is pinned to
the exact IP address that was validated (closing the DNS-rebinding gap where
a hostname could resolve differently between the check and the fetch). This
blocklist is intentionally hardcoded, not a configurable allow-list — do not
add one to this boundary.

## What is out of scope for v0.1

No hosted OCR, no distributed/multi-node deployment, no built-in TLS
termination (put a reverse proxy in front for that), no rate limiting beyond
login attempts. Don't expose this service to the public internet without
your own reverse proxy, TLS, and network controls in front of it.

## Reporting a vulnerability

Report vulnerabilities through GitHub's [private vulnerability reporting](https://github.com/raysca/mcp-knowledge/security/advisories/new).
Do not open a public issue for sensitive reports. Follow the same rule as
[troubleshooting.md](docs/troubleshooting.md): never
include document contents, file paths, API keys, session cookies, passphrases,
or raw stack traces in a report. Describe the request/response shape and
observed behavior instead; a maintainer will request further detail privately
if needed.
