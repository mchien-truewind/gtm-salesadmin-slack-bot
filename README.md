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
