# 060526 - Truewind HubSpot Prospect Workflow

## What Was Asked

The user asked to update the Slack Cloudbot backend so it can follow Truewind's HubSpot CRM process with less back-and-forth: enrich from email, create/update the contact first, create an MQL deal, associate contact/company/deal, convert the contact, and return real IDs.

## What Was Done

- Updated `scripts/slack/slack_bot.js`.
- Added `hubspot_push_truewind_prospect`, an end-to-end Claude tool for the Truewind prospect workflow.
- Added Firecrawl search-based LinkedIn enrichment with graceful fallback when Firecrawl is missing or failing.
- Added HubSpot helpers for contact search/update, company find/create, deal match/create, association writes, owner resolution, property metadata lookup, and partial-error reporting.
- Added Slack `channel_id` and `slack_user_id` metadata so the tool can authorize writes and resolve owners.
- Added write authorization for HubSpot mutations:
  - Slack tagger maps to a HubSpot owner by Slack email, or
  - Slack user ID is in `HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS`, or
  - Slack channel ID is in `HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS`.
- Updated the system prompt to steer HubSpot prospect/deal asks to the new backend tool.
- Updated `README.md` with required HubSpot/Firecrawl variables and optional Slack owner/write authorization variables.

## Decisions Made

- Implemented a single backend workflow tool instead of relying on Claude to manually sequence low-level HubSpot write tools.
- Existing contacts only get fields updated when the user explicitly supplied the field or the HubSpot field is blank, to avoid overwriting better CRM data with inferred values.
- Contact type defaults to the repo's existing Truewind convention, `Prospective Customer`, with `TRUEWIND_HUBSPOT_CONTACT_TYPE` as an override. The code still checks HubSpot property options before writing.
- LinkedIn URL writes prefer existing Truewind properties `linkedin___profile` and `hs_linkedin_url`, and include `linkedin_profile_url` only if HubSpot says it exists and is writable.
- Exact deal name plus pipeline is matched before creating a new deal, reducing duplicate deals on retries.
- Unauthorized write requests fail before HubSpot writes instead of relying on Claude prompt behavior.

## Mistakes, Blockers, And Fixes

- Initial implementation could overwrite existing contacts with inferred name/title/company data. Fixed by merging updates only into blank fields unless explicitly provided.
- Initial implementation set `lifecyclestage` and `hs_lead_status` before the deal/associations were complete. Fixed for existing contacts and final conversion now avoids downgrading later lifecycle stages.
- Initial Firecrawl network failures could abort the whole workflow. Fixed by catching Firecrawl request errors and falling back.
- Slack user email was initially appended into Claude-visible metadata. Fixed by keeping only Slack user ID in the prompt and resolving email inside the backend workflow.
- Reviewers flagged that any Slack user could trigger writes. Fixed with backend authorization based on mapped owner or allowlisted user/channel.
- Claude MCP stateless review failed due missing MCP credentials, so login-backed Claude Code was used for Claude review.

## What Was Learned

- This repo already uses `Prospective Customer` for `contact_type` and `linkedin___profile` / `hs_linkedin_url` for LinkedIn enrichment in `scripts/bdr_lead_pipeline.js`.
- Railway deployment still needs to be verified through GitHub deployment statuses after push because local Railway CLI is not linked to the production Truewind project.
- Firecrawl enrichment uses `/v1/search` with `scrapeOptions.formats=["markdown"]`, which can return enough scraped content for lightweight LinkedIn extraction without a separate scrape call.

## Verification

- `node --check scripts/slack/slack_bot.js`
- `npm test`
- `git diff --check`
- Reviewer passes:
  - Claude Code review approved after fixes.
  - Archimedes approved after write authorization was added.
  - Ampere approved after exact-deal matching was added.

## Follow-Ups

- Set `FIRECRAWL_API_KEY` in Railway if not already present.
- Ensure Slack has `users:read.email` if owner mapping should happen automatically by Slack email.
- Configure `HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS` or `HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS` if non-HubSpot-owner users should be able to trigger writes.
