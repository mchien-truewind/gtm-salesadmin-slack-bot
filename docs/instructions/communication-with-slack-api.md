---
summary: "When an instruction says \"ask for PR review in Slack,\" post the PR link with simple message like \"can I get a review? <PR link>\" to `engineering` (`#engineering`, channel `C05GRNTBUDN`) via `chat.postMessage`. Use `chat.postMessage` so every escalation, review ask, and FYI is auditable and attributed."
read_when:
  - You are doing work that requires the Communication with Slack API process.
  - You want the canonical steps/checklist for this workflow.
title: "Communication with Slack API"
---

# Communication with Slack API

Use `chat.postMessage` so every escalation, review ask, and accountant update is auditable and attributed.

Execution: use the `slack` skill for step-by-step posting. This SOP defines purpose, channel, and format policy.

## Purpose taxonomy (workflow-declared)
Any workflow/SOP that requires a Slack message must declare a single purpose using one of these tokens:
- `pr_review_request`
- `acct_workbook_update`
- `incident_escalation`
- `decision_blocker`

## Workflow/SOP declaration rules
- Each Slack-relevant section must include a line: `Slack purpose: <taxon>`.
- If a workflow has multiple Slack messages, each message section must declare its own purpose.
- If the purpose is missing or ambiguous, ask before posting.
- If the workflow/SOP provides a specific Slack format, that format overrides the defaults in this SOP.

## Purpose-based channel selection
| Purpose | Channel alias | Default format |
| --- | --- | --- |
| `pr_review_request` | `engineering` | PR review request format |
| `acct_workbook_update` | `acct-firm-fr-fo` | Accountant workbook update format |
| `incident_escalation` | `escalations-dev` | Incident summary format |
| `decision_blocker` | `tenn` | Decision ask format |

Channel IDs live in `docs/instructions/slack-channels.md`.

## PR review request format (engineering)
Required content:
- PR link
- One-line summary of change
- Specific ask and any deadline (optional `@eng` if a broadcast is needed)

Example:
```
PR review: https://github.com/ORG/REPO/pull/123 — Fix reconciliation gate ordering. Can someone review today? @eng
```

If DMing a random `@eng` reviewer, use the roster in `docs/instructions/slack-channels.md` and exclude Tennison by default.

## Accountant workbook update format (FR/FO)
Channel + format rules (non-negotiable):
- Use `acct-firm-fr-fo` for all accountant workbook updates.
- Post only after validation gates pass and the variance report is clean.
- Use the exact 4-line format below with no extra lines.
- Line 1 must include the exact workbook filename as delivered in `outputs/` (optional `Update: ` prefix allowed).
- Line 2 must be the exact GDrive URL for that workbook.
- Line 3 must be a short accounting-focused description of the change (<= 160 characters).
- Line 4 must include tags. If tags are not provided, default to `@Melody @kurt`.
- Use the `Update: ` prefix only when reposting a corrected workbook; otherwise omit it.

4-line format (must be exact):
```
{file name}
{gdrive url}
{short description for the fix or changes from accounting perspective}
{tag names}
```

Example:
```
Update: `ford-202507-wfb-0248-3521`
https://docs.google.com/spreadsheets/d/1cyag3lV3yQFovDdcGvb6fvGE4_Fopl6q/edit
Rerun WFB 0248 workbook with partnership distributions split to GL 44450 and GL 90000 suppressed in reconciliation.
@Melody @kurt
```

Pre-send checklist (required):
1. Confirm this is an accountant workbook update (not an internal status update).
2. Confirm channel alias is `acct-firm-fr-fo` and the ID matches `docs/instructions/slack-channels.md`.
3. Confirm line 1 contains the delivered workbook filename from `outputs/` and matches `{client}-{YYYYMM}-{broker}-{account}-{hash}.xlsx` exactly.
4. Confirm the GDrive URL opens a Google Sheet and the file name matches line 1.
5. Confirm the description is accounting-focused, single-line, and <= 160 characters.
6. Confirm tags resolve in Slack (`@Melody @kurt` if none provided).
7. Check the last 10 channel messages to avoid duplicate filename+URL posts.
8. Send via `chat.postMessage` and verify `{ "ok": true }`.
9. If `{ "ok": false }`, do not retry; report the error and request guidance.
10. Log the Slack post (channel + timestamp) in the task log.

## Incident summary format (escalations-dev)
Required content:
- What happened and current impact
- Systems or customers affected
- Current status and next update time
- Link to any incident thread or ticket

## Decision ask format (tenn)
Required content:
- Task reference (task log name or branch)
- Decision needed and options
- Recommended option and risk if delayed
- Deadline or impact window

## How to send
1. Draft text with the required format for the chosen purpose.
2. Send with the bot token:
   ```bash
   curl -X POST https://slack.com/api/chat.postMessage \
     -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
     -H "Content-type: application/json; charset=utf-8" \
     -d '{"channel":"<channel-id>","text":"PR review: <PR link> — <one-line summary>. Can someone review today?"}'
   ```
3. Confirm `{ "ok": true }`. If not, fix auth/config before assuming it sent.
4. Log the ping (channel, timestamp, ask) in `$AGENTIC_HOME/docs/tasks/...` or your next agent response.

## When to message
- PR review requests for active pull requests.
- Accountant workbook updates per the FR/FO reconciliation SOP rules.
- Blockers on tooling/creds (`gh auth`, required secrets) or choices with material trade-offs.
- Pausing a task ≥30 minutes awaiting guidance, or risk of missing a deadline.
- Production/customer-impacting incidents or CS escalations.

## Avoid
- Routine status updates or questions answered in repo docs.
- FYIs with no action required (unless explicitly requested).
- Posting accountant updates in `engineering` or PR reviews in `acct-firm-fr-fo`.

## Checklist
- [ ] Identify the purpose from the workflow/SOP and match it to the correct channel.
- [ ] Use the required format (workflow-provided first, otherwise defaults above).
- [ ] Send via `chat.postMessage` using `SLACK_BOT_TOKEN` (not a manual Slack UI post).
- [ ] Verify the API response contains `{ "ok": true }`.
- [ ] Log the ping (channel, timestamp, ask) in `$AGENTIC_HOME/docs/tasks/...` or the next agent response.
