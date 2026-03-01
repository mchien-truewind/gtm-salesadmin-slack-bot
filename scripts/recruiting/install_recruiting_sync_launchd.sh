#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_NAME="com.agenticlite.recruiting-sync"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$HOME/Library/Logs/agentic-lite"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "${ROOT_DIR}" &amp;&amp; "${ROOT_DIR}/scripts/recruiting/run_cycle.sh"</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>

  <key>StartInterval</key>
  <integer>600</integer>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/recruiting-sync.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/recruiting-sync.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"

echo "installed ${PLIST_PATH}"
echo "logs:"
echo "  ${LOG_DIR}/recruiting-sync.out.log"
echo "  ${LOG_DIR}/recruiting-sync.err.log"
echo "schedule:"
echo "  every 10 minutes (StartInterval=600)"
echo "run now:"
echo "  launchctl kickstart -k gui/$(id -u)/${PLIST_NAME}"
