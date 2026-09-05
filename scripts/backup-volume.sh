#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly VOLUME_NAME="mcp-knowledge-data"
readonly IMAGE_NAME="mcp-knowledge:local"
readonly OPERATION_CONTAINER_NAME="mcp-knowledge-backup-$$"

backup_temp=""
backup_temp_dir=""

die() {
  printf 'volume backup: %s\n' "$*" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "required tool is unavailable: docker"
  docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
}

require_no_other_volume_consumers() {
  local owned_container_name="$1"
  local consumers
  consumers="$(docker ps --filter "volume=$VOLUME_NAME" --format '{{.Names}}')" ||
    die "could not inspect containers using named volume: $VOLUME_NAME"

  local consumer
  while IFS= read -r consumer; do
    [[ -z "$consumer" || "$consumer" == "$owned_container_name" ]] && continue
    die "named volume is in use by an active container: $VOLUME_NAME ($consumer)"
  done <<< "$consumers"
}

require_service_stopped() {
  require_no_other_volume_consumers "$OPERATION_CONTAINER_NAME"

  local running
  running="$(docker compose --project-directory "$REPOSITORY_ROOT" ps \
    --status running --status paused --status restarting --status removing --status dead \
    -q knowledge)" ||
    die "could not inspect the Compose service"
  [[ -z "$running" ]] || die "Compose service 'knowledge' must be stopped before backup"
}

cleanup() {
  { exec 3>&-; } 2>/dev/null || true
  if [[ -n "$backup_temp" && -e "$backup_temp" ]]; then
    rm -f -- "$backup_temp"
  fi
  if [[ -n "$backup_temp_dir" && -d "$backup_temp_dir" ]]; then
    rmdir "$backup_temp_dir" 2>/dev/null || true
  fi
}

trap cleanup EXIT

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

  backup_temp_dir="$(mktemp -d "$archive_parent/.mcp-knowledge-backup.XXXXXX")" ||
    die "could not create private temporary directory"
  chmod 0700 "$backup_temp_dir" || die "could not secure private temporary directory"
  backup_temp="$backup_temp_dir/archive.tar.gz"
  set -o noclobber
  if ! exec 3> "$backup_temp"; then
    die "could not open private temporary archive"
  fi
  set +o noclobber
  chmod 0600 "$backup_temp" || die "could not secure private temporary archive"

  require_no_other_volume_consumers "$OPERATION_CONTAINER_NAME"
  docker run --rm --name "$OPERATION_CONTAINER_NAME" --network none \
    --mount "type=volume,src=$VOLUME_NAME,dst=/app/data,readonly" \
    "$IMAGE_NAME" tar -C /app -czf - data >&3 || die "backup failed"
  require_no_other_volume_consumers "$OPERATION_CONTAINER_NAME"
  exec 3>&-

  [[ -s "$backup_temp" ]] || die "backup command did not create a non-empty archive"
  chmod 0600 "$backup_temp" || die "could not secure backup archive"
  ln "$backup_temp" "$archive_path" 2>/dev/null ||
    die "archive destination appeared while backup was running: $archive_path"
  rm -f -- "$backup_temp"
  rmdir "$backup_temp_dir"
  backup_temp=""
  backup_temp_dir=""
  printf 'Backed up %s to %s\n' "$VOLUME_NAME" "$archive_path"
}

main "$@"
