# agentic-lite

A bare-bones extraction of `agentic-os` focused on:
- Agent handbook (`AGENTS.md`)
- Task logs + per-task worktrees
- Minimal SOPs/templates
- `.codex` skill sync

## Quick Start

1. Set `AGENTIC_HOME`:
   ```sh
   export AGENTIC_HOME="$PWD"
   ```
2. Run preflight (warn-only):
   ```sh
   ./scripts/core/preflight.sh
   ```
3. Create a task log + worktree:
   ```sh
   ./scripts/task/task-bootstrap.sh --name "$(date +%Y%m%d%H%M%S)-example" --slug "Example task"
   ```
4. Sync skills into Codex discovery directory:
   ```sh
   ./.codex/scripts/codex-skills/sync_codex_skills.sh
   ```

## Daily Lead Progress Slack Post (6:00 PM)

1. Put your token in `.env.local`:
   ```sh
   SLACK_USER_TOKEN=xoxp-...
   ```
2. Optional overrides in `.env.local`:
   ```sh
   LEAD_REPORT_TARGET_CHANNEL=gtm-general
   LEAD_REPORT_INBOUND_CHANNEL=leads
   LEAD_REPORT_OUTBOUND_CHANNEL=gtm-outbound
   LEAD_REPORT_INBOUND_PHRASE=Booked Calendly Meeting
   LEAD_REPORT_OUTBOUND_PHRASE=New Meeting
   LEAD_REPORT_WINDOW_HOURS=24
   LEAD_REPORT_TIMEZONE=America/Los_Angeles
   ```
3. Test with live counts to `#slack-testing`:
   ```sh
   python3 scripts/slack/post_daily_progress.py --target-channel slack-testing
   ```
4. Install daily scheduler (macOS `launchd`, 18:00 local machine time):
   ```sh
   ./scripts/slack/install_daily_progress_launchd.sh
   ```
5. Trigger it immediately (optional):
   ```sh
   launchctl kickstart -k gui/$(id -u)/com.agenticlite.daily-lead-progress
   ```

## Daily Lead Progress on GitHub (Recommended)

This runs even when your Mac is offline.

1. Add repository secret:
   - `SLACK_USER_TOKEN` = your `xoxp-...` token
2. Optional repository variables (Settings -> Secrets and variables -> Actions -> Variables):
   - `LEAD_REPORT_TARGET_CHANNEL` (default: `gtm-general`)
   - `LEAD_REPORT_INBOUND_CHANNEL` (default: `leads`)
   - `LEAD_REPORT_OUTBOUND_CHANNEL` (default: `gtm-outbound`)
   - `LEAD_REPORT_INBOUND_PHRASE` (default: `Booked Calendly Meeting`)
   - `LEAD_REPORT_OUTBOUND_PHRASE` (default: `New Meeting`)
   - `LEAD_REPORT_WINDOW_HOURS` (default: `24`)
   - `LEAD_REPORT_TIMEZONE` (default: `America/Los_Angeles`)
3. Push these files to GitHub (default branch):
   - `.github/workflows/daily-lead-progress.yml`
   - `scripts/slack/post_daily_progress.py`
4. Verify in Actions:
   - Open **Actions -> Daily Lead Progress**
   - Click **Run workflow**
   - Optional input `target_channel=slack-testing` for a safe test

Notes:
- The workflow is DST-safe for 6:00 PM Pacific by scheduling at both `01:00` and `02:00` UTC and gating to Pacific hour `18`.
- It posts with the same message format used in local runs.

## Google Calendar Meeting Creation

Use this local CLI to create meetings from Codex.

1. Create a virtual environment and install dependencies:
   ```sh
   python3 -m venv .venv
   source .venv/bin/activate
   python3 -m pip install -r requirements-google-calendar.txt
   ```
2. Copy calendar env defaults:
   ```sh
   cp .env.google-calendar.example .env
   mkdir -p secrets
   ```
3. In Google Cloud Console:
   - Enable Google Calendar API
   - Create OAuth client credentials (Desktop app)
   - Save the JSON to `secrets/google-calendar-credentials.json`
4. Authenticate once:
   ```sh
   python3 scripts/google_calendar/calendar_cli.py auth
   ```
5. Create a meeting:
   ```sh
   python3 scripts/google_calendar/calendar_cli.py create \
     --title "1:1 with Alex" \
     --start "2026-02-24T14:00" \
     --duration-minutes 30 \
     --attendee "alex@example.com" \
     --description "Weekly sync" \
     --with-meet
   ```

If `pip` is not found on your machine, always use `python3 -m pip ...`.

## Pre-Meeting 1:1 Focus Briefs

Generate a focus brief for upcoming 1:1 meetings by combining Calendar events + matching 1:1 Google Docs.

1. Ensure Workspace token exists with Docs + Drive metadata scopes:
   ```sh
   python3 scripts/google_workspace/premeeting_briefs.py --lookahead-hours 1
   ```
   The first run may open a browser for OAuth consent.

2. Run the briefing command:
   ```sh
   python3 scripts/google_workspace/premeeting_briefs.py --lookahead-hours 168
   ```

Output includes, per person:
- Meeting title/time
- Calendar link
- Matched 1:1 doc link
- Suggested focus bullets extracted from recent actionable lines in that doc
