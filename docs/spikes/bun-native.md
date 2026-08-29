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
- libSQL vector KNN was **not** spiked here (plan M0 did not include it). Still required before M3 trusts `F32_BLOB` / `libsql_vector_idx`.
