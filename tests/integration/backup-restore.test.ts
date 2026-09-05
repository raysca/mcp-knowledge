import { afterAll, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { loadEnv } from "../../apps/server/src/config/env.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const backupScript = join(repositoryRoot, "scripts/backup-volume.sh");
const restoreScript = join(repositoryRoot, "scripts/restore-volume.sh");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function start(dataDirectory: string, role: "all" | "api" = "all") {
  const app = await createApp(
    loadEnv({
      ROLE: role,
      DATABASE_URL: `file:${join(dataDirectory, "knowledge.db")}`,
      STORAGE_PATH: dataDirectory,
    }),
  );
  const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  return {
    base: `http://127.0.0.1:${server.port}`,
    stop() {
      app.stop();
      server.stop(true);
    },
  };
}

async function waitForDocument(base: string, id: string, status: string, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/v1/documents/${id}`);
    const document = (await response.json()) as { status?: string; latestError?: string };
    if (document.status === status) return document;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for document ${id} to become ${status}`);
}

async function waitForJob(base: string, id: string, status: string, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/v1/jobs`);
    const body = (await response.json()) as { items: Array<{ id: string; status: string }> };
    const job = body.items.find((candidate) => candidate.id === id);
    if (job?.status === status) return job;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for job ${id} to become ${status}`);
}

async function createFakeDocker(directory: string): Promise<{ bin: string; log: string }> {
  const bin = join(directory, "bin");
  const log = join(directory, "docker.log");
  await mkdir(bin);
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'CALL'
  for argument in "$@"; do printf '\\t%s' "$argument"; done
  printf '\\n'
} >> "$MOCK_DOCKER_LOG"

if [[ "\${1:-}" == "info" || "\${1:-} \${2:-}" == "volume inspect" || "\${1:-} \${2:-}" == "image inspect" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  active_status="\${MOCK_COMPOSE_STATUS:-}"
  [[ "\${MOCK_COMPOSE_RUNNING:-0}" == "1" ]] && active_status=running
  [[ -n "$active_status" && " $* " == *" --status $active_status "* ]] && printf 'container-id\\n'
  exit 0
fi
if [[ " $* " == *" tar -tzf "* ]]; then
  [[ "\${MOCK_ARCHIVE_VALID:-1}" == "1" ]] || exit 2
  members="\${MOCK_ARCHIVE_MEMBERS:-data/}"
  if [[ " $* " != *" -P "* ]]; then
    while IFS= read -r member || [[ -n "$member" ]]; do
      printf '%s\\n' "\${member#/}"
    done <<< "$members"
  else
    printf '%s' "$members"
  fi
  exit 0
fi
if [[ " $* " == *" tar -tvzf "* ]]; then
  printf '%s' "\${MOCK_ARCHIVE_TYPES:--}"
  exit 0
fi
if [[ " $* " == *" find /app/data -mindepth 1 "* ]]; then
  [[ "\${MOCK_VOLUME_NONEMPTY:-0}" == "1" ]] && printf 'existing-entry\\n'
  exit 0
fi
if [[ -n "\${MOCK_CREATE_ARCHIVE:-}" && " $* " == *" tar -C /app -czf "* ]]; then
  printf 'mock archive' > "$MOCK_CREATE_ARCHIVE"
fi
exit 0
`,
  );
  await chmod(docker, 0o755);
  return { bin, log };
}

async function runScript(
  script: string,
  args: string[],
  input: { bin: string; log: string },
  extraEnv: Record<string, string> = {},
) {
  const process = Bun.spawn(["bash", script, ...args], {
    cwd: repositoryRoot,
    env: {
      ...Bun.env,
      PATH: `${input.bin}:${Bun.env.PATH ?? ""}`,
      MOCK_DOCKER_LOG: input.log,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("offline data-directory backup and restore", () => {
  test(
    "a complete stopped data-directory copy restores list, original bytes, hybrid search, and reindex",
    async () => {
      const source = await temporaryDirectory("mcp-backup-source-");
      const restoreParent = await temporaryDirectory("mcp-backup-restore-");
      const restored = join(restoreParent, "empty-data");
      await mkdir(restored);
      const original = new TextEncoder().encode(
        "# Heliotrope Recovery\n\nThe heliotrope recovery marker is QZ-7391 and remains searchable after restore.\n",
      );

      const first = await start(source);
      const form = new FormData();
      form.set("file", new File([original], "recovery.md"));
      const created = await fetch(`${first.base}/api/v1/documents`, {
        method: "POST",
        body: form,
      });
      expect(created.status).toBe(202);
      const { id } = (await created.json()) as { id: string };
      await waitForDocument(first.base, id, "ready");
      first.stop();

      await cp(source, restored, { recursive: true });

      const second = await start(restored);
      try {
        const listedResponse = await fetch(`${second.base}/api/v1/documents`);
        const listed = (await listedResponse.json()) as { items: Array<{ id: string }> };
        expect(listed.items.map((document) => document.id)).toContain(id);

        const downloaded = await fetch(`${second.base}/api/v1/documents/${id}/file`);
        expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(original);

        const searched = await fetch(`${second.base}/api/v1/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "heliotrope recovery QZ-7391", mode: "hybrid" }),
        });
        expect(searched.status).toBe(200);
        const results = (await searched.json()) as { hits: Array<{ documentId: string }> };
        expect(results.hits.some((hit) => hit.documentId === id)).toBe(true);

        const reindexResponse = await fetch(`${second.base}/api/v1/documents/${id}/reindex`, {
          method: "POST",
        });
        expect(reindexResponse.status).toBe(202);
        const reindex = (await reindexResponse.json()) as { id: string };
        await waitForJob(second.base, reindex.id, "completed");
        await waitForDocument(second.base, id, "ready");
      } finally {
        second.stop();
      }
    },
    120_000,
  );
});

