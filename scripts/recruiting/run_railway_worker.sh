#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRETS_DIR="${RECRUITING_RUNTIME_SECRETS_DIR:-/tmp/recruiting-secrets}"
LOOP_SECONDS="${RECRUITING_LOOP_SECONDS:-600}"

mkdir -p "$SECRETS_DIR" "$ROOT_DIR/outputs/recruiting"

write_secret_file() {
  local source_var="$1"
  local dest_path="$2"
  local value="${!source_var:-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value" > "$dest_path"
  fi
}

write_secret_file GOOGLE_GMAIL_CREDENTIALS_JSON "$SECRETS_DIR/google-gmail-credentials.json"
write_secret_file GOOGLE_GMAIL_TOKEN_JSON "$SECRETS_DIR/google-gmail-token.json"
write_secret_file GOOGLE_DRIVE_CREDENTIALS_JSON "$SECRETS_DIR/google-drive-credentials.json"
write_secret_file GOOGLE_DRIVE_TOKEN_JSON "$SECRETS_DIR/google-drive-token.json"
write_secret_file GOOGLE_CALENDAR_CREDENTIALS_JSON "$SECRETS_DIR/google-calendar-credentials.json"
write_secret_file GOOGLE_CALENDAR_TOKEN_JSON "$SECRETS_DIR/google-calendar-token.json"

export GOOGLE_GMAIL_CREDENTIALS_FILE="${GOOGLE_GMAIL_CREDENTIALS_FILE:-$SECRETS_DIR/google-gmail-credentials.json}"
export GOOGLE_GMAIL_TOKEN_FILE="${GOOGLE_GMAIL_TOKEN_FILE:-$SECRETS_DIR/google-gmail-token.json}"
export GOOGLE_DRIVE_CREDENTIALS_FILE="${GOOGLE_DRIVE_CREDENTIALS_FILE:-$SECRETS_DIR/google-drive-credentials.json}"
export GOOGLE_DRIVE_TOKEN_FILE="${GOOGLE_DRIVE_TOKEN_FILE:-$SECRETS_DIR/google-drive-token.json}"
export GOOGLE_CALENDAR_CREDENTIALS_FILE="${GOOGLE_CALENDAR_CREDENTIALS_FILE:-$SECRETS_DIR/google-calendar-credentials.json}"
export GOOGLE_CALENDAR_TOKEN_FILE="${GOOGLE_CALENDAR_TOKEN_FILE:-$SECRETS_DIR/google-calendar-token.json}"
export RECRUITING_FROM_EMAIL="${RECRUITING_FROM_EMAIL:-hiring@trytruewind.com}"
export PYTHONUNBUFFERED=1

cd "$ROOT_DIR"

while true; do
  echo "[recruiting-worker] cycle_start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if python scripts/recruiting/coordinator_cli.py run; then
    echo "[recruiting-worker] cycle_success"
  else
    rc=$?
    echo "[recruiting-worker] cycle_failure rc=${rc}"
  fi
  echo "[recruiting-worker] sleeping ${LOOP_SECONDS}s"
  sleep "$LOOP_SECONDS"
done
