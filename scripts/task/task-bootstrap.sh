#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage: task-bootstrap.sh --name <task-log-name> --slug <short-desc> [options]

Options:
  --name <name>      Canonical task id: YYYYMMDDHHmmss-<short-description>
  --slug <text>      Short human description for the log header
  --base <branch>    Base branch for worktree creation (default: main)
  --query <text>     Query for context stitcher (default: slug)
  --no-context       Skip context stitcher
USAGE
}

name=""
slug=""
base="main"
query=""
no_context=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      name="${2:-}"; shift 2 ;;
    --slug)
      slug="${2:-}"; shift 2 ;;
    --base)
      base="${2:-}"; shift 2 ;;
    --query)
      query="${2:-}"; shift 2 ;;
    --no-context)
      no_context=true; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "task-bootstrap: unknown arg: $1" >&2
      usage; exit 2 ;;
  esac
done

if [[ -z "$name" || -z "$slug" ]]; then
  usage
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

yyyy="${name:0:4}"; mm="${name:4:2}"; dd="${name:6:2}"
log_dir="$repo_root/docs/tasks/$yyyy/$mm/$dd"
mkdir -p "$log_dir"
log_path="$log_dir/$name.md"

if [[ -f "$log_path" ]]; then
  echo "task-bootstrap: task log already exists: $log_path" >&2
  exit 1
fi

agent_id="${AGENT_ID:-eng}"
origin_id="task:v1:${name}"

worktree_line="$($repo_root/scripts/worktrees/create_tree.sh "$name" "$base" | tail -n1)"
worktree_dir="${worktree_line#create_tree: }"

cat >"$log_path" <<TASKLOG
---
id: "$name"
origin_id: "$origin_id"
agent_id: "$agent_id"
date: "$(date -Iseconds)"
goal: "$slug"
worktree: "$worktree_dir"
branch: "$name"
status: "active"
autonomy:
  matrix: "TODO"
execution_gate:
  tier: "TODO"
  verdict: "TODO"
---

# $slug

## Acceptance Checklist
- [ ] Define acceptance criteria
- [ ] Implement
- [ ] Add evidence (tests/logs/screenshots)
- [ ] Run Execution Gate
- [ ] Submit PR (do not self-merge)

## Must Nots
- [ ] No changes directly on main or repo root
- [ ] No secrets in logs/docs

## Assumptions
- (log assumptions + defaults here)

TASKLOG

echo "task log: $log_path"
echo "worktree: $worktree_dir"
