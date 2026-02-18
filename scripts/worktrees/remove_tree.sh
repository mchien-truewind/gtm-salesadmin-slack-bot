#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: remove_tree.sh <branch-or-path> [-f]" >&2
}

force=false

# parse flags anywhere
args=()
for a in "$@"; do
  case "$a" in
    -f) force=true ;;
    *) args+=("$a") ;;
  esac
done

target="${args[0]:-}"
if [[ -z "$target" ]]; then
  usage
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "remove_tree: run inside a git repository" >&2
  exit 1
}

if [[ -d "$target" || "$target" = /* || "$target" = ./* ]]; then
  worktree_dir="$(cd "$target" 2>/dev/null && pwd -P)" || {
    echo "remove_tree: $target is not a directory" >&2
    exit 1
  }
else
  # Find worktree directory by branch name.
  worktree_dir="$(git worktree list --porcelain | awk -v b="$target" '
    $1=="worktree"{wt=$2}
    $1=="branch" && $2=="refs/heads/"b{print wt; exit}
  ')"
  if [[ -z "$worktree_dir" ]]; then
    # Fallback: default common-root worktrees dir.
    common_dir_rel="$(git rev-parse --git-common-dir 2>/dev/null)"
    if [[ "$common_dir_rel" = /* ]]; then
      common_dir="$common_dir_rel"
    else
      common_dir="$repo_root/$common_dir_rel"
    fi
    common_root="$(dirname "$common_dir")"
    worktree_dir="$common_root/.worktrees/${target##*/}"
  fi
fi

if [[ ! -d "$worktree_dir" ]]; then
  echo "remove_tree: worktree directory does not exist: $worktree_dir" >&2
  exit 1
fi

rm_args=()
$force && rm_args+=("-f")

git worktree remove "${rm_args[@]}" "$worktree_dir"
echo "remove_tree: removed $worktree_dir"
