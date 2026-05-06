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

## SOPs

- HubSpot credential setup and safe verification: `docs/instructions/hubspot-credential-verification.md`

## Slack Claude Bot (Railway)

The Slack Cloudbot runs with:

```sh
npm start
```

That starts `node scripts/slack/slack_bot.js`.

Required Claude/Anthropic env:

```sh
ANTHROPIC_API_KEY=...
CLAUDE_MODEL=claude-opus-4-1-20250805
```

`CLAUDE_MODEL` is optional in code and defaults to `claude-opus-4-1-20250805`.
Use the exact Anthropic API model ID, not a Claude.ai plan name.

## Daily Lead Progress Slack Post (Railway)

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
4. Install daily scheduler (macOS `launchd`, 18:07 local machine time):
   ```sh
   ./scripts/slack/install_daily_progress_launchd.sh
   ```
5. Trigger it immediately (optional):
   ```sh
   launchctl kickstart -k gui/$(id -u)/com.agenticlite.daily-lead-progress
   ```

Notes:
- The Railway Slack bot posts the report every day after 6 PM Pacific.
- The "This week so far" total includes Monday through end-of-day Sunday, then restarts on Monday.
- It posts with the same message format used in local runs.

## Overnight Apollo Phone Enrichment (Webhook + Google Sheets)

This runner submits Apollo `people/match` requests with `reveal_phone_number=true`, polls webhook callbacks, and continuously writes updates into a target sheet tab.

Script:
- `scripts/contact_enrichment/apollo_webhook_sheet_enrich.py`

Required env:
- `APOLLO_SEARCH` in `.env.local`

Required auth file:
- `secrets/google-drive-token.json` (Drive scope)

Example run:
```sh
python3 scripts/contact_enrichment/apollo_webhook_sheet_enrich.py \
  --sheet-id 1ftKEvAFFyietBwBKieylaEc5LvVjwE0_GvmrfnjmUP4 \
  --source-tab "Non-Accounting Firm Buyers (2025)" \
  --target-tab "Non-Accounting Buyers Enriched" \
  --state-file outputs/contact_enrichment/apollo_webhook_enrichment_state.json \
  --summary-file outputs/contact_enrichment/apollo_webhook_enrichment_summary.json \
  --max-poll-minutes 480
```

Resume an interrupted run:
```sh
python3 scripts/contact_enrichment/apollo_webhook_sheet_enrich.py \
  --sheet-id 1ftKEvAFFyietBwBKieylaEc5LvVjwE0_GvmrfnjmUP4 \
  --resume \
  --state-file outputs/contact_enrichment/apollo_webhook_enrichment_state.json \
  --summary-file outputs/contact_enrichment/apollo_webhook_enrichment_summary.json
```

Run overnight (detached):
```sh
mkdir -p outputs/contact_enrichment
nohup python3 scripts/contact_enrichment/apollo_webhook_sheet_enrich.py \
  --sheet-id 1ftKEvAFFyietBwBKieylaEc5LvVjwE0_GvmrfnjmUP4 \
  --source-tab "Non-Accounting Firm Buyers (2025)" \
  --target-tab "Non-Accounting Buyers Enriched" \
  --state-file outputs/contact_enrichment/apollo_webhook_enrichment_state.json \
  --summary-file outputs/contact_enrichment/apollo_webhook_enrichment_summary.json \
  --max-poll-minutes 480 \
  > outputs/contact_enrichment/apollo_webhook_overnight.log 2>&1 &
```

Tail logs:
```sh
tail -f outputs/contact_enrichment/apollo_webhook_overnight.log
```
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

## Gmail Inbox Auto-Filter + Draft Drafting

Auto-process inbox threads with this workflow:
- Auto-reply/subscription style emails -> label `gen-auto` + archive
- Marketing/promotional emails -> label `gen-marketing` + archive
- Conference/event threads -> label `gen-conference` + archive
- Conversation threads -> create draft replies in Gmail Drafts (never auto-send), but only when:
  - explicit actionable intent is detected, and
  - draft confidence meets threshold (`--min-draft-confidence`, default `2`)
- Low-confidence conversation threads are labeled `gen-needs-review` instead of drafting.

Script:
- `scripts/google_workspace/gmail_inbox_triage.py`

1. Ensure Gmail OAuth credentials exist:
   - `secrets/google-gmail-credentials.json`

2. Authenticate (first run or after scope changes):
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py auth
   ```

3. Run safely in dry-run mode first:
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25 --dry-run
   ```

4. Configure Slack response-needed alerts before running with mutations enabled.
   Real runs fail closed unless Slack notifications are configured. Set either a DM/user target:
   ```sh
   export SLACK_USER_ID=U1234567890
   ```

   Or set a channel plus an explicit mention:
   ```sh
   export GMAIL_TRIAGE_SLACK_CHANNEL=hiring-review
   export GMAIL_TRIAGE_SLACK_MENTION_USER_ID=U1234567890
   ```

   The token defaults to `SLACK_BOT_TOKEN`, then `SLACK_USER_TOKEN`. Use `--slack-token-env` to point at another env var. Use `--no-slack-notifications` only for an intentional non-alerting run.

5. Run with mutations enabled:
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25
   ```

Optional: force-refresh existing drafts for unchanged inbound messages:
```sh
python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25 --refresh-existing-drafts
```

Optional: control style-learning cache behavior (default reuses cached profile for 24h):
```sh
python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25 --style-cache-ttl-hours 24
python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25 --refresh-style-profile
```

6. Audit drafts addressed to blocked/no-reply senders (report-only):
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py audit-blocked-drafts --max-drafts 500 --dry-run
   ```

7. Delete blocked drafts found by the audit:
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py audit-blocked-drafts --max-drafts 500 --delete
   ```

Outputs:
- Triage state: `outputs/gmail/inbox_triage_state.json`
- Learned style profile: `outputs/gmail/style_profile.json`
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

`requirements-recruiting.txt` now includes `docling`, which the recruiter uses as the primary parser for resume PDFs/docx to improve latest role/company and LinkedIn extraction quality.

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
