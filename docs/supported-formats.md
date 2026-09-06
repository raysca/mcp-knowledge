# Supported formats and limits

## File types accepted for upload

Upload acceptance is by file extension (`isAllowedUpload` in
[`packages/core/src/mime.ts`](../packages/core/src/mime.ts)):

`pdf`, `doc`, `docx`, `docm`, `ppt`, `pptx`, `pptm`, `xls`, `xlsx`, `xlsm`,
`csv`, `txt`, `md`, `markdown`, `html`, `htm`, `json`, `xml`, `rtf`, `epub`,
`odt`, `ods`, `odp`.

Any other extension is rejected before parsing (`DOCUMENT_UNSUPPORTED_FORMAT`).
Content type is sniffed from file bytes/extension for storage, not used to
widen or narrow the allow list.

## OCR and password-protected files

There is no OCR step. A PDF or image-only document with no extractable text
fails with `DOCUMENT_NEEDS_OCR`; run OCR in an external tool first, then
upload the searchable result. A password-protected file fails with
`DOCUMENT_ENCRYPTED`; remove the password before uploading. See
[troubleshooting.md](troubleshooting.md) for the full failure-code table.

## Native parser behavior

PDF and Office formats (`doc`/`docx`/`docm`, `ppt`/`pptx`/`pptm`,
`xls`/`xlsx`/`xlsm`, `odt`/`ods`/`odp`) are parsed by AnyDoc's native addon in
a spawned subprocess, one document at a time — a crash or hang in that
process fails the job, not the server. This is why the release smoke and
platform test scripts always exercise a real PDF and DOCX on both
`linux/amd64` and `linux/arm64`: native modules can behave differently per
architecture.

## Size and resource limits

Defaults from [`apps/server/src/config/env.ts`](../apps/server/src/config/env.ts),
overridable by environment variable:

| Limit | Default | Env var |
| --- | ---: | --- |
| Upload size | 64 MiB (67,108,864 bytes) | `MAX_UPLOAD_BYTES` |
| Extracted text size | 8 MiB (8,388,608 bytes) | `MAX_EXTRACT_BYTES` |
| Document pages | 500 | `MAX_DOCUMENT_PAGES` |
| Spreadsheet cells | 200,000 | `MAX_SPREADSHEET_CELLS` |
| Archive (e.g. `.docx` zip) uncompressed size | 100 MiB (104,857,600 bytes) | `MAX_ARCHIVE_UNCOMPRESSED_BYTES` |
| Archive entries | 1,024 | `MAX_ARCHIVE_ENTRIES` |
| Archive compression ratio | 100x | `MAX_ARCHIVE_COMPRESSION_RATIO` |
| Parser subprocess timeout | 30 s | `PARSER_TIMEOUT_MS` |
| Total ingestion timeout | 600 s | `INGESTION_TIMEOUT_MS` |
| Chunks per document | 20,000 | `MAX_CHUNKS_PER_DOCUMENT` |

Exceeding an upload-size or archive limit fails fast with `PAYLOAD_TOO_LARGE`
or `DOCUMENT_RESOURCE_LIMIT`; exceeding the ingestion timeout fails with
`INGESTION_TIMEOUT`. These are the same codes and recovery actions documented
in [troubleshooting.md](troubleshooting.md).

## What these limits do not promise

The [scale reference](performance.md) only measured small, uniform plain-text
documents. Larger PDFs/DOCX files, documents near these limits, or corpora
much larger than 1,000 documents were not measured and are not guaranteed to
perform the same way.
