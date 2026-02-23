#!/usr/bin/env python3
import argparse
import os
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/calendar"]


def load_env_files() -> None:
    load_dotenv(".env.local")
    load_dotenv()


def resolve_path(env_var: str, default: str) -> Path:
    return Path(os.getenv(env_var, default)).expanduser().resolve()


def save_credentials(path: Path, creds: Credentials) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(creds.to_json(), encoding="utf-8")


def load_credentials(token_path: Path) -> Credentials | None:
    if not token_path.exists():
        return None

    creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        save_credentials(token_path, creds)

    return creds if creds.valid else None


def run_auth_flow(credentials_path: Path, token_path: Path) -> Credentials:
    if not credentials_path.exists():
        raise FileNotFoundError(
            f"Credentials file not found at {credentials_path}. "
            "Set GOOGLE_CALENDAR_CREDENTIALS_FILE or place the OAuth client JSON there."
        )

    flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), SCOPES)
    creds = flow.run_local_server(port=0)
    save_credentials(token_path, creds)
    return creds


def parse_datetime(value: str, timezone_name: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(timezone_name))
    return dt


def auth_cmd(args: argparse.Namespace) -> None:
    load_env_files()
    credentials_path = resolve_path(
        "GOOGLE_CALENDAR_CREDENTIALS_FILE", "secrets/google-calendar-credentials.json"
    )
    token_path = resolve_path("GOOGLE_CALENDAR_TOKEN_FILE", "secrets/google-calendar-token.json")
    run_auth_flow(credentials_path, token_path)
    print(f"OAuth token saved to: {token_path}")


def create_cmd(args: argparse.Namespace) -> None:
    load_env_files()
    credentials_path = resolve_path(
        "GOOGLE_CALENDAR_CREDENTIALS_FILE", "secrets/google-calendar-credentials.json"
    )
    token_path = resolve_path("GOOGLE_CALENDAR_TOKEN_FILE", "secrets/google-calendar-token.json")

    creds = load_credentials(token_path)
    if not creds:
        creds = run_auth_flow(credentials_path, token_path)

    timezone_name = args.timezone or os.getenv(
        "GOOGLE_CALENDAR_DEFAULT_TIMEZONE", "America/Los_Angeles"
    )
    start = parse_datetime(args.start, timezone_name)
    end = parse_datetime(args.end, timezone_name) if args.end else start + timedelta(minutes=args.duration_minutes)
    if end <= start:
        raise ValueError("End time must be after start time.")

    attendees = [{"email": email} for email in args.attendee]
    event = {
        "summary": args.title,
        "description": args.description or "",
        "location": args.location or "",
        "start": {"dateTime": start.isoformat(), "timeZone": timezone_name},
        "end": {"dateTime": end.isoformat(), "timeZone": timezone_name},
        "attendees": attendees,
    }

    conference_data_version = 0
    if args.with_meet:
        conference_data_version = 1
        event["conferenceData"] = {"createRequest": {"requestId": str(uuid4())}}

    service = build("calendar", "v3", credentials=creds)
    created = (
        service.events()
        .insert(
            calendarId=args.calendar_id,
            body=event,
            conferenceDataVersion=conference_data_version,
            sendUpdates=args.send_updates,
        )
        .execute()
    )

    print(f"Created: {created.get('summary', '(no title)')}")
    print(f"Event ID: {created.get('id')}")
    print(f"Link: {created.get('htmlLink')}")
    meet_url = None
    for entry in created.get("conferenceData", {}).get("entryPoints", []):
        if entry.get("entryPointType") == "video":
            meet_url = entry.get("uri")
            break
    if meet_url:
        print(f"Google Meet: {meet_url}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Google Calendar meeting helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth_parser = subparsers.add_parser("auth", help="Run OAuth and save token locally")
    auth_parser.set_defaults(func=auth_cmd)

    create_parser = subparsers.add_parser("create", help="Create a calendar meeting")
    create_parser.add_argument("--title", required=True, help="Meeting title")
    create_parser.add_argument(
        "--start",
        required=True,
        help="Start datetime in ISO format, e.g. 2026-02-25T14:00 or 2026-02-25T14:00-08:00",
    )
    create_parser.add_argument(
        "--end",
        help="End datetime in ISO format. Omit to use --duration-minutes.",
    )
    create_parser.add_argument(
        "--duration-minutes",
        type=int,
        default=30,
        help="Duration when --end is omitted (default: 30)",
    )
    create_parser.add_argument(
        "--timezone",
        help="IANA timezone for naive times, e.g. America/Los_Angeles",
    )
    create_parser.add_argument(
        "--attendee",
        action="append",
        default=[],
        help="Attendee email. Repeat flag for multiple attendees.",
    )
    create_parser.add_argument("--description", help="Description/agenda")
    create_parser.add_argument("--location", help="Location text")
    create_parser.add_argument(
        "--calendar-id",
        default=os.getenv("GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID", "primary"),
        help="Calendar ID (default: primary)",
    )
    create_parser.add_argument(
        "--send-updates",
        default=os.getenv("GOOGLE_CALENDAR_SEND_UPDATES", "all"),
        choices=["all", "externalOnly", "none"],
        help="Google notification behavior (default: all)",
    )
    create_parser.add_argument(
        "--with-meet",
        action="store_true",
        help="Create a Google Meet link for this event",
    )
    create_parser.set_defaults(func=create_cmd)

    return parser


def main() -> None:
    load_env_files()
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
