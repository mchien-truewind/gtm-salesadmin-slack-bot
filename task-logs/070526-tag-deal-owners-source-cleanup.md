# 070526 - Tag Deal Owners For Source Cleanup

## What Was Asked

Tag the deal owners in Slack and ask them to provide the correct `deal_source` values for Unknown deals so HubSpot can be updated.

## What Was Done

- Queried HubSpot using the current production progress-report logic:
  - current week by deal `createdate`
  - active pipeline `105321581`
  - skip obvious test/internal deals
  - dedupe normalized deal names
  - keep only deals classified as Unknown
- Grouped 12 Unknown deals by HubSpot owner:
  - Xavier Marco: 8 deals
  - Sarah Elix: 3 deals
  - Jenilee Chen: 1 deal
- Posted the grouped ask in `#slack-testing`.
- Slack email lookup failed because the Railway bot token does not include `users:read.email`.
- Resolved Slack IDs through `users.list` real-name matching:
  - Xavier Marco: `U0AKMHVCJMA`
  - Sarah Elix: `U09QC3B292R`
  - Jenilee Chen: `U0ATZSNCE5T`
- Added a threaded follow-up tagging those users directly.

## Decisions Made

- Used `#slack-testing` because the report workflow is currently being tested there.
- Used name-based Slack lookup as a one-off fallback because `users:read.email` is not available on the bot token.

## Mistakes, Blockers, And Fixes

- Initial post listed owner names/emails but did not tag users because `users.lookupByEmail` returned `missing_scope`.
- Fixed by using `users.list` and posting a threaded follow-up with direct Slack mentions.

## What Was Learned

- The Slack bot token currently has `users:read` but not `users:read.email`.
- If this owner-tagging workflow becomes recurring, add `users:read.email` to the Slack app and reinstall/refresh the bot token so HubSpot owner email can map reliably to Slack user IDs.

## Verification

- Slack post succeeded in channel `C066P0YFF6Z` (`#slack-testing`) at timestamp `1778169399.099739`.
- Tagged follow-up succeeded in the same thread at timestamp `1778169447.166259`.
- Claude reviewed the completed operational action and found no blockers.

## Follow-Ups

- Watch the thread for owner replies with `Deal ID: Source`.
- After replies arrive, update the corresponding HubSpot deal `deal_source` values.
- Consider posting the same ask in a production channel if owners do not monitor `#slack-testing`.
