# 170626 — "Tomorrow's calls" digest: flag closed-deal meetings instead of trusting them

## What was asked
The digest surfaced meetings on Closed/Lost deals (GRF, InfoGrate) and a cancelled
meeting (GRF), which made it untrustworthy. Mercedes's call: a closed deal shouldn't have
an upcoming meeting, so don't hide it — treat it as a red flag. Surface it to the rep with
an alarm ("Deal is closed — please check; it may have been cancelled"). If the meeting is
real, the rep still sees it; if it's a missed cancellation, the alarm prompts them to fix
it.

## What was done — `gtm-salesadmin-slack-bot`, branch `fix/sales-admin-postmeeting-cleanup`
File: `scripts/slack/sales_admin/workflow.js`, `tomorrowMeetingText`.
- When the meeting's associated deal is in a closed stage (`stageDecision.currentStageIsClosed`),
  show a `:rotating_light:` alarm line ("*<stage> — please check.* Deal is closed but a
  call is still on the calendar. Confirm this meeting is really happening; it may have been
  cancelled.") instead of the plain "Deal stage:" line.
- No-deal meetings get a quiet "_No deal attached._" note.
- Open-deal meetings unchanged.
- Test: `flags closed-deal meetings instead of hiding them`. 39/39 sales-admin tests pass.

## Decisions made
- **Flag, don't hide** closed-deal meetings (per Mercedes) — avoids suppressing a real
  meeting and turns the anomaly into an action prompt.
- This also covers the cancelled-GRF case in practice, since GRF is Closed/Lost → it now
  carries the alarm.

## Open questions / next steps
- **True cancellation detection for OPEN deals** still isn't solved — a meeting cancelled
  on Google Calendar for an open deal won't be caught, because this bot has no Google
  Calendar access and HubSpot's CalendarSync doesn't flip the meeting outcome/title. That
  needs adding Google Calendar API access (bigger; separate decision).
- Shipped together with the post-meeting cleanup in the same PR.
