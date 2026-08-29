# Bun native spikes (M0)

Date: 2026-08-29  
Machine: macOS Silicon, Bun 1.3.13

## AnyDoc

| Item | Result |
| --- | --- |
| Package | `@firecrawl/anydoc@0.2.4` |
| Binding | N-API (not WASM) |
| `toDocument(bytes)` | Pass — `hello.docx` → 2 blocks |
| `Bun.spawn` stdin/stdout | Pass — child `scripts/spike-anydoc-child.ts` |
| Hosted OCR | Not enabled |

N-API loads under Bun. M2 should spawn `scripts/spike-anydoc-child.ts` (later `packages/parser/.../subprocess-entry.ts`) the same way: drain stdout/stderr while writing stdin.

WASM fallback (`@firecrawl/anydoc-wasm`) was **not** needed.

## MiniLM embeddings

| Item | Result |
| --- | --- |
| Package | `@huggingface/transformers@4.2.0` |
| Snapshot | `models/default/` from `Xenova/all-MiniLM-L6-v2` |
| File | `onnx/model_uint8.onnx` (~22 MB) |
| Load | `pipeline("feature-extraction", <abs path>, { local_files_only: true, dtype: "uint8" })` |
| `env.allowRemoteModels` | `false` |
| Main thread | Pass — 384-d vector |
| `Worker` + `postMessage` | Pass — 384-d vector |
| `Worker.terminate()` | **Do not call** after ONNX NAPI load |

`Worker.terminate()` after the ONNX runtime is in the worker panics Bun 1.3.13 (`NAPI FATAL ERROR` / SIGTRAP). Keep the embedding worker alive for the process lifetime; on shutdown use `process.exit`, not `terminate()`.

`onnxruntime-node` fallback was **not** needed.

## Commands

```bash
bun run spike:anydoc
bun run spike:anydoc:spawn
bun run spike:embed
bun run spike:embed:worker
```

## Implications for later milestones

- M2: AnyDoc in a subprocess is proven on this runtime.
- M3: MiniLM in a Bun `Worker` is proven; do not `terminate()` that worker on each job.

## libSQL vector (M3, 2026-08-29)

| Item | Result |
| --- | --- |
| Column | `F32_BLOB(4)` (same as 384) |
| Insert | `vector32('[1,0,0,0]')` |
| Index | `CREATE INDEX t_idx ON t (libsql_vector_idx(embedding))` — ok |
| Search | `ORDER BY vector_distance_cos(embedding, vector32(?))` — ok |
| Distances | identical → `0`; orthogonal → `1` |

Score as `1 - distance`. `vector_top_k` was not needed: exact cosine scan with `WHERE` filters is enough for v1 local size, and joins on `rowid` while `document_chunks.id` is TEXT.
