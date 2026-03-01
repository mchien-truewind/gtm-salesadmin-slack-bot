#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKTREE_DIR="$ROOT_DIR"
MAIN_REPO_DIR="/Users/richardwei/agentic-lite"
FALLBACK_GMAIL_DIR="/Users/richardwei/Documents/New project/secrets"

cd "$WORKTREE_DIR"

if [[ -f "$WORKTREE_DIR/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$WORKTREE_DIR/.env.local"
  set +a
fi

if [[ -z "${RECRUITING_FROM_EMAIL:-}" && -z "${GOOGLE_GMAIL_DEFAULT_FROM:-}" ]]; then
  export RECRUITING_FROM_EMAIL="hiring@trytruewind.com"
fi

if [[ -z "${GOOGLE_GMAIL_CREDENTIALS_FILE:-}" && -f "$MAIN_REPO_DIR/secrets/google-gmail-credentials.json" ]]; then
  export GOOGLE_GMAIL_CREDENTIALS_FILE="$MAIN_REPO_DIR/secrets/google-gmail-credentials.json"
elif [[ -z "${GOOGLE_GMAIL_CREDENTIALS_FILE:-}" && -f "$FALLBACK_GMAIL_DIR/google-gmail-credentials.json" ]]; then
  export GOOGLE_GMAIL_CREDENTIALS_FILE="$FALLBACK_GMAIL_DIR/google-gmail-credentials.json"
fi

if [[ -z "${GOOGLE_GMAIL_TOKEN_FILE:-}" && -f "$MAIN_REPO_DIR/secrets/google-gmail-token.json" ]]; then
  export GOOGLE_GMAIL_TOKEN_FILE="$MAIN_REPO_DIR/secrets/google-gmail-token.json"
elif [[ -z "${GOOGLE_GMAIL_TOKEN_FILE:-}" && -f "$FALLBACK_GMAIL_DIR/google-gmail-token.json" ]]; then
  export GOOGLE_GMAIL_TOKEN_FILE="$FALLBACK_GMAIL_DIR/google-gmail-token.json"
fi

if [[ -z "${GOOGLE_DRIVE_CREDENTIALS_FILE:-}" && -f "$MAIN_REPO_DIR/secrets/google-calendar-credentials.json" ]]; then
  export GOOGLE_DRIVE_CREDENTIALS_FILE="$MAIN_REPO_DIR/secrets/google-calendar-credentials.json"
fi
if [[ -z "${GOOGLE_DRIVE_TOKEN_FILE:-}" && -f "$MAIN_REPO_DIR/secrets/google-drive-token.json" ]]; then
  export GOOGLE_DRIVE_TOKEN_FILE="$MAIN_REPO_DIR/secrets/google-drive-token.json"
fi

if [[ -z "${GOOGLE_CALENDAR_CREDENTIALS_FILE:-}" && -f "$MAIN_REPO_DIR/secrets/google-calendar-credentials.json" ]]; then
  export GOOGLE_CALENDAR_CREDENTIALS_FILE="$MAIN_REPO_DIR/secrets/google-calendar-credentials.json"
fi
if [[ -z "${GOOGLE_CALENDAR_TOKEN_FILE:-}" && -f "$MAIN_REPO_DIR/secrets/google-calendar-token.json" ]]; then
  export GOOGLE_CALENDAR_TOKEN_FILE="$MAIN_REPO_DIR/secrets/google-calendar-token.json"
fi

PYTHON_BIN="${RECRUITING_PYTHON_BIN:-$MAIN_REPO_DIR/.venv/bin/python}"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

"$PYTHON_BIN" "$WORKTREE_DIR/scripts/recruiting/coordinator_cli.py" run
