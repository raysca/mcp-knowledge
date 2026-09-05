import { afterAll, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

async function createFakeDocker(directory: string): Promise<{ bin: string; log: string; state: string }> {
  const bin = join(directory, "bin");
  const log = join(directory, "docker.log");
  const state = join(directory, "docker-state");
  await mkdir(bin);
  await mkdir(state);
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env bash
set -euo pipefail
state="$MOCK_DOCKER_STATE"
mkdir -p "$state"
{
  printf 'CALL'
  for argument in "$@"; do printf '\\t%s' "$argument"; done
  printf '\\n'
} >> "$MOCK_DOCKER_LOG"

if [[ "\${1:-}" == "info" || "\${1:-} \${2:-}" == "volume inspect" || "\${1:-} \${2:-}" == "image inspect" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "ps" ]]; then
  [[ -n "\${MOCK_VOLUME_CONSUMER:-}" ]] && printf '%s\\n' "$MOCK_VOLUME_CONSUMER"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  active_status="\${MOCK_COMPOSE_STATUS:-}"
  [[ "\${MOCK_COMPOSE_RUNNING:-0}" == "1" ]] && active_status=running
  [[ -n "$active_status" && " $* " == *" --status $active_status "* ]] && printf 'container-id\\n'
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "volume create" ]]; then
  rm -rf "$state/stage"
  mkdir -p "$state/stage"
  printf '%s\\n' "\${MOCK_STAGE_VOLUME:-mcp-knowledge-restore-stage-test}"
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "volume rm" ]]; then
  printf '%s' "\${3:-}" > "$state/removed-stage-volume"
  [[ "\${MOCK_STAGE_REMOVE_FAIL:-0}" == "0" ]] || exit 2
  exit 0
fi

if [[ "\${1:-}" != "run" ]]; then
  exit 0
fi

if [[ " $* " == *" tar -C /app -czf - data "* ]]; then
  if [[ -n "\${MOCK_PRIVATE_TEMP_PARENT:-}" ]]; then
    temporary="$(find "$MOCK_PRIVATE_TEMP_PARENT" -mindepth 1 -maxdepth 1 -name '.mcp-knowledge-backup.*' -print -quit)"
    if [[ -d "$temporary" ]]; then
      temporary_file="$(find "$temporary" -mindepth 1 -maxdepth 1 -type f -print -quit)"
      if stat -c '%a' "$temporary" >/dev/null 2>&1; then
        directory_mode="$(stat -c '%a' "$temporary")"
        file_mode="$(stat -c '%a' "$temporary_file")"
      else
        directory_mode="$(stat -f '%Lp' "$temporary")"
        file_mode="$(stat -f '%Lp' "$temporary_file")"
      fi
      printf '%s %s' "$directory_mode" "$file_mode" > "$state/private-temp-modes"
    else
      printf 'not-private-directory' > "$state/private-temp-modes"
    fi
  fi
  if [[ -n "\${MOCK_RACE_ARCHIVE:-}" ]]; then
    printf 'concurrent destination' > "$MOCK_RACE_ARCHIVE"
  fi
  printf 'mock archive bytes'
  exit 0
fi

if [[ " $* " == *"dst=/restore-stage"* && " $* " == *" -i "* ]]; then
  cat > "$state/stage/archive.tar.gz"
  if [[ "\${MOCK_REPLACE_ARCHIVE_AFTER_SNAPSHOT:-0}" == "1" ]]; then
    printf 'replacement archive bytes' > "$MOCK_ARCHIVE_PATH"
  fi
  [[ "\${MOCK_ARCHIVE_VALID:-1}" == "1" ]] || {
    printf 'archive is not a valid gzip tar archive\\n' >&2
    exit 2
  }
  members="\${MOCK_ARCHIVE_MEMBERS:-data/}"
  [[ "$members" != *$'\\n/data/'* ]] || {
    printf 'archive contains an absolute member\\n' >&2
    exit 2
  }
  [[ "$members" != *'/../'* ]] || {
    printf 'archive contains parent traversal\\n' >&2
    exit 2
  }
  [[ "\${MOCK_ARCHIVE_TYPES:--}" != *l* ]] || {
    printf 'archive contains a link or special file\\n' >&2
    exit 2
  }
  mkdir -p "$state/stage/extracted/data/documents/doc_1"
  if [[ "\${MOCK_USE_REAL_ARCHIVE:-0}" == "1" ]]; then
    rm -rf "$state/stage/extracted"
    mkdir -p "$state/stage/extracted"
    tar -xzf "$state/stage/archive.tar.gz" -C "$state/stage/extracted"
  else
    printf 'staged database' > "$state/stage/extracted/data/knowledge.db"
    printf 'staged original' > "$state/stage/extracted/data/documents/doc_1/original"
  fi
  touch "$state/staged"
  exit 0
fi

if [[ " $* " == *"dst=/app/data,readonly"* ]]; then
  if [[ "\${MOCK_VOLUME_NONEMPTY:-0}" == "1" ]] ||
    find "$state/target" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
    printf 'existing-entry\\n'
  fi
  exit 0
