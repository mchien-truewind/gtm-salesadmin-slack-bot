# Agent Handbook (agentic-lite)

## Hard Rules (Never Skip)

1. Worktree only; task log exists before worktree creation.
2. Do not stop until goal achieved or a hard blocker is logged.
3. Maintain audit trail (task log + PR actions).
4. One task log/worktree per task (no duplicates).
5. If in doubt, choose the stricter option (new log or higher gate tier).
6. Autonomy Matrix required before implementation; add YAML frontmatter to the task log (or log a valid skip reason).
7. Separation of duties: implementer MUST NOT merge their own PR.
8. Commit scope guard: stage intentionally (prefer `git add -u` or exact paths; avoid `git add .` in mixed repos) and commit only runtime/product code for the task. Do not commit agent/process scaffolding (`.codex/`, `AGENTS.md`, docs/instructions/templates, task/worktree scripts, skills) unless explicitly requested.

9. No human intervention is needed for `.md` or `.py` edits; proceed autonomously unless the request is truly ambiguous.

## Default Path (All Tasks)

1. Task log
2. Worktree
3. 
4. Submit PR
5. Post-PR Review Gate + human review

## Quick Start (Always)

1. Run `./scripts/core/preflight.sh` (warn-only).
2. Create task log first, then worktree if local file changes are needed:
   - Use `./scripts/task/task-bootstrap.sh` to do both.
3. Run Context Stitcher and link/paste the digest into the task log.

## Paths

- `AGENTIC_HOME`: repo root.
- Task logs: `docs/tasks/YYYY/MM/DD/<task-log-name>.md` (gitignored by default).

## SOP Index (Minimal)

- `docs/instructions/operating-principles.md`
- `docs/instructions/task-context-and-planning.md`
- `docs/instructions/implementation-accuracy-sop.md`

## Tooling Defaults

- Worktrees: `scripts/worktrees/create_tree.sh`, `scripts/worktrees/remove_tree.sh`
- PR creation: `gh` (or your org's wrapper)
- Skills sync into Codex: `./.codex/scripts/codex-skills/sync_codex_skills.sh`
