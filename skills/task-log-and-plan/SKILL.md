---
name: task-log-and-plan
description: Create/update the task log and initial plan; use at the start of every task before editing.
---

# Task log and plan

## Steps
1. Decide whether this is a follow-up to an existing task. If yes, reuse the existing task log/worktree.
2. Choose the canonical task id: `YYYYMMDDHHmmss-<short-description>`.
3. Create the task log at: `$AGENTIC_HOME/docs/tasks/YYYY/MM/DD/<task-id>.md`.
4. If local file changes are needed, create a worktree whose branch matches the task id.
   - Recommended: use `scripts/task/task-bootstrap.sh` to create the log + worktree in one step.
5. Write a short plan + acceptance checklist before coding.

## References
- `$AGENTIC_HOME/docs/instructions/task-context-and-planning.md`
- `$AGENTIC_HOME/docs/instructions/implementation-accuracy-sop.md`
