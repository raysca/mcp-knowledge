# Troubleshooting ingestion failures

Ingestion errors displayed in Documents, Jobs, and document detail use a safe
`CODE: message` format. The message is fixed application copy: it does not
include parser output, paths, file contents, credentials, or stack traces.

| Code | What it means | What to do |
| --- | --- | --- |
| `DOCUMENT_NEEDS_OCR` | The document has no searchable text. | Make it searchable with OCR, then upload it again. |
| `DOCUMENT_ENCRYPTED` | The document is password-protected. | Remove the password, then upload it again. |
| `DOCUMENT_UNSUPPORTED_FORMAT` | The file type has no supported parser. | Convert it to a supported format, then upload it again. |
| `DOCUMENT_RESOURCE_LIMIT` | The extracted document is too large or complex. | Split the file or reduce its size, then upload it again. |
| `PAYLOAD_TOO_LARGE` | The upload exceeds the configured upload limit. | Split the file or reduce its size, then upload it again. |
| `INGESTION_TIMEOUT` | Processing took too long. | Retry once from Jobs. If it fails again, inspect the checks below. |
| `DOCUMENT_MALFORMED` | The file could not be read. | Re-export it from the source application, then upload it again. |

An unrecognized failure is shown as `DOCUMENT_MALFORMED`; use Jobs and this
guide rather than relying on a raw parser or worker message.

## Check the local service

For a Docker deployment, confirm the container is healthy and review its
operator logs (replace `mcp-knowledge` with the actual container name):

```sh
docker ps --filter name=mcp-knowledge
docker inspect --format '{{.State.Health.Status}}' mcp-knowledge
docker logs --tail 200 mcp-knowledge
docker logs --follow mcp-knowledge
```

For a local checkout, start the service and watch the terminal that runs it:

```sh
bun run dev
```

Do not paste unredacted logs into an issue: logs can contain local paths,
document names, request headers, or provider diagnostics.

## Check parsers and the embedding model

First make sure the file itself opens in its source application. For PDFs,
verify whether it is scanned (OCR is needed) or encrypted (remove the
password). Convert unusual office or image formats to a supported searchable
format before retrying.

If parsing succeeds but a job still fails, check that the configured embedding
model can start and has sufficient resources. Restart the service after model
or parser configuration changes, then upload a small known-good text document
to distinguish a document problem from a service problem.

## Retry and reindex safely

Use **Retry** on the Jobs page once for a timed-out job. For a fixed or
replaced source file, upload it again. Use **Reindex** on a document detail
page only after changing parser or embedding configuration; it reprocesses the
stored revision, not a newly edited file on disk.

## Reporting a problem safely

Include the displayed error code, approximate timestamp, application version,
document type and size, and whether a small known-good file succeeds. Redact
file paths, document contents, API keys, access tokens, passwords, headers,
and stack traces. Share sanitized operator logs only through the approved
support channel.
