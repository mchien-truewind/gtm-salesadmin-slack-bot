# 220526 - Slackbot GTM HubSpot Owner Auth

## What Was Asked

Add GTM team members to the Slackbot HubSpot write authorization mapping so they can create/update HubSpot records through the AI assistant. The request required Slack user ID to HubSpot owner ID mappings for Jenilee Chen, Brendan Moody, Xavier Marco, Sarah Elix, Alex Lee, Amy Vetter, and requesting user `U0ABULY5TEK`.

## What Was Done

- Updated `scripts/slack/slack_bot.js`.
- Added `DEFAULT_SLACK_TO_HUBSPOT_OWNER`, merged under any env-provided `SLACK_TO_HUBSPOT_OWNER_JSON` overrides.
- Added built-in mappings:
  - `U0ATZSNCE5T` -> Jenilee Chen `91143842`
  - `U0AURH4KMRN` -> Brendan Moody `91143844`
  - `U0AKMHVCJMA` -> Xavier Marco `89305622`
  - `U09QC3B292R` -> Sarah Elix `84547076`
  - `U04BPMPR29G` -> Alex Lee `559564379`
  - `U0B4MRN83FE` -> Amy Vetter `92555980`
  - `U0ABULY5TEK` -> Mercedes Chien `87811681`
- Added Brendan Moody and Amy Vetter to `TRUEWIND_HUBSPOT.ownersByName` so explicit owner names resolve.
- Updated the Slackbot system prompt's owner ID reference list with Brendan and Amy.
- Updated `scripts/slack/tests/slack_bot_hubspot.test.js` to assert all requested mappings resolve to the expected owner and authorize HubSpot writes.

## Decisions Made

- Used a built-in default mapping instead of requiring Railway/env changes for known GTM users. This keeps production behavior available from code while preserving the existing env JSON override mechanism.
- Kept authorization tied to exact Slack user IDs. No broad channel-level authorization was added.
- Mapped requester `U0ABULY5TEK` to Mercedes Chien owner ID `87811681`, matching prior Slack identity and existing HubSpot owner alias.

## Mistakes, Blockers, And Fixes

- The project-local `.env.local` did not contain a Slack token, so Slack `users.list` could not be called locally. Slack user IDs were found from existing repo task logs and Slack search context instead.
- HubSpot owner IDs for Brendan and Amy were verified through the project-local HubSpot token in `/Users/mc/projects/truewind/.env.local`. Brendan is `91143844`; Amy's owner record returned email `amy@trytruewind.com` with owner ID `92555980` and blank first/last name, so code uses display name `Amy Vetter`.
- Initial subagent spawn with explicit `agent_type` plus `fork_context` was rejected by the tool. Retried with full-context default agents.

## What Was Learned

- Slack IDs found/confirmed:
  - Xavier Marco `U0AKMHVCJMA`
  - Sarah Elix `U09QC3B292R`
  - Jenilee Chen `U0ATZSNCE5T`
  - Alex Lee `U04BPMPR29G`
  - Brendan Moody `U0AURH4KMRN`
  - Amy Vetter `U0B4MRN83FE`
  - Mercedes/requester `U0ABULY5TEK`
- `SLACK_TO_HUBSPOT_OWNER` should continue to merge defaults first and env config second, so runtime overrides win.

## Verification

- `git fetch --all --prune`
- HubSpot owner lookup against project-local `.env.local`
- Slack search context for missing Slack IDs
- `node --check scripts/slack/slack_bot.js`
- `node scripts/slack/tests/slack_bot_hubspot.test.js`
- `git diff --check -- scripts/slack/slack_bot.js scripts/slack/tests/slack_bot_hubspot.test.js`
- Claude Code review approved with no blockers.
- Two independent reviewer agents approved with no code blockers. Their caveat that they could not independently live-verify HubSpot owner IDs was resolved by the parent session's earlier project-local HubSpot API lookup.

## Follow-Ups

- Deploy/restart the Slackbot service so the new built-in mappings are active in production.
