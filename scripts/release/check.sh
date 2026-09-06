#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

die() {
  printf 'release check: %s\n' "$*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool is unavailable: $1"
}

step() {
  printf '== %s ==\n' "$*"
}

check_readme_links() {
  local file="$1"
  local link target
  while IFS= read -r link; do
    [[ -n "$link" ]] || continue
    case "$link" in
      http://* | https://* | mailto:* | \#*) continue ;;
    esac
    target="${link%%#*}"
    [[ -f "$REPOSITORY_ROOT/$target" ]] || die "$file links to missing file: $target"
  done < <(grep -oE '\]\([^)]+\)' "$REPOSITORY_ROOT/$file" | sed -E 's/^\]\((.*)\)$/\1/')
}

check_scale_report() {
  local documents="$1"
  local path="docs/results/scale-${documents}.json"
  [[ -f "$REPOSITORY_ROOT/$path" ]] || die "missing scale report: $path"
  BUN_REPORT_PATH="$REPOSITORY_ROOT/$path" BUN_REPORT_DOCUMENTS="$documents" \
    bun -e '
      import { validateScaleReport } from "./scripts/scale/lib.ts";
      const path = process.env.BUN_REPORT_PATH!;
      const expected = Number(process.env.BUN_REPORT_DOCUMENTS);
      const value = await Bun.file(path).json();
      validateScaleReport(value);
      if (value.documents !== expected) {
        throw new Error(`${path}: expected documents=${expected}, got ${value.documents}`);
      }
    ' || die "invalid scale report: $path"
}

main() {
  [[ "$#" -eq 0 ]] || die "usage: $0"
  cd "$REPOSITORY_ROOT"

  require_tool bun
  require_tool git
  require_tool docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose is required"

  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "repository root is not a Git work tree"
  [[ -z "$(git status --porcelain)" ]] || die "Git work tree must be clean before release"

  step "Installing dependencies (frozen lockfile)"
  bun install --frozen-lockfile

  step "Type checking"
  bun run typecheck

  step "Running tests"
  bun test

  step "Building dashboard CSS"
  bun ui:css

  step "Checking for whitespace errors"
  git diff --check

  step "Validating Compose config"
  docker compose config --quiet

  step "Running both-platform Docker smoke tests"
  bash "$SCRIPT_DIR/test-platforms.sh"

  step "Validating scale reports"
  check_scale_report 100
  check_scale_report 500
  check_scale_report 1000

  step "Checking README links resolve locally"
  check_readme_links README.md

  printf 'Release check passed.\n'
}

main "$@"
