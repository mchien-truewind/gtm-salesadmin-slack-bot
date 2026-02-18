#!/usr/bin/env zsh
set -euo pipefail

# agentic-lite setup
# Usage: source scripts/setup.sh
# - Sets AGENTIC_HOME/AGENTIC_ROOT
# - Adds minimal helper scripts to PATH
# - Runs Codex setup (config link + skill sync)

script_path="${(%):-%x}"
script_dir="${script_path:A:h}"
repo_root="${script_dir:h}"

if [[ -z "${AGENTIC_HOME:-}" || ! -f "${AGENTIC_HOME}/AGENTS.md" ]]; then
  AGENTIC_HOME="$repo_root"
fi
export AGENTIC_HOME

# Some tooling (including our Codex setup script) uses AGENTIC_ROOT.
export AGENTIC_ROOT="$AGENTIC_HOME"

# Ensure Codex has an Agent Handbook at ~/.codex/AGENTS.md.
# Default preference order:
# 1) $CODEX_AGENTS_SOURCE (explicit override)
# 2) /Users/tennisonchan/agentic-os/AGENTS.md (if present)
# 3) $AGENTIC_HOME/AGENTS.md (this repo)
codex_root="${CODEX_ROOT:-$HOME/.codex}"
codex_agents_path="${codex_root}/AGENTS.md"
default_os_agents="/Users/tennisonchan/agentic-os/AGENTS.md"
agents_source="${CODEX_AGENTS_SOURCE:-}"

if [[ -z "$agents_source" ]]; then
  if [[ -f "$default_os_agents" ]]; then
    agents_source="$default_os_agents"
  else
    agents_source="$AGENTIC_HOME/AGENTS.md"
  fi
fi

if [[ -f "$agents_source" ]]; then
  mkdir -p "$codex_root"
  if [[ -e "$codex_agents_path" && ! -L "$codex_agents_path" ]]; then
    ts="$(date +%Y%m%d%H%M%S)"
    mv "$codex_agents_path" "${codex_agents_path}.bak.${ts}"
  fi
  ln -sfn "$agents_source" "$codex_agents_path"
else
  print -u2 -- "[agentic-lite setup] warning: AGENTS.md source not found at: $agents_source"
fi

path_candidates=(
  "$AGENTIC_HOME/scripts"
  "$AGENTIC_HOME/scripts/core"
  "$AGENTIC_HOME/scripts/task"
  "$AGENTIC_HOME/scripts/worktrees"
)

for candidate in "${path_candidates[@]}"; do
  if [[ -d "$candidate" ]]; then
    case ":$PATH:" in
      *":$candidate:"*) ;;
      *) export PATH="$candidate:$PATH" ;;
    esac
  fi
done

if [[ -f "$AGENTIC_HOME/.codex/scripts/setup-codex.sh" ]]; then
  source "$AGENTIC_HOME/.codex/scripts/setup-codex.sh" --quiet
fi

if [[ -f "$AGENTIC_HOME/scripts/worktrees/create_tree.sh" ]]; then
  alias "tree+"="$AGENTIC_HOME/scripts/worktrees/create_tree.sh"
fi

if [[ -f "$AGENTIC_HOME/scripts/worktrees/remove_tree.sh" ]]; then
  alias "tree-"="$AGENTIC_HOME/scripts/worktrees/remove_tree.sh"
fi
