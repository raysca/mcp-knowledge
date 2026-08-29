import { toDocument } from "@firecrawl/anydoc";

const bytes = await Bun.stdin.bytes();
try {
  const doc = await toDocument(bytes);
  const blocks = (doc as { blocks?: unknown[] }).blocks ?? [];
  process.stdout.write(JSON.stringify({ ok: true, blocks: blocks.length }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
