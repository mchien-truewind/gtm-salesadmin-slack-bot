---
summary: "Core operating principles for agentic-lite: safety, traceability, and scope control."
read_when:
  - "Any time you're unsure which workflow to follow."
title: "Operating Principles"
---

# Operating Principles

## Defaults
- Accuracy over speed.
- Traceability over convenience: keep the task log current.
- Reversible choices over irreversible ones.

## Safety
- Do not put secrets in logs, screenshots, or committed files.
- Prefer minimal diffs; avoid parallel systems unless explicitly required.

## Task hygiene
- One task log + one worktree per task.
- Create the task log before the worktree.
- Implement only inside the task worktree.

## Review
- Run Execution Gate before submitting any PR.
- Do not merge your own PR.
