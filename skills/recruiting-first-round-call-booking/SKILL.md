---
name: recruiting-first-round-call-booking
description: Book recruiting first-round calls using Gmail thread subjects and Google Calendar invites with Meet links. Use when the user asks to book or schedule a recruiting first-round interview call. If the user asks to book a call but does not clearly say whether it is recruiting first-round, ask for confirmation before taking any booking action.
---

# Recruiting First-Round Call Booking

## Core Rules

- Ask first when unclear: `Is this a recruiting first-round call?`
- If user says it is not recruiting first-round, stop this skill and follow the normal booking workflow.
- Before creating anything, confirm the exact actions you will take and wait for explicit user confirmation.
- Never send emails in this workflow. Create drafts only.

## Standard Workflow

1. Confirm recruiting scope
- If the request is ambiguous, ask whether it is a recruiting first-round call.
- Continue only after a clear `yes`.

2. Verify tool access and runtime
- Confirm access to `/Users/richardwei/agentic-lite`.
- Use this Python runtime for Google API commands: `/Users/richardwei/agentic-lite/.venv/bin/python`.

3. Read Gmail thread first
- Find the latest thread involving the target email (`from:` or `to:` match).
- Report access status and the exact subject line to the user before creating the calendar event.

4. Build event title from subject
- Remove `[hiring@]` token.
- Remove leading reply prefixes like `Re:` and `Fwd:`.
- Trim whitespace.
- Keep the candidate/interview label text intact.

5. Create calendar invite
- Use the user-provided date/time and timezone.
- If user gives relative time (`Wednesday 1:50pm`), convert to an absolute date and state it explicitly before creation.
- Include attendee email.
- Include Google Meet link (`--with-meet`).
- Use a 20-minute duration unless the user specifies a different duration.

6. Create confirmation email draft (do not send)
- Create a Gmail draft in the same thread when possible.
- Use singular voice (`I`, not `we`).
- Include timezone label after the time (example: `1:50 PM PST`).
- Suggested body template:

```text
Hi {{first_name}},

I scheduled a time on {{weekday}} at {{time_with_tz}}. Let me know if it doesn't work for you and we can adjust.

Best,
Mercedes
```

7. Report results
- Return event title, event ID, event link, Meet link, and exact start/end with timezone.
- Return draft ID and thread ID.
- Confirm explicitly that the email is a draft and was not sent.

## Command Hints (Richard Workspace)

- Calendar create helper: `/Users/richardwei/Documents/New project/scripts/google_calendar/calendar_cli.py`
- Gmail draft helper: `/Users/richardwei/Documents/New project/scripts/google_gmail/gmail_cli.py`
- Credential defaults are often under `/Users/richardwei/Documents/New project/secrets/` or `/Users/richardwei/agentic-lite/secrets/`.
- If one location is missing credentials, retry with explicit `GOOGLE_*_CREDENTIALS_FILE` and `GOOGLE_*_TOKEN_FILE` env vars.
