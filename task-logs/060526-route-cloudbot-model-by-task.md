# 060526 - Route Cloudbot Model By Task

## What Was Asked

The user asked to route the Truewind Slack Cloudbot between Opus and Sonnet based on task difficulty: Opus for high-thinking tasks, Sonnet for lower-thinking tasks.

## What Was Done

- Added model configuration constants in `scripts/slack/slack_bot.js`:
  - `CLAUDE_MODEL_DEFAULT` defaults to `claude-sonnet-4-6`.
  - `CLAUDE_MODEL_HIGH` defaults to `claude-opus-4-1-20250805`.
  - `CLAUDE_DIGEST_MODEL` defaults to the default/Sonnet model.
- Added a deterministic `selectClaudeModelForMessages` router.
- Routed Slack replies to Opus when the request is complex, long-context, multi-step, strategic, analytical, review-oriented, or otherwise likely to need higher reasoning.
- Routed simple/direct Slack replies to Sonnet.
- Left discovery digest extraction on its own model variable so transcript processing does not automatically use Opus unless explicitly configured.
- Updated `README.md` with the new Railway env vars.

## Decisions Made

- Used deterministic keyword/context routing instead of making an extra LLM call to classify the task.
- Kept Sonnet as the default to control cost and latency.
- Removed `CLAUDE_MODEL` from the high-model fallback chain so a stale Railway `CLAUDE_MODEL` variable cannot silently override Opus routing.
- The broad `plan` keyword was removed and the high-context default threshold was raised from 1800 to 3000 characters to reduce accidental Opus routing.

## Mistakes, Blockers, And Fixes

- The repo already had unrelated local Calendly webhook changes in `scripts/slack/slack_bot.js` and untracked Calendly files. These were not part of this task and should not be committed with this model-router change.

## What Was Learned

- The Cloudbot has two Anthropic call sites: Slack reply handling and discovery digest extraction.
- Routing all digest extraction to Opus would likely increase cost, so digest model selection should stay separate.

## Verification

- Ran `node --check scripts/slack/slack_bot.js`.
- Ran `npm test`; all visible tests passed, including pre-existing/new Calendly tests present in the dirty tree.
- Claude-backed review should be run before final commit/push if this task is completed in the same turn.

## Follow-Ups

- Push the model-router commit and verify Railway auto-deploy status.
- Consider adding explicit unit tests for the model routing helper once `slack_bot.js` is easier to import without starting the bot.
