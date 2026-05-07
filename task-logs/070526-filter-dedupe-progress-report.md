# 070526 - Filter And Dedupe Progress Report

## What Was Asked

Update the Slack daily progress report so it still counts HubSpot deals by created date for the current week, but excludes wrong-pipeline deals, obvious test/internal deals, and duplicate deals.

## What Was Done

- Updated `scripts/slack/slack_bot.js`:
  - Added `LEAD_REPORT_PIPELINE_ID`, defaulting to active pipeline `105321581`.
  - Added a HubSpot Deals search filter: `pipeline EQ 105321581`.
  - Kept the created-date week window as the primary date filter.
  - Added obvious test/internal filtering for deal names matching whole-word `test` or `truewind`.
  - Added normalized deal-name dedupe before counting.
  - Kept Inbound/Outbound/Unknown bucket logic and totals.
  - Added logs for skipped test/internal deals and deduped deals.
  - Hardened Pacific hour parsing for environments that format midnight as hour `24`.
- Updated `README.md` to describe active-pipeline filtering, Monday 00:00 PT through report-run window, and normalized deal-name dedupe.

## Decisions Made

- Deduping is by normalized deal name rather than HubSpot company association because the existing HubSpot search query returns deals only and the user asked for a quick report-count fix.
- The first created deal wins when duplicates normalize to the same key because the query sorts by `createdate` ascending.
- `test` filtering uses a word-boundary regex to avoid false positives like `Attest`; `truewind` remains an internal/test exclusion.

## Mistakes, Blockers, And Fixes

- Claude flagged the initial `includes('test')` approach as too broad. Fixed it to `/\btest\b/i`.
- A reviewer noted README said same-company dedupe while code deduped normalized deal names. Updated README wording to match implementation.
- One reviewer agent timed out and was closed; Claude MCP final blocker review returned no blockers.

## What Was Learned

- Live diagnostic with the patched logic against HubSpot returned:
  - raw active-pipeline rows: 21
  - skipped test/internal: 3
  - deduped duplicates: 4
  - kept countable deals: 14
  - counts: Outbound 2, Unknown 12, Inbound 0
- The current report still has a high Unknown share because many active-pipeline deals have blank, `Event`, or `PR` deal source values.

## Verification

- `node --check scripts/slack/slack_bot.js`
- `python3 -m py_compile scripts/slack/post_daily_progress.py`
- `npm test`
- `git diff --check`
- Live HubSpot diagnostic confirmed the patched counting behavior.
- Claude MCP reviewed the final patch and reported no blockers.

## Follow-Ups

- If exact same-company dedupe is required, extend the HubSpot query to fetch deal-company associations and dedupe on associated company ID instead of normalized deal name.
- Clean up HubSpot `deal_source` values so `Event`, `PR`, and blanks map cleanly to Inbound/Outbound/Unknown expectations.
