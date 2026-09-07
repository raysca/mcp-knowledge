# Container release

`mcp-knowledge` is released as a single multi-platform OCI image for
`linux/amd64` and `linux/arm64`. The release scripts are registry-neutral: log
in to the registry selected for a release before invoking them. For example,
use the registry's supported `docker login` flow (GitHub Container Registry
users can follow [GitHub's container publishing guide](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)).

## Prerequisites

- Docker Engine or Docker Desktop with a running daemon and Docker Buildx.
- Bun, to execute the in-image release smoke harness.
- A Buildx builder capable of building `linux/amd64` and `linux/arm64`.
  On a non-native host, `scripts/release/test-platforms.sh` configures the
  required binfmt/QEMU handler with `tonistiigi/binfmt`; the Docker daemon must
  permit privileged containers for this step.
- Registry credentials already authenticated outside these scripts for a
  publication run.

See [Docker's multi-platform build documentation](https://docs.docker.com/build/building/multi-platform/)
for builder and emulation setup details.

## Platform test contract

Run the no-argument platform gate from the repository root:

```sh
bun run release:test-platforms
```

The command builds a disposable image separately for `linux/amd64` and
`linux/arm64` with Buildx and loads each into the local Docker daemon. For each
image it:

1. starts a container with a randomly assigned loopback-only host port;
2. resolves the assigned port with `docker port`, waits for Docker health, and
   runs `scripts/release/smoke.ts` against it; then
3. starts a fresh container with `--network none` and no published port, waits
   for health, and runs that same smoke harness through `docker exec` against
   `127.0.0.1:3000` inside the container.

The smoke suite uploads and retrieves Markdown, plain text, HTML, PDF, and
DOCX fixtures, and verifies HTTP search plus MCP. Consequently a PDF or DOCX
native-parser failure fails that platform. Set `MCP_API_KEY` before the command
to exercise an authenticated image; it is passed only to the disposable
containers and harness.

All temporary Docker resource names begin with `mcp-knowledge-release-` and
are removed by the script's exit trap. Do not interrupt cleanup by deleting
similarly named resources in another terminal during a test run.

## Publish contract and tags

Publication is an explicit side effect; the platform test never pushes an
image. After all ordinary release gates pass, create an annotated tag at the
release commit and invoke:

```sh
scripts/release/publish.sh IMAGE_REF VERSION
```

`IMAGE_REF` is a fully qualified repository chosen by the releaser, such as
`ghcr.io/example/mcp-knowledge`; `VERSION` is a Semantic Version without a
leading `v`, such as `0.1.0`. The script refuses a dirty work tree, a missing or
lightweight `vVERSION` tag, and a tag not pointing to `HEAD`. It reruns both
platform smoke tests before pushing a manifest tagged as both `IMAGE_REF:VERSION`
and `IMAGE_REF:0.1`.

No `latest` tag is published during the 0.x series. The stable `0.1` tag is the
v0.1 compatibility track; change that policy deliberately with the next major
release rather than relying on `latest`.

The Dockerfile records the Git commit and release version in the standard OCI
labels `org.opencontainers.image.revision` and
`org.opencontainers.image.version` through Buildx build arguments.

After pushing, the script runs and parses:

```sh
docker buildx imagetools inspect IMAGE_REF:VERSION
```

It fails unless the resulting manifest lists both `linux/amd64` and
`linux/arm64`. You can rerun that command independently when auditing a
published release.
