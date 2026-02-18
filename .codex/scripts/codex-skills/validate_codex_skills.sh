#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

fail=0
while IFS= read -r -d '' f; do
  if [[ "$(head -n1 "$f" | tr -d '\r')" != "---" ]]; then
    echo "validate_codex_skills: $f: missing YAML frontmatter start (---)" >&2
    fail=1
    continue
  fi
  if ! rg -n "^name:\s*" "$f" >/dev/null 2>&1; then
    echo "validate_codex_skills: $f: missing 'name:' in frontmatter" >&2
    fail=1
  fi
  if ! rg -n "^description:\s*" "$f" >/dev/null 2>&1; then
    echo "validate_codex_skills: $f: missing 'description:' in frontmatter" >&2
    fail=1
  fi
done < <(find "$repo_root/skills" -type f -name 'SKILL.md' -print0)

if [[ $fail -ne 0 ]]; then
  exit 1
fi

echo "validate_codex_skills: ok"
