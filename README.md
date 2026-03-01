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
## Notion ATS Recruiting Coordinator (Draft-Only)

Treat Notion as your ATS for every candidate email in Gmail label `hiring@`.

Workflow:
- Ingest candidate emails + resumes from Gmail label.
- Require subject format: `ROLE - CANDIDATE NAME` where `ROLE` is `BDR` or `Growth Generalist`.
- Require subject prefix: `[hiring@]` before role/name.
- Upload resumes to Google Drive folder and store resume links in Notion.
- Set one `Career Stage` dropdown value (`Early`, `Mid`, `Late`).
- Set `Role` column from subject (`BDR` / `Growth Generalist`).
- Extract and store `LinkedIn URL`.
- Set `Company` and `Current Title` from LinkedIn URL enrichment (overwrites prior values when found).
- Classify `Location` as `U.S.` or `non-U.S.`.
- Set `Date first entered` from the first email timestamp in each `hiring@` thread.
- Post every newly-ingested candidate to Slack `#hiring-review` with resume and Notion links.
- Sync Slack reaction decisions into Notion:
  - React `:white_check_mark:` -> `Proceed`
  - React `:x:` -> `Reject`
- Read `Decision` from Notion and create draft-only replies:
  - `Proceed` -> intro call draft
  - `Reject` -> delayed rejection draft after 24 hours
  - After candidate reply -> propose first available 20-minute slot and draft scheduling reply

No calendar event is auto-created in this flow.

### Setup

1. Install dependencies:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-recruiting.txt
```

2. Configure env vars in `.env.local`.

You can use canonical names:
- `NOTION_INTERNAL_INTEGRATION_SECRET`
- `NOTION_DATABASE_ID`
- `GOOGLE_DRIVE_FOLDER_ID`

Or the aliases already used in your setup:
- `NOTION_INTERNAL_INTEGRATION`
- `NOTION_ATS_DB_ID`
- `GOOGLE_DRIVE_FOLDER_ATS`

Use `.env.recruiting.example` as the reference.

3. Ensure OAuth credential files exist under `secrets/`:
- `google-gmail-credentials.json`
- `google-drive-credentials.json`
- `google-calendar-credentials.json`
4. Ensure People Data Labs API key is set for LinkedIn enrichment:
- `PDL_API` (or `PDL_API_KEY`)
5. Configure Slack review channel integration:
- `SLACK_BOT_TOKEN` (or `SLACK_USER_TOKEN`)
- `RECRUITING_SLACK_REVIEW_CHANNEL=hiring-review`
- Optional: `RECRUITING_SLACK_REVIEW_CHANNEL_ID=<channel-id>` (recommended to avoid extra Slack API lookups)
- Invite the Slack app/user token identity to `#hiring-review`

### Commands

Authenticate + verify schema:

```sh
python3 scripts/recruiting/coordinator_cli.py auth
python3 scripts/recruiting/coordinator_cli.py schema-check
```

Run ingestion only:

```sh
python3 scripts/recruiting/coordinator_cli.py ingest
```

Process Notion decisions only:

```sh
python3 scripts/recruiting/coordinator_cli.py process-decisions
```

Sync Slack reactions into Notion decisions:

```sh
python3 scripts/recruiting/coordinator_cli.py sync-slack-decisions
```

Run full cycle:

```sh
python3 scripts/recruiting/coordinator_cli.py run
```

### Run Every 10 Minutes

Install launchd scheduler (macOS):

```sh
./scripts/recruiting/install_recruiting_sync_launchd.sh
```

Manual trigger:

```sh
launchctl kickstart -k gui/$(id -u)/com.agenticlite.recruiting-sync
```

Logs:

- `~/Library/Logs/agentic-lite/recruiting-sync.out.log`
- `~/Library/Logs/agentic-lite/recruiting-sync.err.log`

### Always-On (GitHub Actions)

If your laptop sleeps, use the cloud scheduler in `.github/workflows/recruiting-sync.yml`.

Required repository secrets:
- `NOTION_INTERNAL_INTEGRATION_SECRET`
- `NOTION_ATS_DB_ID`
- `GOOGLE_DRIVE_FOLDER_ATS`
- `RECRUITING_FROM_EMAIL`
- `SLACK_BOT_TOKEN` or `SLACK_USER_TOKEN`
- `GOOGLE_GMAIL_CREDENTIALS_JSON`
- `GOOGLE_GMAIL_TOKEN_JSON`
- `GOOGLE_DRIVE_CREDENTIALS_JSON`
- `GOOGLE_DRIVE_TOKEN_JSON`
- `GOOGLE_CALENDAR_CREDENTIALS_JSON`
- `GOOGLE_CALENDAR_TOKEN_JSON`
- Optional: `PDL_API`

Recommended repository variables:
- `RECRUITING_SLACK_REVIEW_CHANNEL_ID` (for example `C0AHRKW87LN`)
- `RECRUITING_SLACK_REVIEW_CHANNEL` (fallback channel name, default `hiring-review`)

Behavior:
- Runs every 10 minutes (`*/10 * * * *`) regardless of laptop sleep.
- You can also trigger it manually from GitHub Actions via **Run workflow**.
