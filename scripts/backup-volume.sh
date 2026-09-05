#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly VOLUME_NAME="mcp-knowledge-data"
readonly IMAGE_NAME="mcp-knowledge:local"

die() {
  printf 'volume backup: %s\n' "$*" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "required tool is unavailable: docker"
  docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
}

require_service_stopped() {
  local running
  running="$(docker compose --project-directory "$REPOSITORY_ROOT" ps \
    --status running --status paused --status restarting --status removing --status dead \
    -q knowledge)" ||
    die "could not inspect the Compose service"
  [[ -z "$running" ]] || die "Compose service 'knowledge' must be stopped before backup"
}

main() {
  [[ "$#" -eq 1 ]] || die "usage: $0 ARCHIVE_PATH"

  local requested_archive="$1"
  [[ -n "$requested_archive" ]] || die "ARCHIVE_PATH must not be empty"
  [[ ! -e "$requested_archive" && ! -L "$requested_archive" ]] ||
    die "archive destination already exists: $requested_archive"

  local archive_parent
  local archive_name
  archive_parent="$(cd "$(dirname "$requested_archive")" 2>/dev/null && pwd -P)" ||
    die "archive parent directory does not exist: $(dirname "$requested_archive")"
  archive_name="$(basename "$requested_archive")"
  [[ "$archive_parent" != *','* ]] ||
    die "archive parent path cannot contain a comma because Docker --mount cannot represent it safely"

  local archive_path="$archive_parent/$archive_name"
  [[ ! -e "$archive_path" && ! -L "$archive_path" ]] ||
    die "archive destination already exists: $archive_path"

  require_docker
  require_service_stopped
  docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 ||
    die "named volume does not exist: $VOLUME_NAME"
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 ||
    die "required app image does not exist: $IMAGE_NAME"

  docker run --rm --network none \
    --mount "type=volume,src=$VOLUME_NAME,dst=/app/data,readonly" \
    --mount "type=bind,src=$archive_parent,dst=/backup" \
    "$IMAGE_NAME" tar -C /app -czf "/backup/$archive_name" data ||
    die "backup failed"

  [[ -s "$archive_path" ]] || die "backup command did not create a non-empty archive"
  printf 'Backed up %s to %s\n' "$VOLUME_NAME" "$archive_path"
}

main "$@"
