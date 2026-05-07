# 070526 - Double Check Progress HubSpot Data

## What Was Asked

The user said the Slack progress report should not show 20 deals created this week and asked to double-check the code and HubSpot data with Claude review.

## What Was Done

- Reproduced the production HubSpot CRM Deals search using the Railway production HubSpot token.
- Queried deals from Monday 2026-05-04 00:00 PT (`2026-05-04T07:00:00.000Z`) through the current time on 2026-05-07.
- Compared HubSpot search filters using both ISO datetime values and epoch-millisecond string values; both returned the same 22 deals.
- Pulled source metadata including `pipeline`, `dealstage`, `hs_object_source`, source detail fields, and creator IDs.
- Opened the HubSpot report URL via Playwright, but it redirected to login, so report filters could not be inspected from the browser.
- Sent the code behavior and HubSpot row evidence to Claude MCP for review.

## Decisions Made

- Did not change code during this investigation because the correct missing filter is not yet confirmed from the HubSpot report configuration.
- Treated the data issue as likely report-scope/filter mismatch rather than a date-window bug because HubSpot returned explicit `createdate` values within the Monday-to-now window.

## Mistakes, Blockers, And Fixes

- A local reproduction of the production Pacific-midnight helper hit an Intl formatting edge case where midnight formatted as hour `24`, causing `pacificLocalToUtcDate` to fail locally. The direct HubSpot data query used the known UTC value for Monday 00:00 PT instead.
- HubSpot report API/dashboard endpoints had previously returned 404, and the report UI required login, so exact report filters remain unverified.

## What Was Learned

- HubSpot currently returns 22 deals created since Monday 2026-05-04 00:00 PT:
  - `Outbound - Sales Sourced List`: 2
  - blank `deal_source`: 11
  - `Event`: 7
  - `PR`: 2
- Pipeline split:
  - `105321581`: 21
  - `default`: 1
- One obvious non-report row is in `default` pipeline and `closedlost` stage.
- One obvious test row is `Mercedes test - Truewind Intro Meeting (Sarah Elix) - 2026-05-29`.
- After filtering to active pipeline `105321581` and excluding the obvious test row, 20 rows remain, but only 15 unique normalized company names due to duplicate deals:
  - PKF O'Connor Davies
  - Sound Community Services
  - A+ Education Partnership
  - WoundCentrics
  - trytruewind.com
- Claude reviewed the code and data and agreed the current code counts what HubSpot returns, but likely lacks filters/deduplication needed to match the user's intended report.

## Verification

- Production HubSpot data queried successfully via `/crm/v3/objects/deals/search`.
- ISO and epoch-millisecond date filters returned identical results.
- Claude MCP reviewed the code/data evidence and found the likely issue is missing report filters, not arithmetic.

## Follow-Ups

- Inspect the actual HubSpot report filters from a logged-in browser/session or exported report definition.
- Likely code changes to consider once confirmed:
  - Filter to pipeline `105321581`.
  - Exclude obvious test deals or require a non-test HubSpot flag.
  - Decide whether to dedupe multiple deals for the same company in the same week.
  - Decide whether `Event` and `PR` should count under Inbound/Outbound instead of Unknown.
