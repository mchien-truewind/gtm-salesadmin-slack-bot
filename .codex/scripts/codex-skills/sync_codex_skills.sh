#!/usr/bin/env bash
set -euo pipefail

quiet=false
repo_root=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet)
      quiet=true
      shift
      ;;
    --repo-root)
      repo_root="${2:-}"
      if [[ -z "$repo_root" ]]; then
        echo "sync_codex_skills: --repo-root requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: sync_codex_skills.sh [--quiet] [--repo-root <path>]

Copies skill definitions from this repo into ~/.codex/skills/<skill-name>/SKILL.md.

Source of truth: skills/**/SKILL.md (curated only; no external registry).
USAGE
      exit 0
      ;;
    *)
      echo "sync_codex_skills: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$repo_root" ]]; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fi

src_root="$repo_root/skills"
dest_root="$HOME/.codex/skills"

if [[ ! -d "$src_root" ]]; then
  echo "sync_codex_skills: missing skills dir: $src_root" >&2
  exit 1
fi

mkdir -p "$dest_root"

# Extracts 'name:' from YAML frontmatter; falls back to parent dir name.
extract_name() {
  local file="$1"
  local name
  name="$(awk '
    BEGIN{fm=0}
    NR==1 && $0=="---"{fm=1;next}
    fm && $0=="---"{exit}
    fm && $1=="name:"{sub(/^name:[[:space:]]*/,"",$0); gsub(/"/,"",$0); print $0; exit}
  ' "$file" | sed 's/^ *//;s/ *$//')"
  if [[ -n "$name" ]]; then
    printf '%s' "$name"
    return 0
  fi
  printf '%s' "$(basename "$(dirname "$file")")"
}

processed=0
updated=0

while IFS= read -r -d '' skill_file; do
  skill_name="$(extract_name "$skill_file")"
  [[ -n "$skill_name" ]] || continue

  target_dir="$dest_root/$skill_name"
  mkdir -p "$target_dir"

  tmp="$target_dir/SKILL.md.tmp"
  out="$target_dir/SKILL.md"

  cp "$skill_file" "$tmp"
  processed=$((processed+1))

  if [[ -f "$out" ]] && cmp -s "$tmp" "$out"; then
    rm -f "$tmp"
    continue
  fi

  mv -f "$tmp" "$out"
  updated=$((updated+1))
done < <(find "$src_root" -type f -name 'SKILL.md' -print0)

if ! $quiet; then
  echo "sync_codex_skills: processed=$processed updated=$updated dest=$dest_root"
fi
