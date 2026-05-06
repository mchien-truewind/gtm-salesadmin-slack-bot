# 060526 - Set Slack Cloudbot To Opus

## What Was Asked

The user asked to set up the Truewind Railway Slack Claude bot to use Opus instead of Sonnet.

## What Was Done

- Checked official Anthropic model docs for the current Opus API model ID.
- Updated `scripts/slack/slack_bot.js` to define `CLAUDE_MODEL` from `process.env.CLAUDE_MODEL`, defaulting to `claude-opus-4-1-20250805`.
- Replaced both hard-coded `claude-sonnet-4-6` model strings with `CLAUDE_MODEL`.
- Updated `README.md` to document `ANTHROPIC_API_KEY` and `CLAUDE_MODEL` for the Railway Slack Cloudbot.

## Decisions Made

- Used the stable official Anthropic API model ID `claude-opus-4-1-20250805` rather than an alias.
- Made the model environment-configurable so Railway can override it without another code change.
- Applied the same model to both Slack replies and discovery digest extraction because the user asked to be on Opus.

## Mistakes, Blockers, And Fixes

- Railway CLI for this local account could not access/link the actual `mchien-truewind` Railway project, so the setup was done through code defaults and GitHub/Railway auto-deploy verification rather than direct Railway variable editing.

## What Was Learned

- The production Cloudbot previously had two direct Anthropic call sites, both hard-coded to Sonnet.
- Opus will increase API cost compared with Sonnet, especially for discovery digest transcript processing.

## Verification

- Ran `node --check scripts/slack/slack_bot.js`.
- Ran `npm test`; all 11 Node tests passed.
- Ran Claude-backed review through local Claude Code; it found no blockers.

## Follow-Ups

- After push, verify Railway auto-deploy status for the pushed commit.
- If cost becomes too high, split the model config into separate `CLAUDE_MODEL` and `CLAUDE_DIGEST_MODEL` variables.
