---
name: worktree-bootstrap
description: Create a per-task worktree/branch with $AGENTIC_HOME/scripts/worktrees/create_tree.sh; use only when local file changes are needed (one-task-one-worktree).
---

# Worktree bootstrap

## Steps
1. Decide the task id first (canonical, `YYYYMMDDHHmmss-<short-description>`).
2. Create the task log first; confirm it exists before creating a worktree.
3. Never change files directly in `main` or the repo root; make all changes inside the task worktree.
4. Create the worktree:
   ```sh
   $AGENTIC_HOME/scripts/worktrees/create_tree.sh <task-id> [base-branch]
   ```
5. PR continuation (optional): use the existing PR branch name, but put the worktree in a directory named after your task id:
   ```sh
   $AGENTIC_HOME/scripts/worktrees/create_tree.sh -d <task-id> <pr-branch> [base-branch]
   ```
6. Remove it when done:
   ```sh
   $AGENTIC_HOME/scripts/worktrees/remove_tree.sh <task-id>
   ```
