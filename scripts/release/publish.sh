#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

die() {
  printf 'container publish: %s\n' "$*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool is unavailable: $1"
}

is_semantic_version() {
  local version="$1"
  local core="${version%%+*}"
  local prerelease=""
  local build_metadata=""
  local identifier

  if [[ "$version" == *+* ]]; then
    build_metadata="${version#*+}"
    [[ "$build_metadata" =~ ^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$ ]] || return 1
  fi
  if [[ "$core" == *-* ]]; then
    prerelease="${core#*-}"
    core="${core%%-*}"
    [[ "$prerelease" =~ ^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$ ]] || return 1
    while IFS= read -r identifier; do
      [[ "$identifier" =~ ^[0-9]+$ && "$identifier" != 0 && "$identifier" == 0* ]] && return 1
    done < <(tr '.' '\n' <<<"$prerelease")
  fi

  [[ "$core" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

main() {
  [[ "$#" -eq 2 ]] || die "usage: $0 IMAGE_REF VERSION"

  local image_ref="$1"
  local version="$2"
  local tag="v${version}"
  local head
  local tagged_commit
  local inspection

  [[ -n "$image_ref" && "$image_ref" != *[[:space:]]* ]] || die "IMAGE_REF must be a non-empty OCI image reference without whitespace"
  [[ "$version" != v* ]] || die "VERSION must exclude the leading v"
  is_semantic_version "$version" || die "VERSION must be a Semantic Version, such as 0.1.0"

  require_tool docker
  require_tool git
  docker buildx version >/dev/null 2>&1 || die "Docker Buildx is required"
  docker info >/dev/null 2>&1 || die "Docker daemon is unavailable"
  git -C "$REPOSITORY_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "repository root is not a Git work tree"
  [[ -z "$(git -C "$REPOSITORY_ROOT" status --porcelain)" ]] || die "Git work tree must be clean before publication"

  git -C "$REPOSITORY_ROOT" rev-parse -q --verify "refs/tags/${tag}^{tag}" >/dev/null ||
    die "${tag} must exist and be an annotated tag"
  head="$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)"
  tagged_commit="$(git -C "$REPOSITORY_ROOT" rev-parse "${tag}^{commit}")"
  [[ "$tagged_commit" == "$head" ]] || die "${tag} must point at HEAD"

  bash "$SCRIPT_DIR/test-platforms.sh"

  docker buildx build --platform linux/amd64,linux/arm64 \
    --build-arg "VCS_REF=$head" --build-arg "VERSION=$version" \
    --tag "$image_ref:$version" --tag "$image_ref:0.1" --push "$REPOSITORY_ROOT"

  inspection="$(docker buildx imagetools inspect "$image_ref:$version")"
  printf '%s\n' "$inspection"
  grep -Eq 'Platform:[[:space:]]+linux/amd64([[:space:]]|$)' <<<"$inspection" ||
    die "published manifest is missing linux/amd64"
  grep -Eq 'Platform:[[:space:]]+linux/arm64([[:space:]]|$)' <<<"$inspection" ||
    die "published manifest is missing linux/arm64"

  printf 'Published and verified %s for linux/amd64 and linux/arm64.\n' "$image_ref:$version"
}

main "$@"
