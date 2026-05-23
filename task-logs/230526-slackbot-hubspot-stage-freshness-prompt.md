# 230526 - Slackbot HubSpot Stage Freshness Prompt

## What Was Asked

The user asked to update the Slackbot LLM system prompt so it consistently calls `hubspot_get_pipeline` before any HubSpot stage/status-related request and fetches fresh HubSpot data for every HubSpot question.

## What Was Done

- Updated `scripts/slack/slack_bot.js` prompt text with:
  - `HubSpot stage verification rule`
  - `Critical HubSpot data freshness`
- The stage rule requires `hubspot_get_pipeline` with `pipeline_id 105321581` at the start of requests involving:
  - deal stages, stage names, or stage movements;
  - pipeline summaries or deal counts by stage;
  - S1, S2, S3, S4, S5, MQL, SQL, POC, Proposal, Full Product Demo, Closed/Lost, Won, or similar stage shorthand;
  - "where is [deal name]", deal status, or current opportunity state.
- The freshness rule requires fresh relevant HubSpot API calls for every HubSpot question and forbids relying on prior answers or recent thread memory.
- Updated `scripts/slack/tests/slack_bot_hubspot.test.js` to assert the new prompt sections and all requested trigger categories.

## Decisions Made

- Kept this as a prompt/test-only change because `hubspot_get_pipeline` was already implemented and deployed.
- Replaced the weaker one-line pipeline-stage prompt guidance with a dedicated global section so it applies before the prospect workflow and deal-summary instructions.
- Included the stricter data freshness rule because the user explicitly preferred real-time correctness over avoiding extra HubSpot API calls.

## Mistakes, Blockers, And Fixes

- An independent reviewer approved the prompt content but flagged that tests did not assert every trigger category. Fixed by adding assertions for stage movements, pipeline summaries/counts by stage, and "where is [deal name]"/status/current-state prompts.
- No live HubSpot calls were made because this was a prompt-only change and no `leads-update/.env.local` exists for project-scoped local credentials.

## What Was Learned

- Prompt tests should cover each trigger category when the behavior is policy-driven rather than deterministic code.
- The freshness rule may increase HubSpot API calls in Slack follow-up threads, but that matches the requested reliability behavior.

## Verification

- `node --check scripts/slack/slack_bot.js`
- `node scripts/slack/tests/slack_bot_hubspot.test.js`
- `npm test`
- `git diff --check -- scripts/slack/slack_bot.js scripts/slack/tests/slack_bot_hubspot.test.js`
- Claude Code review approved the prompt/test diff.
- Two independent reviewer agents reviewed the diff; one flagged test coverage, and the final revised diff was approved.

## Follow-Ups

- Commit, push, and verify Railway auto-deploy for the prompt update.
