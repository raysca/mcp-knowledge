import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");
const platformScript = join(repositoryRoot, "scripts/release/test-platforms.sh");
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-release-platforms-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeExecutable(path: string, contents: string) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function createFakeCommands(directory: string) {
  const bin = join(directory, "bin");
  const log = join(directory, "docker.log");
  await mkdir(bin);

  await writeExecutable(
    join(bin, "docker"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_LOG:?}"
case "$1" in
  buildx | info | run | rm | exec) exit 0 ;;
  image) exit 0 ;;
  inspect) printf 'healthy\\n' ;;
  port) printf '127.0.0.1:34567\\n' ;;
  *) exit 1 ;;
esac
`,
  );
  await writeExecutable(join(bin, "bun"), "#!/bin/sh\nexit 0\n");
  await writeExecutable(join(bin, "git"), "#!/bin/sh\nprintf 'test-ref\\n'\n");
  await writeExecutable(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  await writeExecutable(join(bin, "uname"), "#!/bin/sh\nprintf 'x86_64\\n'\n");
  return { bin, log };
}

describe("release platform gate", () => {
  test("runs both online and offline containers without MCP_API_KEY on Bash 3.2", async () => {
    const directory = await temporaryDirectory();
    const fake = await createFakeCommands(directory);
    const environment = { ...Bun.env };
    delete environment.MCP_API_KEY;

    const process = Bun.spawn(["bash", platformScript], {
      cwd: repositoryRoot,
      env: {
        ...environment,
        PATH: `${fake.bin}:${Bun.env.PATH ?? ""}`,
        FAKE_DOCKER_LOG: fake.log,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });

    const dockerCommands = (await readFile(fake.log, "utf8")).trim().split("\n");
    const runs = dockerCommands.filter((command) => command.startsWith("run "));
    expect(runs.filter((command) => command.includes("-p 127.0.0.1::3000"))).toHaveLength(2);
    expect(runs.filter((command) => command.includes("--network none"))).toHaveLength(2);
    expect(runs.some((command) => command.includes("-e MCP_API_KEY"))).toBe(false);
  });
});

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});
