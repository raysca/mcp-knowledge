#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly VOLUME_NAME="mcp-knowledge-data"
readonly IMAGE_NAME="mcp-knowledge:local"

die() {
  printf 'volume restore: %s\n' "$*" >&2
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
  [[ -z "$running" ]] || die "Compose service 'knowledge' must be stopped before restore"
}

validate_member() {
  local member="$1"
  [[ -n "$member" ]] || die "archive contains an empty member name"
  [[ "$member" != /* ]] || die "archive contains an absolute member: $member"
  [[ "$member" != *'\'* ]] || die "archive contains an escaped or control-character member"
  [[ "$member" == "data" || "$member" == data/* ]] ||
    die "archive contains a member outside data/: $member"

  local component
  local -a components=()
  IFS='/' read -r -a components <<< "$member"
  for component in "${components[@]}"; do
    [[ "$component" != ".." ]] || die "archive contains parent traversal: $member"
  done
}

main() {
  [[ "$#" -eq 1 ]] || die "usage: $0 ARCHIVE_PATH"

  local requested_archive="$1"
  [[ -f "$requested_archive" ]] || die "archive does not exist or is not a regular file: $requested_archive"

  local archive_parent
  local archive_name
  archive_parent="$(cd "$(dirname "$requested_archive")" 2>/dev/null && pwd -P)" ||
    die "archive parent directory does not exist: $(dirname "$requested_archive")"
  archive_name="$(basename "$requested_archive")"
  [[ "$archive_parent" != *','* ]] ||
    die "archive parent path cannot contain a comma because Docker --mount cannot represent it safely"

  require_docker
  require_service_stopped
  docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 ||
    die "named volume does not exist: $VOLUME_NAME"
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 ||
    die "required app image does not exist: $IMAGE_NAME"

  local members
  members="$(
    docker run --rm --network none \
      --mount "type=bind,src=$archive_parent,dst=/backup,readonly" \
      "$IMAGE_NAME" tar -tzf "/backup/$archive_name" -P --quoting-style=escape
  )" || die "archive is not a valid gzip tar archive"
  [[ -n "$members" ]] || die "archive is empty"

  local member
  while IFS= read -r member || [[ -n "$member" ]]; do
    validate_member "$member"
  done <<< "$members"

  local member_metadata
  member_metadata="$(
    docker run --rm --network none \
      --mount "type=bind,src=$archive_parent,dst=/backup,readonly" \
      "$IMAGE_NAME" tar -tvzf "/backup/$archive_name" -P --quoting-style=escape
  )" || die "archive metadata could not be validated"
  [[ -n "$member_metadata" ]] || die "archive metadata is empty"
  local metadata_line
  local member_type
  while IFS= read -r metadata_line || [[ -n "$metadata_line" ]]; do
    member_type="${metadata_line:0:1}"
    case "$member_type" in
      - | d) ;;
      *) die "archive contains a link or special file" ;;
    esac
  done <<< "$member_metadata"

  local existing
  existing="$(
    docker run --rm --network none \
      --mount "type=volume,src=$VOLUME_NAME,dst=/app/data,readonly" \
      "$IMAGE_NAME" sh -ceu 'find /app/data -mindepth 1 -print -quit'
  )" || die "could not inspect named volume: $VOLUME_NAME"
  [[ -z "$existing" ]] || die "named volume is not empty: $VOLUME_NAME"

  docker run --rm --network none \
    --mount "type=volume,src=$VOLUME_NAME,dst=/app/data" \
    --mount "type=bind,src=$archive_parent,dst=/backup,readonly" \
    "$IMAGE_NAME" sh -ceu '
      target=/app/data
      [ -z "$(find "$target" -mindepth 1 -print -quit)" ] || {
        printf "restore target became non-empty before extraction\n" >&2
        exit 1
      }
      stage="$(mktemp -d)"
      trap '\''rm -rf "$stage"'\'' EXIT
      tar -xzf "$1" -C "$stage"
      [ -d "$stage/data" ] || {
        printf "archive is missing data/\n" >&2
        exit 1
      }
      [ -z "$(find "$stage" -mindepth 1 -maxdepth 1 ! -name data -print -quit)" ] || {
        printf "archive contains content outside data/\n" >&2
        exit 1
      }
      [ -z "$(find "$stage/data" ! -type d ! -type f -print -quit)" ] || {
        printf "archive contains a link or special file\n" >&2
        exit 1
      }
      [ -z "$(find "$target" -mindepth 1 -print -quit)" ] || {
        printf "restore target became non-empty before copy\n" >&2
        exit 1
      }
      cp -a "$stage/data/." "$target/"
    ' restore "/backup/$archive_name" || die "restore failed"

  printf 'Restored %s from %s\n' "$VOLUME_NAME" "$archive_parent/$archive_name"
}

main "$@"
