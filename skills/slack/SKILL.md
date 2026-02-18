---
name: slack
description: Send Slack messages via chat.postMessage using the declared Slack purpose and channel registry.
---

# Slack message get-started (summary)

- Only post when a workflow/SOP declares `Slack purpose: <taxon>`.
- Map purpose → channel + format via `docs/instructions/communication-with-slack-api.md`.
- Resolve the channel ID (not name) in `docs/instructions/slack-channels.md`.
- Ensure credentials are loaded:
  - `source "$AGENTIC_HOME/scripts/core/load-env-local.sh"`
  - verify `echo $SLACK_BOT_TOKEN` is non-empty.
- Required scopes: `chat:write` (plus `chat:write.public` if posting to channels the bot is not a member of).
- Post using `chat.postMessage`:
  ```bash
  curl -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-type: application/json; charset=utf-8" \
    -d '{"channel":"<channel-id>","text":"<message>"}'
  ```
- Confirm the response contains `{ "ok": true }`. If `{ "ok": false }`, stop and report the error.
- Log the ping (channel, timestamp, ask) in the task log.

## References
- `$AGENTIC_HOME/docs/instructions/communication-with-slack-api.md`
- `$AGENTIC_HOME/docs/instructions/slack-channels.md`
