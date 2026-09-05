# Task 7 report: safe actionable ingestion failures

## RED / GREEN

- RED: added the core and UI contract tests, then ran
  `bun test tests/unit/ingestion-failure.test.ts tests/unit/ingestion-error-ui.test.tsx`.
  The run failed because `publicIngestionFailure` was not exported and the UI
  parser module did not exist.
- RED: added the worker persistence regression test and ran the focused suite.
  It failed with the original raw parser text (`parser read
  /Users/private/secret.pdf token super-secret-token`) in the job error.
- GREEN: introduced the fixed public failure record, mapped the worker error
  once before both persistence calls, and rendered only code-derived text in
  Documents, Jobs, and document detail. The focused suite then passed.

## Commands and results

- `bun test tests/unit/ingestion-failure.test.ts tests/unit/ingestion-error-ui.test.tsx tests/unit/worker-loop.test.ts` — 19 pass, 0 fail.
- `bun run typecheck` — passed.
- `bun run ui:css` — passed.
- `bun test` — 216 pass, 0 fail, 820 assertions.
- `bun run typecheck` — passed after the full suite.
- `git diff --check` — passed.

## Files

- Added `packages/core/src/ingestion-failure.ts` and exported its bounded public
  mapper from the core package.
- Changed `apps/server/src/workers/loop.ts` to persist the same safe
  `CODE: message` string for the failed job and document.
- Added `apps/server/src/ui/lib/ingestion-error.ts` and applied it in Documents,
  Jobs, and document detail.
- Added unit tests for core mapping, safe worker persistence, UI parsing/static
  rendering, and leakage prevention.
- Added `docs/troubleshooting.md` with all error codes, operator checks, retry/
  reindex guidance, and safe bug-report instructions.

## Security review

- Arbitrary error messages are not copied into either persistence call; the
  worker maps the error once to fixed, bounded public copy.
- The UI reads only the `CODE:` prefix and discards the stored message, so old
  hostile persisted strings are not rendered.
- Tests cover `/Users/private/secret.pdf` and `super-secret-token` and assert
  neither appears in core output, job persistence, document persistence, or
  static UI markup.

## Concerns

- No outstanding implementation concerns. Existing historic database rows are
  not rewritten, but their messages are ignored by the UI parser; newly written
  worker failures use the safe format.

## Fix round 1: timeout and own-property hardening

- RED: `bun test tests/unit/ingestion-failure.test.ts tests/unit/worker-loop.test.ts tests/unit/ingestion-error-ui.test.tsx` — 13 pass, 10 fail. The real worker timeout persisted `DOCUMENT_MALFORMED`, malformed copy differed from the revised contract, and `toString`, `constructor`, and `__proto__` returned inherited function/object values.
- GREEN: the same focused command — 23 pass, 0 fail before the additional UI inherited-code coverage; the UI-only inherited-code check also passed (12 pass, 0 fail) because its uppercase code grammar already rejects those values.
- Full verification: `bun test` — 223 pass, 0 fail, 829 assertions; `bun run typecheck` and `git diff --check` passed.
- The worker now throws a coded internal `AppError` only at the timeout race boundary, so arbitrary plain `Error("INGESTION_TIMEOUT")` text is not treated as a trusted code.
- The public mapper uses `Object.hasOwn` before reading its record. Tests prove all three inherited key names fall back to `{ code: "DOCUMENT_MALFORMED", message: "This document could not be parsed." }` without function or object leakage.
- Self-review: public persistence still occurs exactly once in the worker catch path; the job and document receive the same fixed string, and UI actions are derived from that code. Updated malformed copy is identical in core, UI, and troubleshooting guidance.
