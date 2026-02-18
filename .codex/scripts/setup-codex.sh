#!/usr/bin/env bash
# Description: Symlink config.toml into place and sync Codex assets.
# Note: This script does not load .env.local; source it in your shell if needed.
# Usage: source ~/.codex/scripts/setup-codex.sh [--quiet]
# Inputs: CODEX_ROOT (default: $HOME/.codex), CONFIG_SOURCE, CONFIG_OUTPUT, QUIET.

codex_setup() {
  local quiet_flag="${1:-}"
  local root="${CODEX_ROOT:-$HOME/.codex}"
  local agentic_root="${AGENTIC_ROOT:-$HOME/agentic-lite}"
  local config_source="${CONFIG_SOURCE:-$agentic_root/.codex/config.toml}"
  local output="${CONFIG_OUTPUT:-$root/config.toml}"
  local sync_skills_script="$agentic_root/.codex/scripts/codex-skills/sync_codex_skills.sh"
  local prompts_source="$agentic_root/.codex/prompts"
  local prompts_target="$root/prompts"

  if [[ ! -f "$config_source" ]]; then
    echo "codex_setup: missing config at $config_source" >&2
    return 1
  fi

  mkdir -p "$root" || {
    echo "codex_setup: failed to create CODEX_ROOT at $root" >&2
    return 1
  }

  if [[ -e "$output" ]]; then
    if [[ -L "$output" ]]; then
      local current_target
      current_target="$(readlink "$output" 2>/dev/null || true)"
      if [[ -n "$current_target" && "$current_target" != "$config_source" ]]; then
        echo "codex_setup: warning: $output points to $current_target; relinking to $config_source" >&2
      fi
    else
      echo "codex_setup: warning: $output exists and is not a symlink; it will be replaced with a symlink to $config_source" >&2
    fi
  fi

  ln -sfn "$config_source" "$output" || {
    echo "codex_setup: failed to link config to $output" >&2
    return 1
  }

  if [[ -d "$prompts_source" ]]; then
    mkdir -p "$root" || {
      echo "codex_setup: failed to create CODEX_ROOT at $root" >&2
      return 1
    }
    if [[ -e "$prompts_target" && ! -L "$prompts_target" ]]; then
      rm -rf "$prompts_target" || {
        echo "codex_setup: failed to remove existing prompts at $prompts_target" >&2
        return 1
      }
    fi
    ln -sfn "$prompts_source" "$prompts_target" || {
      echo "codex_setup: failed to link prompts to $prompts_target" >&2
      return 1
    }
  fi

  # Keep Codex skills synced from the repo into Codex's discovery directory.
  if [[ -x "$sync_skills_script" ]]; then
    if [[ "$quiet_flag" == "--quiet" || "${QUIET:-false}" == "true" ]]; then
      "$sync_skills_script" --quiet || return 1
    else
      "$sync_skills_script" || return 1
    fi
  fi

  if [[ "$quiet_flag" != "--quiet" && "${QUIET:-false}" != "true" ]]; then
    echo "codex_setup: linked $output"
  fi
}

# When executed directly, run immediately. When sourced (e.g., from ~/.zshrc),
# the caller can invoke codex_setup as needed.
if [[ "${0##*/}" == "setup-codex.sh" ]]; then
  codex_setup "$@"
fi