fi

if [[ " $* " == *"src=mcp-knowledge-restore-stage-test,dst=/restore-stage,readonly"* &&
      " $* " == *"src=mcp-knowledge-data,dst=/app/data"* ]]; then
  [[ -f "$state/staged" ]] || {
    printf 'staging was not completed before target write\\n' >&2
    exit 2
  }
  mkdir -p "$state/target"
  args=("$@")
  command_text=""
  for ((index = 0; index < \${#args[@]}; index += 1)); do
    if [[ "\${args[index]}" == "sh" && "\${args[index + 1]:-}" == "-ceu" ]]; then
      command_text="\${args[index + 2]}"
      break
    fi
  done
  [[ -n "$command_text" ]] || exit 2
  command_text="\${command_text//\\/restore-stage/$state/stage}"
  command_text="\${command_text//\\/app\\/data/$state/target}"
  export MOCK_TARGET_ROOT="$state/target"
  injection=''
  if [[ "\${MOCK_TARGET_COLLISION:-0}" == "1" ]]; then
    injection+='mv() { if [[ -n "\${MOCK_INJECT_COLLISION:-1}" ]]; then printf "concurrent value" > "$MOCK_TARGET_ROOT/knowledge.db"; unset MOCK_INJECT_COLLISION; fi; command mv "$@"; }'
    injection+=$'\\n'
  fi
  if [[ "\${MOCK_TARGET_EXTRA:-0}" == "1" ]]; then
    injection+='rmdir() { command rmdir "$@"; printf "concurrent extra" > "$MOCK_TARGET_ROOT/concurrent-extra"; }'
    injection+=$'\\n'
  fi
  bash -ceu "$injection$command_text"
  exit $?
fi

exit 0
`,
  );
  await chmod(docker, 0o755);
  return { bin, log, state };
}

async function runScript(
  script: string,
  args: string[],
  input: { bin: string; log: string; state: string },
  extraEnv: Record<string, string> = {},
) {
  const process = Bun.spawn(["bash", script, ...args], {
    cwd: repositoryRoot,
    env: {
      ...Bun.env,
      PATH: `${input.bin}:${Bun.env.PATH ?? ""}`,
      MOCK_DOCKER_LOG: input.log,
      MOCK_DOCKER_STATE: input.state,
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

async function createArchiveFixture(directory: string, contents: string): Promise<string> {
  const fixtureRoot = join(directory, "fixture");
  const data = join(fixtureRoot, "data");
  const archive = join(directory, "backup.tar.gz");
  await mkdir(join(data, "documents"), { recursive: true });
  await writeFile(join(data, "knowledge.db"), contents);
  const process = Bun.spawn(["tar", "-czf", archive, "-C", fixtureRoot, "data"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(await new Response(process.stderr).text());
  return archive;
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

  test("backup streams from only the explicit named volume and publishes a private archive", async () => {
    const directory = await temporaryDirectory("mcp-backup-success-");
    const docker = await createFakeDocker(directory);
    const archive = join(directory, "backup file.tar.gz");
    const result = await runScript(backupScript, [archive], docker, {
      MOCK_PRIVATE_TEMP_PARENT: directory,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(archive, "utf8")).toBe("mock archive bytes");
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(docker.state, "private-temp-modes"), "utf8")).toBe("700 600");
    const log = await readFile(docker.log, "utf8");
    expect(log).toContain("type=volume,src=mcp-knowledge-data,dst=/app/data,readonly");
    expect(log).not.toContain("type=bind");
    expect(log).toContain("mcp-knowledge:local\ttar\t-C\t/app\t-czf\t-\tdata");
  });

  test("backup atomically refuses a destination created after its initial preflight", async () => {
    const directory = await temporaryDirectory("mcp-backup-publish-race-");
    const docker = await createFakeDocker(directory);
    const archive = join(directory, "backup.tar.gz");
    const result = await runScript(backupScript, [archive], docker, {
      MOCK_RACE_ARCHIVE: archive,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("appeared while backup was running");
    expect(await readFile(archive, "utf8")).toBe("concurrent destination");
    const remaining = Array.from(new Bun.Glob(".mcp-knowledge-backup.*").scanSync(directory));
    expect(remaining).toHaveLength(0);
  });

  test("backup and restore reject a direct container consuming the named volume", async () => {
    for (const script of [backupScript, restoreScript]) {
      const directory = await temporaryDirectory("mcp-volume-consumer-");
      const docker = await createFakeDocker(directory);
      const archive = join(directory, "backup.tar.gz");
      if (script === restoreScript) await writeFile(archive, "archive fixture");
      const result = await runScript(script, [archive], docker, {
        MOCK_VOLUME_CONSUMER: "direct-container-id",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("volume is in use");
      const log = await readFile(docker.log, "utf8");
      expect(log).toContain("CALL\tps\t-q\t--filter\tvolume=mcp-knowledge-data");
      expect(log).not.toContain("CALL\trun");
    }
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
    expect(log).not.toContain("src=mcp-knowledge-data,dst=/app/data\t");
    expect(await readFile(join(docker.state, "removed-stage-volume"), "utf8")).toBe(
      "mcp-knowledge-restore-stage-test",
    );
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
    expect(log).not.toContain("src=mcp-knowledge-data,dst=/app/data\t");
    expect(await Bun.file(join(docker.state, "staged")).exists()).toBe(true);
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

  test("restore snapshots and validates in a private staging volume before target write", async () => {
    const directory = await temporaryDirectory("mcp-restore-success-");
    const docker = await createFakeDocker(directory);
    const archive = join(directory, "backup file.tar.gz");
    await writeFile(archive, "fixture contents are interpreted by fake Docker");
    const result = await runScript(restoreScript, [archive], docker, {
      MOCK_ARCHIVE_MEMBERS: "data/\ndata/knowledge.db\ndata/documents/doc_1/original\n",
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(docker.state, "target/knowledge.db"), "utf8")).toBe(
      "staged database",
    );
    expect(await readFile(join(docker.state, "removed-stage-volume"), "utf8")).toBe(
      "mcp-knowledge-restore-stage-test",
    );
    const log = await readFile(docker.log, "utf8");
    const stageWrite = log.indexOf("src=mcp-knowledge-restore-stage-test,dst=/restore-stage");
    const targetWrite = log.indexOf("src=mcp-knowledge-data,dst=/app/data");
    expect(stageWrite).toBeGreaterThanOrEqual(0);
    expect(targetWrite).toBeGreaterThan(stageWrite);
    expect(log).toContain("src=mcp-knowledge-restore-stage-test,dst=/restore-stage,readonly");
    expect(log).not.toContain("type=bind");
  });

  test("restore never cleans up the target if Docker returns it as the staging name", async () => {
    const directory = await temporaryDirectory("mcp-restore-stage-name-");
    const docker = await createFakeDocker(directory);
    const archive = join(directory, "backup.tar.gz");
    await writeFile(archive, "archive fixture");
    const result = await runScript(restoreScript, [archive], docker, {
      MOCK_STAGE_VOLUME: "mcp-knowledge-data",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("target as the staging volume");
    expect(await Bun.file(join(docker.state, "removed-stage-volume")).exists()).toBe(false);
  });

  test("restore fails closed when its exact private staging volume cannot be removed", async () => {
    const directory = await temporaryDirectory("mcp-restore-stage-cleanup-");
    const docker = await createFakeDocker(directory);
    const archive = join(directory, "backup.tar.gz");
    await writeFile(archive, "archive fixture");
    const result = await runScript(restoreScript, [archive], docker, {
      MOCK_STAGE_REMOVE_FAIL: "1",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not remove private staging volume");
    expect(await readFile(join(docker.state, "removed-stage-volume"), "utf8")).toBe(
      "mcp-knowledge-restore-stage-test",
    );
  });

  test("restore uses the snapshotted bytes even if the host archive path is replaced", async () => {
    const directory = await temporaryDirectory("mcp-restore-snapshot-");
    const docker = await createFakeDocker(directory);
    const archive = await createArchiveFixture(directory, "immutable original database");
    const originalArchive = await readFile(archive);
    const result = await runScript(restoreScript, [archive], docker, {
      MOCK_USE_REAL_ARCHIVE: "1",
      MOCK_REPLACE_ARCHIVE_AFTER_SNAPSHOT: "1",
      MOCK_ARCHIVE_PATH: archive,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(docker.state, "stage/archive.tar.gz"))).toEqual(originalArchive);
    expect(await readFile(archive, "utf8")).toBe("replacement archive bytes");
    expect(await readFile(join(docker.state, "target/knowledge.db"), "utf8")).toBe(
      "immutable original database",
    );
  });

  test("restore never overwrites a concurrent collision and detects concurrent extra entries", async () => {
    for (const scenario of ["collision", "extra"] as const) {
      const directory = await temporaryDirectory(`mcp-restore-${scenario}-`);
      const docker = await createFakeDocker(directory);
      const archive = join(directory, "backup.tar.gz");
      await writeFile(archive, "archive fixture");
      const result = await runScript(restoreScript, [archive], docker, {
        MOCK_ARCHIVE_MEMBERS: "data/\ndata/knowledge.db\n",
        ...(scenario === "collision"
          ? { MOCK_TARGET_COLLISION: "1" }
          : { MOCK_TARGET_EXTRA: "1" }),
      });

      expect(result.exitCode).not.toBe(0);
      if (scenario === "collision") {
        expect(await readFile(join(docker.state, "target/knowledge.db"), "utf8")).toBe(
          "concurrent value",
        );
      } else {
        expect(result.stderr).toContain("post-copy validation failed");
        expect(await readFile(join(docker.state, "target/concurrent-extra"), "utf8")).toBe(
          "concurrent extra",
        );
      }
    }
  });
});
