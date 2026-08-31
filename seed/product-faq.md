# Frequently Asked Questions

## What is the Document Knowledge service?

It is a self-hostable service that ingests documents, chunks and embeds them
locally, and exposes hybrid vector + lexical search over both an MCP
interface and a REST API. It is infrastructure, not a chat app.

## Do I need an OpenAI or Anthropic API key to run it?

No. Embeddings run locally through a bundled ONNX model
(`Xenova/all-MiniLM-L6-v2`, 384 dimensions). There is no required external AI
dependency for the default deployment profile.

## What file types can I upload?

PDF, Word (doc/docx/docm), PowerPoint (ppt/pptx/pptm), Excel
(xls/xlsx/xlsm), CSV, plain text, Markdown, HTML, JSON, XML, RTF, EPUB, and
the OpenDocument formats (odt/ods/odp).

## How does search ranking work?

Every query runs two retrieval passes in parallel: a vector similarity
search over embeddings and a lexical full-text search using FTS5 or
`tsvector` with no stemming, since stemming breaks exact matches on things
like SKUs and error codes. The two ranked lists are fused with Reciprocal
Rank Fusion using k=60. Every search hit reports its vector rank, lexical
rank, and fused score so results are explainable rather than a black box.

## Can I run this without Postgres?

Yes. The `local` deployment profile uses libSQL and the local filesystem for
storage, with an embedded worker process. The `server` profile swaps in
Postgres, S3, and distributed-safe job locking, using the same application
code with different configuration.

## What happens to a document after I delete it?

Deleting a document removes it and its derived chunks and embeddings from
the index. The original file that was stored at upload time is deleted as
well; there is no soft-delete or undo.

## How do collections work?

A collection is an optional grouping you can attach documents to at upload
time or afterward. Search can be scoped to a single collection or run across
everything.

## Is there a webhook for ingestion completion?

Not in this release. Poll `GET /api/v1/documents/:id` or watch the jobs
dashboard for status. Push delivery via webhooks is planned for a later
release once a real integration needs it.

## What are the upload limits?

The default maximum upload size is 64 MiB per file
(`MAX_UPLOAD_BYTES=67108864`). Limits on document pages, spreadsheet cells,
and archive contents are also enforced and documented in the operator spec.
