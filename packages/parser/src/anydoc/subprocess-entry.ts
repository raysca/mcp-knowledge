import { convertToNormalizedDocument } from "./convert.ts";

const bytes = await Bun.stdin.bytes();
try {
  const mapped = await convertToNormalizedDocument(bytes);
  process.stdout.write(JSON.stringify({ ok: true, doc: mapped }));
} catch (err) {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "malformed";
  process.stdout.write(
    JSON.stringify({
      ok: false,
      code,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
}
