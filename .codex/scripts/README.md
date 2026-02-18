# Scripts

- `setup-codex.sh`
  - Symlinks this repo's `.codex/config.toml` into `~/.codex/config.toml`.
  - Runs `codex-skills/sync_codex_skills.sh` to sync skill definitions.

- `codex-skills/sync_codex_skills.sh`
  - Copies `skills/**/SKILL.md` into `~/.codex/skills/<skill-name>/SKILL.md`.

- `codex-skills/validate_codex_skills.sh`
  - Lightweight frontmatter sanity check for `skills/**/SKILL.md`.
