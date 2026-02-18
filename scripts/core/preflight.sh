#!/usr/bin/env bash
set -euo pipefail

# Warn-only preflight (exit 0 unless --strict).
STRICT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict)
      STRICT=1
      shift
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: scripts/core/preflight.sh [--strict]

Checks that the minimal required CLIs exist.
- Default: warn-only (exit 0)
- --strict: exit 1 if any required tool is missing
USAGE
      exit 0
      ;;
    *)
      echo "preflight: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

missing=()
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    missing+=("$1")
  fi
}

need git
need rg
need python3

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "preflight: missing tools: ${missing[*]}" >&2
  if [[ $STRICT -eq 1 ]]; then
    exit 1
  fi
fi

echo "preflight: ok"
