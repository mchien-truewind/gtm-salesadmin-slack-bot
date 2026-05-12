# 120526 - Add Slack Bot Accuracy Instruction

## What Was Asked

The user said the Mercedes/Claude Slack bot makes things up and asked to add a strict instruction forbidding fabrication, hallucination, and unsupported claims. They also asked to locate the code powering the bot.

## What Was Done

- Located the production Railway Slack Claude bot in `scripts/slack/slack_bot.js`.
- Confirmed the system prompt is built by `getSystemPrompt()`.
- Added a new top-level `## Accuracy` section near the start of the system prompt:
  - Never fabricate, hallucinate, or invent information.
  - Say "I don't know" or "I don't have that information" when there is no tool output or explicit context.
  - Do not fill gaps with plausible details.
  - State exactly what is missing and why when required data is unavailable.

## Decisions Made

- Placed the instruction near the top of the prompt so it applies globally before task-specific rules.
- Left the existing tool-use and API-result instructions in place because they are compatible with the new accuracy rule.

## Mistakes, Blockers, And Fixes

- The repo was initially on the previous merged PR branch with a local modified task log. Stashed that task-log edit and created a new branch from `origin/main` to keep this change clean.

## What Was Learned

- The Slack bot production path is `npm start` -> `node scripts/slack/slack_bot.js`.
- The runtime system prompt is in `getSystemPrompt()` in that same file.

## Verification

- `node -c scripts/slack/slack_bot.js` passed.
- `npm test -- --test-reporter=spec` passed: 13 tests, 13 passing.
- Three independent Claude reviews returned `NO BLOCKERS`.

## Follow-Ups

- Merge and deploy the PR so Railway restarts the bot with the updated system prompt.
