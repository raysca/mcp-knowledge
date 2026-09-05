#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly VOLUME_NAME="mcp-knowledge-data"
readonly IMAGE_NAME="mcp-knowledge:local"

staging_volume=""

die() {
  printf 'volume restore: %s\n' "$*" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "required tool is unavailable: docker"
  docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
}

require_service_stopped() {
  local consumers
  consumers="$(docker ps -q --filter "volume=$VOLUME_NAME")" ||
    die "could not inspect containers using named volume: $VOLUME_NAME"
  [[ -z "$consumers" ]] || die "named volume is in use by an active container: $VOLUME_NAME"

  local running
  running="$(docker compose --project-directory "$REPOSITORY_ROOT" ps \
    --status running --status paused --status restarting --status removing --status dead \
    -q knowledge)" ||
    die "could not inspect the Compose service"
  [[ -z "$running" ]] || die "Compose service 'knowledge' must be stopped before restore"
}

cleanup() {
  local status="$?"
  trap - EXIT
  if [[ -n "$staging_volume" ]]; then
    if ! docker volume rm "$staging_volume" >/dev/null 2>&1; then
      printf 'volume restore: could not remove private staging volume: %s\n' "$staging_volume" >&2
      status=1
    fi
  fi
  exit "$status"
}

trap cleanup EXIT

main() {
  [[ "$#" -eq 1 ]] || die "usage: $0 ARCHIVE_PATH"

  local requested_archive="$1"
  [[ -f "$requested_archive" ]] || die "archive does not exist or is not a regular file: $requested_archive"

  local archive_parent
  local archive_name
  archive_parent="$(cd "$(dirname "$requested_archive")" 2>/dev/null && pwd -P)" ||
    die "archive parent directory does not exist: $(dirname "$requested_archive")"
  archive_name="$(basename "$requested_archive")"
  local archive_path="$archive_parent/$archive_name"

  require_docker
  require_service_stopped
  docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 ||
    die "named volume does not exist: $VOLUME_NAME"
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 ||
    die "required app image does not exist: $IMAGE_NAME"

  local created_staging_volume
  created_staging_volume="$(docker volume create --label com.mcp-knowledge.restore-stage=true)" ||
    die "could not create private staging volume"
  [[ "$created_staging_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]] ||
    die "Docker returned an unsafe staging volume name"
  [[ "$created_staging_volume" != "$VOLUME_NAME" ]] ||
    die "Docker returned the target as the staging volume"
  staging_volume="$created_staging_volume"

  docker run --rm --network none -i \
    --mount "type=volume,src=$staging_volume,dst=/restore-stage" \
    "$IMAGE_NAME" sh -ceu '
      umask 077
      archive=/restore-stage/archive.tar.gz
      extracted=/restore-stage/extracted
      members=/tmp/archive-members
      metadata=/tmp/archive-metadata

      cat > "$archive"
      chmod 0400 "$archive"
      mkdir -m 0700 "$extracted"

      tar -tzf "$archive" -P --quoting-style=escape > "$members" || {
        printf "archive is not a valid gzip tar archive\n" >&2
        exit 1
      }
      [ -s "$members" ] || {
        printf "archive is empty\n" >&2
        exit 1
      }
      while IFS= read -r member || [ -n "$member" ]; do
        [ -n "$member" ] || {
          printf "archive contains an empty member name\n" >&2
          exit 1
        }
        case "$member" in
          /*)
            printf "archive contains an absolute member: %s\n" "$member" >&2
            exit 1
            ;;
          *\\*)
            printf "archive contains an escaped or control-character member\n" >&2
            exit 1
            ;;
          data | data/*) ;;
          *)
            printf "archive contains a member outside data/: %s\n" "$member" >&2
            exit 1
            ;;
        esac
        case "/$member/" in
          */../*)
            printf "archive contains parent traversal: %s\n" "$member" >&2
            exit 1
            ;;
        esac
      done < "$members"

      tar -tvzf "$archive" -P --quoting-style=escape > "$metadata" || {
        printf "archive metadata could not be validated\n" >&2
        exit 1
      }
      while IFS= read -r metadata_line || [ -n "$metadata_line" ]; do
        member_type="$(printf %.1s "$metadata_line")"
        case "$member_type" in
          - | d) ;;
          *)
            printf "archive contains a link or special file\n" >&2
            exit 1
            ;;
        esac
      done < "$metadata"

      tar -xzf "$archive" -C "$extracted" || {
        printf "archive extraction failed\n" >&2
        exit 1
      }
      [ -d "$extracted/data" ] || {
        printf "archive is missing data/\n" >&2
        exit 1
      }
      [ -z "$(find "$extracted" -mindepth 1 -maxdepth 1 ! -name data -print -quit)" ] || {
        printf "archive contains content outside data/\n" >&2
        exit 1
      }
      [ -z "$(find "$extracted/data" ! -type d ! -type f -print -quit)" ] || {
        printf "archive contains a link or special file\n" >&2
        exit 1
      }
    ' < "$archive_path" || die "archive validation and staging failed"

  require_service_stopped
  local existing
  existing="$(
    docker run --rm --network none \
      --mount "type=volume,src=$VOLUME_NAME,dst=/app/data,readonly" \
      "$IMAGE_NAME" sh -ceu 'find /app/data -mindepth 1 -print -quit'
  )" || die "could not inspect named volume: $VOLUME_NAME"
  [[ -z "$existing" ]] || die "named volume is not empty: $VOLUME_NAME"

  docker run --rm --network none \
    --mount "type=volume,src=$staging_volume,dst=/restore-stage,readonly" \
    --mount "type=volume,src=$VOLUME_NAME,dst=/app/data" \
    "$IMAGE_NAME" sh -ceu '
      umask 077
      stage=/restore-stage/extracted/data
      target=/app/data

      [ -d "$stage" ] || {
        printf "validated staging data is missing\n" >&2
        exit 1
      }
      [ -z "$(find "$target" -mindepth 1 -print -quit)" ] || {
        printf "restore target became non-empty before copy\n" >&2
        exit 1
      }

      manifest() {
        root="$1"
        (
          cd "$root"
          find . -mindepth 1 -type d -print
          find . -type f -exec sha256sum {} \;
        ) | LC_ALL=C sort
      }

      source_manifest="$(manifest "$stage")"
      payload="$(mktemp -d "$target/.mcp-knowledge-restore.XXXXXX")"
      payload_name="${payload##*/}"
      [ -z "$(find "$target" -mindepth 1 -maxdepth 1 ! -name "$payload_name" -print -quit)" ] || {
        printf "restore target changed while payload was staged\n" >&2
        exit 1
      }

      cp -a "$stage/." "$payload/"
      [ "$(manifest "$payload")" = "$source_manifest" ] || {
        printf "staged payload validation failed\n" >&2
        exit 1
      }

      for entry in "$payload"/* "$payload"/.[!.]* "$payload"/..?*; do
        [ -e "$entry" ] || continue
        mv -n -- "$entry" "$target/"
        [ ! -e "$entry" ] || {
          printf "restore collision detected: %s\n" "${entry##*/}" >&2
          exit 1
        }
      done
      rmdir "$payload"

      [ "$(manifest "$target")" = "$source_manifest" ] || {
        printf "post-copy validation failed\n" >&2
        exit 1
      }
    ' || die "restore failed"

  printf 'Restored %s from %s\n' "$VOLUME_NAME" "$archive_path"
}

main "$@"
