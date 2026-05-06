# 060526 - Fix HubSpot Create Contact ID

## What Was Asked

The user reported that the Truewind Slack Cloudbot tool `hubspot_create_contact` created HubSpot contacts successfully but returned an undefined contact ID, producing URLs like `/record/0-1/undefined`. The user asked to find the related code and fix it.

## What Was Done

- Cloned and used the Truewind repo at `/Users/mc/projects/truewind/leads-update`.
- Found the exact tool implementation in `scripts/slack/slack_bot.js`.
- Updated `hubspotRequest` so it parses JSON responses into a known value, treats empty bodies as `{}`, and rejects non-2xx HubSpot responses instead of letting error payloads flow through as successful results.
- Added `requireHubSpotObjectId` and `formatHubSpotObjectResponse` helpers.
- Updated `hubspot_create_contact` to return a response with an explicit top-level `id`, `hubspot_id`, `url`, and `properties`.
- Reused the same formatter for HubSpot contact/deal create/update write tools so they do not build record URLs from missing IDs.
- Encoded contact/deal IDs in update paths.
- Committed and pushed the fix to `main` as `33e02dd`.
- Verified GitHub reported a successful Railway production deployment for commit `33e02dd`.
- Added an `AGENTS.md` rule to verify Railway auto-deploy status after future Slack/Claude bot runtime pushes.

## Decisions Made

- Kept the existing HubSpot portal ID in generated URLs because it was already present in the bot.
- Made missing IDs a hard tool error instead of returning `/undefined`; this prevents the bot from claiming success without a usable record ID.
- Left `hubspot_create_association` unchanged because it is a separate association call and does not construct contact/deal record URLs.

## Mistakes, Blockers, And Fixes

- A broader local search initially looked outside Truewind and found unrelated Revve code. The user clarified not to touch Revve. No Revve files were edited, and all implementation work was limited to `/Users/mc/projects/truewind/leads-update`.
- The first patch attempt missed an insertion context due to a different section label in the file. Re-read exact line numbers and applied the patch cleanly.

## What Was Learned

- The Truewind Cloudbot lives in `scripts/slack/slack_bot.js`.
- `hubspot_create_contact` is not a database-configured external tool in this repo; it is a local Claude tool definition plus executor branch.
- The old implementation parsed HubSpot responses but did not reject non-2xx responses or validate `res.id`, so malformed/error responses could become undefined URLs.

## Verification

- Ran `git fetch --all --prune` at the start of work in the cloned repo.
- Ran `node --check scripts/slack/slack_bot.js`.
- Ran `npm test`; all 11 Node tests passed.
- Ran a Claude-backed code review through local Claude Code. It found no blockers and agreed the fix addresses the reported undefined-ID behavior.
- Checked GitHub deployments for `mchien-truewind/leads-update`; deployment `4601751859` for `33e02dd` reached `success` at `2026-05-06T22:22:16Z` in `mchien-truewind / production`.

## Follow-Ups

- No manual restart is needed for this fix because Railway auto-deploy succeeded for the pushed commit.
- If desired, later replace the hardcoded HubSpot portal ID with an environment variable.
