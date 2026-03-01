#!/usr/bin/env python3
import argparse
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
]
ACTION_KEYWORDS = (
    "action",
    "next",
    "follow up",
    "follow-up",
    "blocker",
    "decision",
    "owner",
    "risk",
    "ask",
)


@dataclass
class Meeting:
    title: str
    start_dt: datetime
    attendee_email: str
    attendee_name: str
    event_link: str


@dataclass
class DocCandidate:
    doc_id: str
    name: str


def load_env_files() -> None:
    load_dotenv(".env.local")
    load_dotenv()


def resolve_path(env_var: str, default: str) -> Path:
    return Path(os.getenv(env_var, default)).expanduser().resolve()


def ensure_token(credentials_path: Path, token_path: Path) -> Credentials:
    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), SCOPES)
            creds = flow.run_local_server(port=0)
        token_path.parent.mkdir(parents=True, exist_ok=True)
        token_path.write_text(creds.to_json(), encoding="utf-8")

    return creds


def parse_event_start(event: dict, tz_name: str) -> datetime | None:
    start = event.get("start", {})
    value = start.get("dateTime") or start.get("date")
    if not value:
        return None

    if "T" in value:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=ZoneInfo(tz_name))
        return dt

    return datetime.fromisoformat(value).replace(tzinfo=ZoneInfo(tz_name))


def normalize_token(value: str) -> list[str]:
    cleaned = re.sub(r"[^a-z0-9]+", " ", value.lower())
    return [t for t in cleaned.split() if len(t) > 2]


def pick_counterpart(event: dict) -> tuple[str, str] | tuple[None, None]:
    attendees = event.get("attendees", [])
    candidates = [a for a in attendees if not a.get("self")]
    if not candidates:
        return None, None

    for attendee in candidates:
        if attendee.get("resource"):
            continue
        email = attendee.get("email")
        if email:
            return email, attendee.get("displayName") or email.split("@")[0]

    email = candidates[0].get("email")
    if not email:
        return None, None
    return email, candidates[0].get("displayName") or email.split("@")[0]


def is_one_on_one_event(event: dict, counterpart_email: str) -> bool:
    title = (event.get("summary") or "").lower()
    if "1:1" in title or "1-1" in title or "one on one" in title:
        return True

    attendees = [a for a in event.get("attendees", []) if a.get("email")]
    non_self = [a for a in attendees if not a.get("self")]
    return len(non_self) == 1 and bool(counterpart_email)


def list_upcoming_meetings(calendar_service, tz_name: str, lookahead_hours: int) -> list[Meeting]:
    now = datetime.now(ZoneInfo(tz_name))
    horizon = now + timedelta(hours=lookahead_hours)

    events = (
        calendar_service.events()
        .list(
            calendarId=os.getenv("GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID", "primary"),
            timeMin=now.isoformat(),
            timeMax=horizon.isoformat(),
            singleEvents=True,
            orderBy="startTime",
            maxResults=100,
        )
        .execute()
        .get("items", [])
    )

    meetings: list[Meeting] = []
    for event in events:
        counterpart_email, counterpart_name = pick_counterpart(event)
        if not counterpart_email:
            continue
        if not is_one_on_one_event(event, counterpart_email):
            continue

        start_dt = parse_event_start(event, tz_name)
        if not start_dt:
            continue

        meetings.append(
            Meeting(
                title=event.get("summary") or "(untitled)",
                start_dt=start_dt,
                attendee_email=counterpart_email,
                attendee_name=counterpart_name,
                event_link=event.get("htmlLink") or "",
            )
        )

    return meetings


def list_one_on_one_docs(drive_service) -> list[DocCandidate]:
    files = (
        drive_service.files()
        .list(
            q="mimeType='application/vnd.google-apps.document' and trashed=false",
            pageSize=200,
            fields="files(id,name)",
            orderBy="modifiedTime desc",
        )
        .execute()
        .get("files", [])
    )

    docs = []
    for item in files:
        name = item.get("name", "")
        lowered = name.lower()
        if "1:1" in lowered or "1-1" in lowered or "one on one" in lowered:
            docs.append(DocCandidate(doc_id=item["id"], name=name))
    return docs


def score_doc_for_person(doc_name: str, person_name: str, person_email: str) -> int:
    tokens = normalize_token(person_name)
    tokens.extend(normalize_token(person_email.split("@")[0]))
    title = doc_name.lower()

    token_hits = sum(1 for token in set(tokens) if token in title)
    if token_hits == 0:
        return 0

    score = token_hits * 3
    if "1:1" in title or "1-1" in title:
        score += 2
    return score


def pick_matching_doc(meeting: Meeting, docs: list[DocCandidate]) -> DocCandidate | None:
    scored = []
    for doc in docs:
        score = score_doc_for_person(doc.name, meeting.attendee_name, meeting.attendee_email)
        if score > 0:
            scored.append((score, doc))
    if not scored:
        return None
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1]


