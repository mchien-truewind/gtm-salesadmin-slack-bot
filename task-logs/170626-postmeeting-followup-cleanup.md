# 170626 — Slim down the sales-admin post-meeting follow-up message

## What was asked
The post-meeting follow-up Slack message was too text-heavy to be useful. Wanted:
- No Grain recording → a short "Doesn't look like they showed up. Mark as confirmed
  no-show in HubSpot." prompt.
- On No-Show: add a "no-show" note to the deal AND set the HubSpot meeting outcome to
  No-Show.
- Remove the "Suggested follow-up from Grain" section.
- Keep the HubSpot Next Step action item and the deal-stage dropdown (confirmed).
- Overall: make it digestible.

## What was done — repo `gtm-salesadmin-slack-bot`, branch `fix/sales-admin-postmeeting-cleanup`
File: `scripts/slack/sales_admin/workflow.js` (+ `hubspot_sales_admin.js`).
- `buildPostMeetingBlocks` split by case:
  - **No-show (no recording):** minimal — one line ("*Company — Contact*\nDoesn't look
    like they showed up (no Grain recording). Mark as a confirmed *No-Show* in
    HubSpot?"), context line, action buttons. No stage / next-step / Grain blocks.
  - **Completed:** keeps the deal-stage dropdown and HubSpot Next Step; the "Suggested
    follow-up from Grain" block is removed.
- Added `HubSpotSalesAdminClient.updateMeetingOutcome(meetingId, outcome)`.
- `writeMeetingOutcome`: on no-show, sets the meeting `hs_meeting_outcome` to `NO_SHOW`
  and records it in the deal note (which already carries "Outcome: No show").
- Tests: updated the two block tests to the new layout, added a no-show test asserting
  the meeting outcome is set, the note says no-show, and stage/next-step are NOT touched.
  All 38 sales-admin tests pass.

## Decisions made
- Keep the stage dropdown on the completed message (confirmed).
- Set the meeting HubSpot outcome to No-Show in addition to the note (confirmed).
- Note still records detail for audit; only the Slack message was slimmed.

## Open questions / next steps
- **Separate issue still to fix — the "Tomorrow's calls" digest** shows (a) cancelled
  meetings and (b) Closed/Lost-deal meetings. Root cause: the digest sources meetings
  from HubSpot (`searchMeetingsForOwnerBetween`), so Google-Calendar cancellations aren't
  reflected (`classifyMeetingStatus` only checks HubSpot outcome/title), and there is no
  deal-stage filter at all. Needs: a closed-stage/no-active-deal filter, and a decision
  on how to detect calendar cancellations (HubSpot-only vs cross-checking Google
  Calendar). Not in this PR.
- Pre-existing: `scripts/slack/tests/slack_bot_hubspot.test.js` fails on clean `main`
  (unrelated to this change).
