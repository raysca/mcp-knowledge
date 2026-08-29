/**
 * M2 will spawn AnyDoc in a child process. This spike proves Bun.spawn can
 * pipe document bytes on stdin and read a reply on stdout.
 */
const fixture = Bun.file(new URL("./fixtures/hello.docx", import.meta.url));
const bytes = await fixture.bytes();

const proc = Bun.spawn(["bun", "run", "scripts/spike-anydoc-child.ts"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const stdoutPromise = new Response(proc.stdout).text();
const stderrPromise = new Response(proc.stderr).text();
await proc.stdin.write(bytes);
await proc.stdin.end();

const [out, err, code] = await Promise.all([
  stdoutPromise,
  stderrPromise,
  proc.exited,
]);

if (code !== 0) {
  throw new Error(`child exit ${code}: ${err}`);
}
const parsed = JSON.parse(out) as { ok: boolean; blocks?: number; error?: string };
if (!parsed.ok || !parsed.blocks) {
  throw new Error(`bad child reply: ${out}`);
}
console.log("anydoc spawn ok", parsed.blocks);