def extract_lines_from_structural(elements: list[dict]) -> list[str]:
    lines: list[str] = []

    for element in elements:
        paragraph = element.get("paragraph")
        if paragraph:
            chunks = []
            for pe in paragraph.get("elements", []):
                text = pe.get("textRun", {}).get("content", "")
                if text:
                    chunks.append(text)
            text = "".join(chunks).strip()
            if text:
                lines.extend([ln.strip() for ln in text.splitlines() if ln.strip()])

        table = element.get("table")
        if table:
            for row in table.get("tableRows", []):
                for cell in row.get("tableCells", []):
                    lines.extend(extract_lines_from_structural(cell.get("content", [])))

        toc = element.get("tableOfContents")
        if toc:
            lines.extend(extract_lines_from_structural(toc.get("content", [])))

    return lines


def extract_focus_lines(lines: list[str], limit: int) -> list[str]:
    if not lines:
        return []

    recent = lines[-180:]
    candidates = []

    for line in recent:
        lower = line.lower()
        score = 0
        if re.search(r"(^|\s)(\[\s\]|☐)(\s|$)", line):
            score += 6
        if any(keyword in lower for keyword in ACTION_KEYWORDS):
            score += 4
        if line.startswith("-") or line.startswith("*"):
            score += 2
        if 12 <= len(line) <= 220:
            score += 1
        if score > 0:
            candidates.append((score, line))

    if not candidates:
        tail = [ln for ln in recent if ln]
        return tail[-limit:]

    seen = set()
    ordered = sorted(candidates, key=lambda x: x[0], reverse=True)
    result = []
    for _, line in ordered:
        key = line.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(line)
        if len(result) >= limit:
            break
    return result


def render_brief(meeting: Meeting, doc: DocCandidate | None, focus_lines: list[str], tz_name: str) -> str:
    start_local = meeting.start_dt.astimezone(ZoneInfo(tz_name)).strftime("%a %b %d, %I:%M %p %Z")

    out = []
    out.append(f"## {meeting.attendee_name} ({meeting.attendee_email})")
    out.append(f"- Meeting: {meeting.title}")
    out.append(f"- Time: {start_local}")
    if meeting.event_link:
        out.append(f"- Calendar: {meeting.event_link}")
    if doc:
        out.append(f"- 1:1 Doc: {doc.name}")
        out.append(f"- Doc URL: https://docs.google.com/document/d/{doc.doc_id}/edit")
    else:
        out.append("- 1:1 Doc: [not found]")

    if focus_lines:
        out.append("- Focus:")
        for line in focus_lines:
            out.append(f"  - {line}")
    else:
        out.append("- Focus: [No actionable lines found; review doc latest section manually]")

    return "\n".join(out)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Pre-meeting 1:1 focus brief generator")
    parser.add_argument(
        "--lookahead-hours",
        type=int,
        default=int(os.getenv("GOOGLE_BRIEF_LOOKAHEAD_HOURS", "168")),
        help="How far ahead to scan calendar events (default: 168)",
    )
    parser.add_argument(
        "--max-focus-items",
        type=int,
        default=int(os.getenv("GOOGLE_BRIEF_MAX_ITEMS", "5")),
        help="Max focus bullets per person (default: 5)",
    )
    parser.add_argument(
        "--timezone",
        default=os.getenv("GOOGLE_CALENDAR_DEFAULT_TIMEZONE", "America/Los_Angeles"),
        help="Timezone used for output",
    )
    return parser


def main() -> None:
    load_env_files()
    args = build_parser().parse_args()

    credentials_path = resolve_path(
        "GOOGLE_WORKSPACE_CREDENTIALS_FILE",
        os.getenv("GOOGLE_CALENDAR_CREDENTIALS_FILE", "secrets/google-calendar-credentials.json"),
    )
    token_path = resolve_path(
        "GOOGLE_WORKSPACE_TOKEN_FILE",
        "secrets/google-workspace-token.json",
    )

    creds = ensure_token(credentials_path, token_path)
    calendar_service = build("calendar", "v3", credentials=creds)
    drive_service = build("drive", "v3", credentials=creds)
    docs_service = build("docs", "v1", credentials=creds)

    meetings = list_upcoming_meetings(calendar_service, args.timezone, args.lookahead_hours)
    if not meetings:
        print("No upcoming 1:1 meetings found in lookahead window.")
        return

    docs = list_one_on_one_docs(drive_service)
    briefs = []
    for meeting in meetings:
        match = pick_matching_doc(meeting, docs)
        focus_lines = []
        if match:
            doc = docs_service.documents().get(documentId=match.doc_id).execute()
            lines = extract_lines_from_structural(doc.get("body", {}).get("content", []))
            focus_lines = extract_focus_lines(lines, args.max_focus_items)
        briefs.append(render_brief(meeting, match, focus_lines, args.timezone))

    print("\n\n".join(briefs))


if __name__ == "__main__":
    main()
