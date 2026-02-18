#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_NAME="com.agenticlite.daily-lead-progress"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$HOME/Library/Logs/agentic-lite"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat >"$PLIST_PATH" <<EOF
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
    <string>cd "${ROOT_DIR}" && /usr/bin/python3 "${ROOT_DIR}/scripts/slack/post_daily_progress.py"</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>

  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Weekday</key><integer>0</integer>
      <key>Hour</key><integer>18</integer>
      <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>1</integer>
      <key>Hour</key><integer>18</integer>
      <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>2</integer>
      <key>Hour</key><integer>18</integer>
      <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>3</integer>
      <key>Hour</key><integer>18</integer>
      <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>4</integer>
      <key>Hour</key><integer>18</integer>
      <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>5</integer>
      <key>Hour</key><integer>18</integer>
      <key>Minute</key><integer>0</integer>
    </dict>
    <dict>
      <key>Weekday</key><integer>6</integer>
      <key>Hour</key><integer>23</integer>
      <key>Minute</key><integer>59</integer>
    </dict>
  </array>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/daily-lead-progress.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/daily-lead-progress.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"

echo "installed ${PLIST_PATH}"
echo "logs:"
echo "  ${LOG_DIR}/daily-lead-progress.out.log"
echo "  ${LOG_DIR}/daily-lead-progress.err.log"
echo "schedule:"
echo "  Sun-Fri at 18:00 local machine time"
echo "  Sat at 23:59 local machine time"
echo "test run now:"
echo "  launchctl kickstart -k gui/$(id -u)/${PLIST_NAME}"
