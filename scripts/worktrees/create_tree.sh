#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: create_tree.sh [-d worktree-name] <branch> [base-branch]" >&2
}

worktree_name=""
while getopts ":d:h" opt; do
  case "$opt" in
    d) worktree_name="$OPTARG" ;;
    h) usage; exit 0 ;;
    \?) usage; exit 1 ;;
    :) echo "create_tree: -$OPTARG requires an argument" >&2; usage; exit 1 ;;
  esac
done
shift $((OPTIND-1))

branch="${1:-}"
base="${2:-main}"

if [[ -z "$branch" ]]; then
  usage
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "create_tree: run inside a git repository" >&2
  exit 1
}

common_dir_rel="$(git rev-parse --git-common-dir 2>/dev/null)"
if [[ "$common_dir_rel" = /* ]]; then
  common_dir="$common_dir_rel"
else
  common_dir="$repo_root/$common_dir_rel"
fi
common_root="$(dirname "$common_dir")"
worktree_parent="$common_root/.worktrees"
mkdir -p "$worktree_parent"

if [[ -n "$worktree_name" ]]; then
  dir_name="${worktree_name##*/}"
else
  dir_name="${branch##*/}"
fi
worktree_dir="$worktree_parent/$dir_name"

if [[ -d "$worktree_dir" ]]; then
  echo "create_tree: $worktree_dir already exists" >&2
  exit 1
fi

if git remote get-url origin >/dev/null 2>&1; then
  git fetch origin "$base" >/dev/null 2>&1 || true
  base_ref="origin/$base"
else
  base_ref="$base"
fi

if git show-ref --verify --quiet "refs/heads/$branch"; then
  git worktree add "$worktree_dir" "$branch"
else
  git worktree add "$worktree_dir" -b "$branch" "$base_ref"
fi

# Convenience: copy .env.local if present in repo root.
if [[ -f "$repo_root/.env.local" && ! -f "$worktree_dir/.env.local" ]]; then
  cp "$repo_root/.env.local" "$worktree_dir/.env.local" || true
fi

echo "create_tree: $worktree_dir"
