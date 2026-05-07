# 070526 - Move Progress Report To GTM General

## What Was Asked

Move the daily lead progress Slack report from `#slack-testing` to `#gtm-general`.

## What Was Done

- Updated the production daily progress default in `scripts/slack/slack_bot.js` from `slack-testing` to `gtm-general`.
- Updated the legacy local fallback default and docstring in `scripts/slack/post_daily_progress.py`.
- Updated the README daily progress report docs and examples to show `LEAD_REPORT_TARGET_CHANNEL=gtm-general`.
- Updated Railway production env:
  - `LEAD_REPORT_TARGET_CHANNEL=gtm-general`

## Decisions Made

- Left `DISCOVERY_DIGEST_CHANNEL` on `slack-testing` because the discovery digest is a separate workflow.
- Left historical task logs unchanged even though they mention older channel values.

## Mistakes, Blockers, And Fixes

- Claude review noted that the code default would not matter if Railway still had `LEAD_REPORT_TARGET_CHANNEL=slack-testing`. Fixed by updating the Railway production variable.

## What Was Learned

- Daily progress report target is controlled by both code fallback and Railway env override.
- Railway env must be verified after changing channel defaults.

## Verification

- `node --check scripts/slack/slack_bot.js`
- `python3 -m py_compile scripts/slack/post_daily_progress.py`
- `git diff --check`
- Claude MCP review returned no blockers.
- Railway variable read-back confirmed `LEAD_REPORT_TARGET_CHANNEL=gtm-general`.

## Follow-Ups

- After commit/push, verify Railway auto-deploys successfully.
- The next scheduled daily progress report should post to `#gtm-general`.
