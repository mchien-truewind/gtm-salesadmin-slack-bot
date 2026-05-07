# 070526 - Post Source Cleanup To GTM General

## What Was Asked

Post the latest deal-source cleanup ask into `#gtm-general`.

## What Was Done

- Queried current Unknown deals using the production progress-report logic:
  - current week by deal `createdate`
  - active pipeline `105321581`
  - skip obvious test/internal deals
  - dedupe normalized deal names
  - include only deals classified as Unknown
- Resolved HubSpot owners to Slack users via `users.list`.
- Posted the ask in `#gtm-general` (`C08GM9QL7QC`) at timestamp `1778170225.557819`.
- Tagged:
  - Xavier Marco (`U0AKMHVCJMA`) for 8 deals
  - Sarah Elix (`U09QC3B292R`) for 3 deals
  - Jenilee Chen (`U0ATZSNCE5T`) for 1 deal

## Decisions Made

- Posted directly in the main channel rather than the earlier `#slack-testing` thread because the user approved moving this workflow to `#gtm-general`.
- Kept the reply format as `Deal ID: Source` so replies can be parsed and used for HubSpot updates.

## Mistakes, Blockers, And Fixes

- No blocker occurred in this run.
- The known Slack limitation remains: the bot token lacks `users:read.email`, so owner mapping used real-name lookup from `users.list`.

## What Was Learned

- `#gtm-general` channel ID is `C08GM9QL7QC`.
- The latest Unknown deal count remained 12 at posting time.

## Verification

- Slack `chat.postMessage` returned success with timestamp `1778170225.557819`.
- Claude reviewed the completed operational action and found no blockers.

## Follow-Ups

- Monitor the Slack thread for `Deal ID: Source` replies.
- Update HubSpot `deal_source` values after owners respond.
