# Local scale reference

These measurements describe one local Docker run of the `v0.1` code at 100, 500,
and 1,000 small plain-text documents. They are reference measurements, not service
level guarantees, capacity limits, or claims about larger or more complex corpora.

## Results

| Documents | Ingestion total | Per document | Sampled peak RSS | Volume storage | Cold search p50 / p95 | Warm search p50 / p95 | Restart to health / search |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 62.9 s | 629 ms | 260 MiB | 9.4 MiB | 5.9 / 8.3 ms | 5.7 / 7.2 ms | 0.6 / 0.7 s |
| 500 | 195.5 s | 391 ms | 277 MiB | 46.0 MiB | 8.7 / 10.3 ms | 8.6 / 9.8 ms | 0.8 / 0.9 s |
| 1,000 | 358.6 s | 359 ms | 256 MiB | 91.9 MiB | 8.7 / 10.0 ms | 8.6 / 10.2 ms | 0.6 / 0.7 s |

The 1,000-document run completed without a crash, an out-of-memory event, data
corruption, or a missed expected result. The decrease in sampled peak RSS between
runs is measurement variability, not evidence that larger corpora use less memory.

The content-free machine-readable reports contain the exact values:

- [100 documents](results/scale-100.json)
- [500 documents](results/scale-500.json)
- [1,000 documents](results/scale-1000.json)

## Measurement environment

- Host: Apple M4 Pro, 12 logical CPUs, 24 GiB RAM, arm64
- Docker server: 29.4.0, with 11.73 GiB visible to containers
- Image platform: `linux/arm64`
- Image digest: `sha256:a5eac1da7ccff63373c14ed0b880dc58deae45c2b7e63cd483cb3784e2144c6c`
- Image revision: `5eb25d34c75851ea215544cbad58cadbef6a7c6c`

Each size ran alone in a newly created, dedicated Docker volume. Documents were
uploaded sequentially, and the runner waited for each document to reach `ready`
before uploading the next one. Every fixture had a unique `LOCAL-RAG-NNNN`
identifier. The runner searched every identifier once for the cold pass and once
for the warm pass and required its document in the top five results.

RSS is the largest of 21 `docker stats --no-stream` samples taken during ingestion
plus startup and post-restart samples; it is a sampled peak rather than a continuous
maximum. Storage is allocated space reported by `du -sk /app/data`. Restart timing
is measured by polling `/health` directly (not Docker's own healthcheck
cadence) until it succeeds, then running one successful search.

The fixtures are intentionally small and uniform. PDFs, DOCX files, large files,
long documents with many chunks, concurrent uploads, and different host hardware
can materially change these numbers.

## Reproduce a run

Build and start the image with a new test-only volume and a loopback-only port. Do
not point the scale runner at a volume containing documents you want to keep: it
refuses a non-empty corpus, but the volume should still be treated as disposable.

```sh
docker build -t mcp-knowledge-scale:local .
docker volume create mcp-knowledge-scale-100
docker run -d --name mcp-knowledge-scale \
  -p 127.0.0.1::3000 \
  -v mcp-knowledge-scale-100:/app/data \
  mcp-knowledge-scale:local
docker port mcp-knowledge-scale 3000/tcp
```

Use the loopback address printed by `docker port` as `BASE_URL`. The output path
must not already exist, and the supported sizes are exactly 100, 500, and 1,000.

```sh
mkdir -p tmp/scale
BASE_URL=http://127.0.0.1:PORT \
SCALE_CONTAINER=mcp-knowledge-scale \
bun run scale --documents 100 --output tmp/scale/scale-100.json
```

Run each size against a separate fresh container and volume. Remove only those
test resources when finished.