describe("volume backup and restore shell guards", () => {
  test("backup rejects a missing destination and an existing destination before Docker", async () => {
    const directory = await temporaryDirectory("mcp-backup-script-");
    const docker = await createFakeDocker(directory);

    const missing = await runScript(backupScript, [], docker);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("usage:");

    const archive = join(directory, "already-exists.tar.gz");
    await writeFile(archive, "do not replace");
    const existing = await runScript(backupScript, [archive], docker);
    expect(existing.exitCode).not.toBe(0);
    expect(existing.stderr).toContain("already exists");
    expect(await readFile(archive, "utf8")).toBe("do not replace");
    expect(await Bun.file(docker.log).exists()).toBe(false);
  });

  test("backup refuses running or paused Compose service before mounting the named volume", async () => {
    for (const status of ["running", "paused"]) {
      const directory = await temporaryDirectory(`mcp-backup-${status}-`);
      const docker = await createFakeDocker(directory);
      const archive = join(directory, "backup.tar.gz");
      const result = await runScript(backupScript, [archive], docker, {
        MOCK_COMPOSE_STATUS: status,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("must be stopped");
      expect(await Bun.file(archive).exists()).toBe(false);
      expect(await readFile(docker.log, "utf8")).not.toContain("type=volume");
    }
  });

  test("backup mounts only the explicit named volume read-only and writes to the absolute parent", async () => {
    const directory = await temporaryDirectory("mcp-backup-success-");
    const docker = await createFakeDocker(directory);
    const archive = join(directory, "backup file.tar.gz");
    const result = await runScript(backupScript, [archive], docker, {
      MOCK_CREATE_ARCHIVE: archive,
    });

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(archive).exists()).toBe(true);
    const log = await readFile(docker.log, "utf8");
    expect(log).toContain("type=volume,src=mcp-knowledge-data,dst=/app/data,readonly");
    expect(log).toContain(`type=bind,src=${await realpath(dirname(archive))},dst=/backup`);
    expect(log).toContain("mcp-knowledge:local\ttar\t-C\t/app\t-czf\t/backup/backup file.tar.gz\tdata");
  });

  test("restore rejects missing, malformed, absolute, and parent-traversing archives before volume writes", async () => {
    const directory = await temporaryDirectory("mcp-restore-unsafe-");
    const docker = await createFakeDocker(directory);
    const missing = await runScript(restoreScript, [join(directory, "missing.tar.gz")], docker);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("does not exist");

    for (const unsafe of [
      { members: "data/\n/data/escape\n", message: "absolute" },
      { members: "data/\ndata/../escape\n", message: "parent traversal" },
    ]) {
      const archive = join(directory, `${unsafe.message.replace(" ", "-")}.tar.gz`);
      await writeFile(archive, "fixture contents are interpreted by fake Docker");
      const result = await runScript(restoreScript, [archive], docker, {
        MOCK_ARCHIVE_MEMBERS: unsafe.members,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(unsafe.message);
    }

    const malformedArchive = join(directory, "malformed.tar.gz");
    await writeFile(malformedArchive, "not a tarball");
    const malformed = await runScript(restoreScript, [malformedArchive], docker, {
      MOCK_ARCHIVE_VALID: "0",
    });
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain("valid gzip tar archive");

    const log = await readFile(docker.log, "utf8");
    expect(log).not.toContain("dst=/app/data\t");
  });

  test("restore refuses a non-empty volume before archive extraction", async () => {
    const directory = await temporaryDirectory("mcp-restore-nonempty-");
    const docker = await createFakeDocker(directory);
    const archive = join(directory, "backup.tar.gz");
    await writeFile(archive, "fixture contents are interpreted by fake Docker");
    const result = await runScript(restoreScript, [archive], docker, {
      MOCK_VOLUME_NONEMPTY: "1",
      MOCK_ARCHIVE_MEMBERS: "data/\ndata/knowledge.db\n",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("volume is not empty");
    const log = await readFile(docker.log, "utf8");
    expect(log).not.toContain("tar -xzf");
  });

  test("restore rejects archive links before mounting the named volume writable", async () => {
    const directory = await temporaryDirectory("mcp-restore-link-");
    const docker = await createFakeDocker(directory);
    const archive = join(directory, "link.tar.gz");
    await writeFile(archive, "fixture contents are interpreted by fake Docker");
    const result = await runScript(restoreScript, [archive], docker, {
      MOCK_ARCHIVE_MEMBERS: "data/\ndata/link\n",
      MOCK_ARCHIVE_TYPES: "d\nl\n",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("link or special file");
    const log = await readFile(docker.log, "utf8");
    expect(log).not.toContain("type=volume,src=mcp-knowledge-data,dst=/app/data\t");
  });

  test("restore validates before extracting into only the explicit named volume", async () => {
    const directory = await temporaryDirectory("mcp-restore-success-");
    const docker = await createFakeDocker(directory);
    const archive = join(directory, "backup file.tar.gz");
    await writeFile(archive, "fixture contents are interpreted by fake Docker");
    const result = await runScript(restoreScript, [archive], docker, {
      MOCK_ARCHIVE_MEMBERS: "data/\ndata/knowledge.db\ndata/documents/doc_1/original\n",
    });

    expect(result.exitCode).toBe(0);
    const log = await readFile(docker.log, "utf8");
    expect(log).toContain("type=volume,src=mcp-knowledge-data,dst=/app/data");
    expect(log).toContain(`type=bind,src=${await realpath(directory)},dst=/backup,readonly`);
    expect(log.indexOf("tar\t-tzf")).toBeLessThan(log.indexOf("tar -xzf"));
  });
});
