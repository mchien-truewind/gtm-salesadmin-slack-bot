# 060526 - Daily Progress Testing Channel Plan

## What Was Asked

The user asked to find the code/documentation that produces the daily Slack output:

```text
Today 5/6/26
Inbound: 0
Outbound: 5
Total: 5

This week so far
Inbound: 0
Outbound: 7
Total: 7

Weekly Goal: 30
:star2: How many more do we need? 23
```

The user also asked to move the output to `#slack-slack-testing` and provide a Claude-reviewed implementation plan for changing counts from Slack keyword search to HubSpot-direct counts.

## What Was Done

- Found the production Railway implementation in `scripts/slack/slack_bot.js`, under `runDailyProgress`.
- Found the older/local Python implementation in `scripts/slack/post_daily_progress.py`.
- Found README documentation under `Daily Lead Progress Slack Post (Railway)`.
- Changed defaults from `gtm-general` to `slack-slack-testing` in:
  - `scripts/slack/slack_bot.js`
  - `scripts/slack/post_daily_progress.py`
  - `README.md`
- Set Railway variable `LEAD_REPORT_TARGET_CHANNEL=slack-slack-testing` so production behavior is not blocked by an existing env override.
- Ran read-only HubSpot spot checks for meetings and deals.
- Asked Claude Code to review the HubSpot-count implementation plan.

## Decisions Made

- Move to the testing channel first, before changing counting semantics.
- Keep the existing Slack message format while changing data source later.
- Treat `scripts/slack/slack_bot.js` as the production path. `scripts/slack/post_daily_progress.py` is older/local and should be deprecated or kept only as a manual helper.

## Mistakes, Blockers, And Fixes

- Claude review flagged that `hs_meeting_start_time` counts when a meeting occurs, while the current Slack keyword report counts when a meeting was booked. The implementation plan needs an explicit product decision before code changes.
- Claude review flagged that HubSpot meeting records often lack Calendly metadata and deals often have blank `deal_source`, so classification needs a data audit before replacing Slack counts.

## What Was Learned

- Current production logic counts Slack messages:
  - inbound: `#leads` messages containing `Booked Calendly Meeting`
  - outbound: `#gtm-outbound` messages containing `New Meeting`
- The report posts daily after 6 PM Pacific from the Railway Slack bot.
- HubSpot meetings have `hs_meeting_start_time` and titles, but many sampled records did not have `calendly_*` metadata populated.
- HubSpot deals have `deal_source`, but sampled recent deals had many blank values and deal `createdate` may not equal the booked-meeting date.

## Verification

- `node --check scripts/slack/slack_bot.js`
- `python3 -m py_compile scripts/slack/post_daily_progress.py`
- `npm test`
- Claude Code reviewed the plan and returned blockers/gaps.

## Follow-Ups

- Rebase/commit/push the channel move.
- Verify Railway deployment.
- Run a HubSpot data audit over 2-3 weeks of meetings before implementing HubSpot-direct counting.
- Decide whether the report should count booked date or meeting occurrence date.
