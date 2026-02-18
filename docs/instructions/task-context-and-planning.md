---
summary: "How to create task logs, run a lightweight Context Stitcher, and use per-task worktrees safely."
read_when:
  - "At the start of any task that needs local changes."
title: "Task Context & Planning"
---

# Task Context & Planning

## Canonical identifiers
- Task id format: `YYYYMMDDHHmmss-<short-description>`.
- Task log path: `docs/tasks/YYYY/MM/DD/<task-id>.md`.
- Worktree branch name: must match the task id.

## Required flow
1. Create the task log before creating a worktree.
2. If local changes are needed, create a dedicated worktree (one task, one worktree).
3. Run Context Stitcher at task start and link the digest in the task log.
4. Complete the Autonomy Matrix before implementation (or log a valid skip reason).
5. Implement inside the worktree only.
6. Run Execution Gate before submitting a PR, and paste the review output into the task log.

## Bootstrap command (recommended)
```sh
./scripts/task/task-bootstrap.sh \
  --name "$(date +%Y%m%d%H%M%S)-short-desc" \
  --slug "Short description"
```

## Worktrees
- Create: `./scripts/worktrees/create_tree.sh <branch> [base-branch]`
- Remove: `./scripts/worktrees/remove_tree.sh <branch-or-path>`
