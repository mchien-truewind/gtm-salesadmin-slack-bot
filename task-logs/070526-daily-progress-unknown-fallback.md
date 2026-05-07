# 070526 - Daily Progress Unknown Fallback

## What Was Asked

Update documentation and the local fallback only so the daily progress report reflects the new Unknown bucket for HubSpot deals whose `deal_source` does not start with `Inbound` or `Outbound`, including blanks. Do not edit `scripts/slack/slack_bot.js` because another worker owns that file.

## What Was Done

- Updated `README.md` to document blank and nonmatching `deal_source` values as `Unknown: X` instead of excluded.
- Added a README note that the legacy local fallback uses Slack keyword counts, so Unknown is always `0` locally while production HubSpot reporting counts blank/nonmatching sources as Unknown.
- Updated `scripts/slack/post_daily_progress.py` message formatting to include `Unknown: 0` by default for today and week sections.
- Included optional `today_unknown` and `week_unknown` counts in local fallback totals and weekly remaining math.
- Left `scripts/slack/slack_bot.js` untouched.

## Decisions Made

- Kept the Python script as a Slack-keyword fallback rather than adding HubSpot fetching there, because the requested scope was documentation/local fallback only.
- Used default `0` values for unknown counts so existing local callers continue to work without signature breakage.
- Chose to show `Unknown: 0` in local fallback output so local/manual posts match the production report shape.

## Mistakes, Blockers, And Fixes

- A Claude reviewer initially flagged `scripts/slack/slack_bot.js` as modified. That file was already modified in the worktree by another worker; it was verified with `git diff -- scripts/slack/slack_bot.js` and intentionally left untouched.
- No code blockers remained after scoped review of `README.md` and `scripts/slack/post_daily_progress.py`.

## What Was Learned

- The local fallback at `scripts/slack/post_daily_progress.py` counts Slack keyword matches only and cannot identify actual Unknown HubSpot deals.
- Production HubSpot report behavior is documented in the README, but the production implementation lives in `scripts/slack/slack_bot.js`, which was out of scope for this task.

## Verification

- Ran `python3 -m py_compile scripts/slack/post_daily_progress.py`; it passed.
- Checked `git diff -- README.md scripts/slack/post_daily_progress.py` to verify the intended scoped changes.
- Got three scoped Claude Code reviews with no blockers. One earlier review produced an out-of-scope blocker because it included the other worker's `slack_bot.js` diff.

## Follow-Ups

- If the Python fallback ever gains a HubSpot code path, update its success log line to include unknown counts as well as inbound/outbound counts.
