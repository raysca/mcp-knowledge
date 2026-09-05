#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly RUN_ID="$$"
readonly HEALTH_TIMEOUT_SECONDS=120

container_name=""
offline_container_name=""
binfmt_container_name=""
image_tag=""

die() {
  printf 'release platform test: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$container_name" ]]; then
    docker rm -f "$container_name" >/dev/null 2>&1 || true
  fi
  if [[ -n "$offline_container_name" ]]; then
    docker rm -f "$offline_container_name" >/dev/null 2>&1 || true
  fi
  if [[ -n "$binfmt_container_name" ]]; then
    docker rm -f "$binfmt_container_name" >/dev/null 2>&1 || true
  fi
  if [[ -n "$image_tag" ]]; then
    docker image rm -f "$image_tag" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool is unavailable: $1"
}

require_docker() {
  require_tool docker
  require_tool bun
  docker buildx version >/dev/null 2>&1 || die "Docker Buildx is required"
  docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
}

host_architecture() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'amd64\n' ;;
    aarch64 | arm64) printf 'arm64\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

ensure_emulation() {
  local platform="$1"
  local target_arch="${platform#linux/}"
  if [[ "$(host_architecture)" == "$target_arch" ]]; then
    return
  fi

  binfmt_container_name="mcp-knowledge-release-binfmt-${target_arch}-${RUN_ID}"
  printf 'Configuring binfmt/QEMU for %s...\n' "$platform"
  docker run --privileged --rm --name "$binfmt_container_name" tonistiigi/binfmt --install "$target_arch" >/dev/null ||
    die "could not configure binfmt/QEMU for $platform"
  binfmt_container_name=""
}

wait_for_health() {
  local target_container="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local status

  while (( SECONDS < deadline )); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$target_container")" ||
      die "container exited before reporting health: $target_container"
    case "$status" in
      healthy) return ;;
      unhealthy) die "container health check failed: $target_container" ;;
      starting) sleep 1 ;;
      missing) die "container has no Docker health check: $target_container" ;;
      *) die "unexpected container health state '$status': $target_container" ;;
    esac
  done

  die "timed out waiting for container health: $target_container"
}

loopback_port() {
  local target_container="$1"
  local mapping
  local port

  mapping="$(docker port "$target_container" 3000/tcp)" || die "container port 3000/tcp is not published"
  [[ "$mapping" == 127.0.0.1:* ]] || die "container port is not loopback-only: $mapping"
  port="${mapping##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || die "could not parse loopback port from: $mapping"
  printf '%s\n' "$port"
}

run_container() {
  local name="$1"
  shift

  if [[ -n "${MCP_API_KEY:-}" ]]; then
    docker run -d --name "$name" -e MCP_API_KEY "$@"
  else
    docker run -d --name "$name" "$@"
  fi
}

run_platform() {
  local platform="$1"
  local platform_id="${platform//\//-}"
  local port
  local base_url

  image_tag="mcp-knowledge-release-${platform_id}-${RUN_ID}:test"
  container_name="mcp-knowledge-release-${platform_id}-online-${RUN_ID}"
  offline_container_name="mcp-knowledge-release-${platform_id}-offline-${RUN_ID}"

  ensure_emulation "$platform"
  printf 'Building %s...\n' "$platform"
  docker buildx build --platform "$platform" --load \
    --build-arg "VCS_REF=$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)" \
    --build-arg 'VERSION=platform-test' \
    --tag "$image_tag" \
    "$REPOSITORY_ROOT"

  printf 'Running published-loopback smoke check for %s...\n' "$platform"
  run_container "$container_name" -p 127.0.0.1::3000 "$image_tag" >/dev/null
  port="$(loopback_port "$container_name")"
  base_url="http://127.0.0.1:${port}"
  wait_for_health "$container_name"
  BASE_URL="$base_url" MCP_API_KEY="${MCP_API_KEY:-}" bun "$SCRIPT_DIR/smoke.ts"
  docker rm -f "$container_name" >/dev/null
  container_name=""

  printf 'Running offline smoke check for %s...\n' "$platform"
  run_container "$offline_container_name" --network none "$image_tag" >/dev/null
  wait_for_health "$offline_container_name"
  docker exec "$offline_container_name" sh -c 'BASE_URL=http://127.0.0.1:3000 bun scripts/release/smoke.ts'
  docker rm -f "$offline_container_name" >/dev/null
  offline_container_name=""
  docker image rm -f "$image_tag" >/dev/null
  image_tag=""
}

main() {
  [[ "$#" -eq 0 ]] || die "usage: $0"
  require_docker
  require_tool git
  git -C "$REPOSITORY_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "repository root is not a Git work tree"

  run_platform linux/amd64
  run_platform linux/arm64
  printf 'Platform smoke checks passed for linux/amd64 and linux/arm64.\n'
}

main "$@"
