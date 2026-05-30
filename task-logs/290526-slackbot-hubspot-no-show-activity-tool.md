# 290526 - Slackbot HubSpot No-Show Activity Tool

## What Was Asked

The user asked to update the Mercedes/Truewind Slack bot so it can answer no-show, ghosted, missed-meeting, and similar questions from HubSpot deals by scanning deal-associated activities across the active pipeline.

## What Was Done

- Updated `scripts/slack/slack_bot.js`.
  - Added `hubspot_analyze_deal_activities`.
  - The tool defaults to pipeline `105321581`, activity types `meetings`, `calls`, `notes`, and `emails`, and no-show keywords `no-show`, `no show`, `didn't show`, `missed`, and `did not attend`.
  - The tool searches pipeline deals, batch-reads activity associations by deal and activity type, batch-reads activity records, and searches titles, bodies, outcomes, and excerpts for matching keywords.
  - Added `hs_meeting_outcome` to meeting activity properties so HubSpot meeting outcomes like `NO_SHOW` can be detected.
  - Added coverage metadata for deal and activity caps/truncation.
  - Added prompt routing so no-show / ghosted / missed-meeting questions use the new tool.
- Updated `scripts/slack/tests/slack_bot_hubspot.test.js`.
  - Added tool registration and prompt assertions.
  - Added helper tests for no-show keyword detection and HubSpot activity field extraction.
- Preserved the prior local calendar-title change that strips `[hiring@]` from recruiting calendar invite titles.

## Decisions Made

- Used HubSpot v4 batch association reads instead of per-deal association fetches to reduce request fanout and Slack timeout risk.
- Kept the tool read-only. It does not write HubSpot, Slack, Calendar, or any external state.
- Kept keyword matching simple and explainable with caller-overridable keywords.

## Mistakes, Blockers, And Fixes

- Initial implementation fetched associations per deal and activity type. Claude review flagged the worst-case request fanout. Fixed by batching association reads across deals per activity type.
- The repo already had many pre-existing untracked task logs; they were left untouched.

## What Was Learned

- `hubspot_get_associated_activities` already had reusable helpers for object type IDs, activity properties, chunking, batch object reads, and association result parsing.
- For no-show detection, meeting outcome metadata is important in addition to text fields.

## Verification

- `node scripts/slack/tests/slack_bot_hubspot.test.js`: passed.
- `npm test`: passed, 14/14.
- Claude Code review: approved after the batch-association optimization, no blockers.

## Follow-Ups

- Deploy the Slack bot before relying on the new tool in production.
- If results are noisy, consider narrowing the default keyword `missed` to phrases like `missed meeting` and `missed call`.
