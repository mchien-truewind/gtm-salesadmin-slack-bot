#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import parseaddr
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:  # pragma: no cover - fallback for partial envs
    def load_dotenv(*_args, **_kwargs):  # type: ignore[no-redef]
        return False


SCOPES = [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly",
]

AUTO_KEYWORDS = [
    "welcome",
    "thanks for subscribing",
    "thank you for subscribing",
    "subscription confirmed",
    "confirm your email",
    "verify your email",
    "activate your account",
    "day 1",
    "getting started",
    "automated message",
    "do not reply",
    "donotreply",
]

MARKETING_KEYWORDS = [
    "newsletter",
    "join us",
    "fireside chat",
    "webinar",
    "register now",
    "event",
    "limited time",
    "product update",
    "announcement",
    "book more meetings",
]

CONFERENCE_STRONG_KEYWORDS = [
    "conference",
    "summit",
    "expo",
    "fireside chat",
    "sponsor",
    "sponsorship",
    "booth",
    "speaking slot",
    "keynote",
    "panel",
    "event organizer",
    "registration",
]

CONFERENCE_CONTEXT_KEYWORDS = [
    "attend",
    "attendee",
    "speaker",
    "speaking",
    "agenda",
    "venue",
    "ticket",
    "exhibitor",
    "forum",
    "roadshow",
    "trade show",
    "conference pass",
]

NON_CONFERENCE_GUARD_TERMS = [
    "[hiring@]",
    "growth generalist",
    "growth bdr",
    "interview",
    "candidate",
    "roleplay",
    "calendar invite",
]

SCHEDULING_KEYWORDS = [
    "schedule",
    "availability",
    "available",
    "calendar",
    "meeting",
    "time works",
    "book",
]

CONFIRMATION_KEYWORDS = [
    "works for me",
    "sounds good",
    "yes",
    "confirmed",
    "great",
    "perfect",
]

FEEDBACK_REQUEST_KEYWORDS = [
    "any feedback",
    "share feedback",
    "could you share feedback",
    "can you share feedback",
    "would love feedback",
    "why",
    "why not",
    "not selected",
    "didn't get chosen",
    "did not get chosen",
    "wasn't selected",
    "was not selected",
    "what was missing",
    "what can i improve",
    "areas to improve",
]

REJECTION_MARKERS = [
    "won't be moving forward",
    "will not be moving forward",
    "not moving forward with your application",
    "after careful consideration",
]

CLOSEOUT_ACK_KEYWORDS = [
    "thanks for the feedback",
    "totally agree",
    "i agree",
    "hope you find a good fit",
    "wish you the best",
    "all the best",
    "no worries",
]

SCHEDULING_CLOSEOUT_KEYWORDS = [
    "already booked",
    "already scheduled",
    "call is booked",
    "calendar invite sent",
    "see you then",
    "confirmed for",
    "booked the call",
    "we already booked",
]

SOLICITATION_KEYWORDS = [
    "consultation",
    "account manager",
    "quick call",
    "book a call",
    "book time",
    "book a demo",
    "free audit",
    "pipeline",
    "lead gen",
    "google ads",
    "paid media",
    "growth plan",
    "solicitor",
    "outreach",
    "prospecting",
]

SOLICITATION_CTA_KEYWORDS = [
    "are you open",
    "would you be open",
    "worth a quick call",
    "can we connect",
    "can we hop on",
    "15 min",
    "20 min",
    "30 min",
    "grab time",
    "calendar",
]

SOLICITATION_EXEMPT_TERMS = [
    "[hiring@]",
    "interview",
    "candidate",
    "takehome",
    "roleplay",
]

NO_REPLY_EXACT_SENDERS = {
    "notifications@nt1.instantly.ai",
    "comments-noreply@docs.google.com",
    "communications@ramp.com",
    "truewind.ai@calendar.luma-mail.com",
    "dse@eumail.docusign.net",
    "invite@emails.magicpatterns.com",
    "team@mail.notion.so",
    "amarpreetkalsi@google.com",
    "nishadwivedi@google.com",
}

NO_REPLY_LOCALPART_TOKENS = (
    "noreply",
    "no-reply",
    "donotreply",
    "do-not-reply",
    "notification",
    "notifications",
    "comments-noreply",
)

NO_REPLY_NOTIFICATION_DOMAINS = {
    "nt1.instantly.ai",
    "docs.google.com",
    "luma-mail.com",
    "emails.magicpatterns.com",
}

FORCE_ARCHIVE_SENDERS = {
    "drew.katnik@cybercoders.com",
    "lavneesh@google.com",
}

ALWAYS_REPLY_SENDERS = {
    "mbaske@linkedin.com",
}

FORCE_CONFERENCE_SENDERS = {
    "sagesponsorship@sage.com",
}

TRANSACTIONAL_SUBJECT_KEYWORDS = [
    "verify your",
    "receipt",
    "invited to join",
    "shared with you",
    "document shared",
    "folder shared",
    "signature requested",
    "action required",
    "policy acknowledgment required",
    "weekly digest",
    "enabled 2fa",
    "requires you to sign",
    "accepted:",
    "invitation",
    "new position from",
    "ads disapproved",
    "you have actions to complete",
]

TRANSACTIONAL_BODY_KEYWORDS = [
    "this is an automated",
    "do not reply",
    "donotreply",
    "notification",
    "no-reply",
    "unsubscribe",
]

INTERNAL_FYI_KEYWORDS = [
    "fyi",
    "for your info",
    "for your information",
    "in case you didn't get this",
    "forwarding if it's interesting",
    "forwarding if this is interesting",
]

SUPPORT_LOCALPART_TOKENS = ("support", "help", "info", "success")
SUPPORT_SUBJECT_TOKENS = (
    "your request",
    "ticket",
    "case",
    "support",
    "regarding your",
    "credit status",
)
SUPPORT_DOMAINS = {
    "lusha.com",
}

POST_EVENT_FOLLOWUP_SENDERS = {
    "gabriel.enciso@vercel.com",
}

POST_EVENT_FOLLOWUP_KEYWORDS = [
    "thanks for joining us",
    "great to have you",
    "launch party",
    "have questions from the session",
    "reply here and i'll get you an answer",
]

REPLY_NOISE_LINE_PREFIXES = (
    "from:",
    "sent:",
    "to:",
    "cc:",
    "subject:",
)

NEWSLETTER_GUIDELINE_QUESTION_TOKENS = (
    "newsletter",
    "word count",
    "image",
    "images",
    "within reason",
    "past editions",
)

DRAFTABLE_INTENTS = {"feedback_request", "scheduling", "question", "request"}

DIRECT_ASK_PATTERNS = (
    "can you",
    "could you",
    "would you",
    "please",
    "let me know",
    "share",
    "send",
    "confirm",
    "what time",
    "when works",
    "are you available",
    "does this work",
)

PROMO_QUESTION_PATTERNS = (
    "have questions from the session",
    "reply here and i'll get you an answer",
    "interested in learning more",
)

MORE_INFO_REQUEST_PATTERNS = (
    "more info",
    "more information",
    "provide any more info",
    "share more detail",
    "share more details",
    "can you provide",
    "could you provide",
)

LOW_VALUE_QUESTION_PHRASES = (
    "thanks for the note.",
    "i saw your point on:",
    "i need to verify one detail before i answer fully.",
    "i will send a concrete answer shortly.",
)


@dataclass
class TriageConfig:
    credentials_file: Path
    token_file: Path
    state_file: Path
    style_file: Path
    max_threads: int
    query: str
    marketing_label: str
    auto_label: str
    conference_label: str
    review_label: str
    style_sample_size: int
    style_cache_ttl_hours: int
    refresh_style_profile: bool
    min_draft_confidence: int
    refresh_existing_drafts: bool
    dry_run: bool
    route_only: bool
    slack_token: str
    slack_channel: str
    slack_mention_user_id: str
    slack_notifications: bool


def load_env_files() -> None:
    load_dotenv(".env.local")
    load_dotenv()


def first_env(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def default_slack_channel() -> str:
    return first_env(
        "GMAIL_TRIAGE_SLACK_CHANNEL",
        "INSTANTLY_POSITIVE_REPLY_SLACK_CHANNEL",
        "ACTIONABLE_REPLY_SLACK_CHANNEL",
        "GMAIL_TRIAGE_SLACK_MENTION_USER_ID",
        "INSTANTLY_POSITIVE_REPLY_SLACK_MENTION_USER_ID",
        "SLACK_USER_ID",
    )


def normalize_slack_channel(channel: str) -> str:
    cleaned = channel.strip()
    return cleaned[1:] if cleaned.startswith("#") else cleaned


def resolve_existing_path(raw_path: str) -> Path:
    candidate = Path(raw_path).expanduser()
    if candidate.exists():
        return candidate.resolve()

    if not candidate.is_absolute():
        ag_home = os.getenv("AGENTIC_HOME", "").strip()
        if ag_home:
            ag_candidate = (Path(ag_home) / candidate).expanduser()
            if ag_candidate.exists():
                return ag_candidate.resolve()

    # Keep parity with existing repo scripts that look in this fallback secrets directory.
    fallback_secret_dir = Path("/Users/richardwei/Documents/New project/secrets")
    fallback_candidate = fallback_secret_dir / candidate.name
    if fallback_candidate.exists():
        return fallback_candidate.resolve()

    return candidate.resolve()


def require_google_dependencies():
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ModuleNotFoundError as exc:  # pragma: no cover - dependency guard
        raise RuntimeError(
            "Missing Google API dependencies. Install them with: pip install -r requirements-recruiting.txt"
        ) from exc
    return Request, Credentials, InstalledAppFlow, build


def save_credentials(path: Path, creds: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(creds.to_json(), encoding="utf-8")


class CredentialRefreshNetworkError(RuntimeError):
    """Raised when token refresh fails due to transient network/DNS issues."""


def is_likely_network_error(exc: Exception) -> bool:
    cursor: Exception | None = exc
    markers = (
        "servernotfounderror",
        "name or service not known",
        "nodename nor servname provided",
        "temporary failure in name resolution",
        "failed to establish a new connection",
        "network is unreachable",
        "timed out",
        "connection reset",
        "connection aborted",
    )
    while cursor is not None:
        blob = f"{type(cursor).__name__} {cursor}".lower()
        if any(marker in blob for marker in markers):
            return True
        next_exc = cursor.__cause__ or cursor.__context__
        cursor = next_exc if isinstance(next_exc, Exception) else None
    return False


def load_google_credentials(token_path: Path, scopes: list[str]):
    if not token_path.exists():
        return None
    Request, Credentials, _, _ = require_google_dependencies()
    creds = Credentials.from_authorized_user_file(str(token_path), scopes)
    if hasattr(creds, "has_scopes") and not creds.has_scopes(scopes):
        return None
    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            save_credentials(token_path, creds)
        except Exception as exc:
            if is_likely_network_error(exc):
                raise CredentialRefreshNetworkError(
                    "Unable to refresh Gmail OAuth token due to transient network/DNS failure."
                ) from exc
            return None
    if not creds.valid:
        return None
    return creds


def run_auth_flow(credentials_path: Path, token_path: Path, scopes: list[str]):
    if not credentials_path.exists():
        raise FileNotFoundError(f"Credentials file not found: {credentials_path}")
    _, _, InstalledAppFlow, _ = require_google_dependencies()
    flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), scopes)
    auth_kwargs = {
        "access_type": "offline",
        "include_granted_scopes": "true",
        "prompt": "consent",
    }
    try:
        creds = flow.run_local_server(port=0, **auth_kwargs)
    except (PermissionError, OSError) as exc:
        if not sys.stdin.isatty():
            raise RuntimeError(
                "OAuth local callback server could not start. Run `gmail_inbox_triage.py auth` in a local interactive shell to re-auth."
            ) from exc
        if not hasattr(flow, "run_console"):
            raise RuntimeError(
                "OAuth local callback server could not start, and console fallback is unavailable in this google-auth-oauthlib version."
            ) from exc
        print("OAuth local callback server unavailable; falling back to console auth.")
        creds = flow.run_console(**auth_kwargs)
    save_credentials(token_path, creds)
    return creds


def ensure_gmail_service(credentials_path: Path, token_path: Path):
    try:
        creds = load_google_credentials(token_path, SCOPES)
    except CredentialRefreshNetworkError as exc:
        raise RuntimeError(
            "Gmail token refresh failed due to network/DNS issues while validating OAuth credentials. "
            "Retry when connectivity to gmail.googleapis.com is healthy."
        ) from exc
    if not creds:
        if not sys.stdin.isatty():
            raise RuntimeError(
                "No valid Gmail OAuth token available for non-interactive execution. "
                "Re-auth once in an interactive shell with: "
                f"`gmail_inbox_triage.py auth --credentials-file \"{credentials_path}\" --token-file \"{token_path}\"`"
            )
        creds = run_auth_flow(credentials_path, token_path, SCOPES)
    _, _, _, build = require_google_dependencies()
    return build("gmail", "v1", credentials=creds)


def read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def style_profile_is_fresh(style_profile: dict[str, Any], *, ttl_hours: int) -> bool:
    sampled_at = str(style_profile.get("sampled_at", "")).strip()
    if not sampled_at:
        return False
    try:
        sampled = datetime.fromisoformat(sampled_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    if sampled.tzinfo is None:
        sampled = sampled.replace(tzinfo=timezone.utc)
    age = datetime.now(timezone.utc) - sampled.astimezone(timezone.utc)
    if age > timedelta(hours=max(1, ttl_hours)):
        return False
    return bool(style_profile.get("greeting_template")) and bool(style_profile.get("signoff"))


def normalize_email(value: str) -> str:
    return parseaddr(value)[1].strip().lower()


def email_domain(email: str) -> str:
    if "@" not in email:
        return ""
    return email.split("@", 1)[1].strip().lower()


def email_local_part(email: str) -> str:
    if "@" not in email:
        return email.strip().lower()
    return email.split("@", 1)[0].strip().lower()


def split_header_emails(value: str) -> list[str]:
    if not value:
        return []
    items: list[str] = []
    for token in value.split(","):
        parsed = normalize_email(token)
        if parsed:
            items.append(parsed)
    return items


def internal_domains(my_email: str) -> set[str]:
    domains: set[str] = set()
    mine = email_domain(my_email)
    if mine:
        domains.add(mine)
    extra = os.getenv("GMAIL_TRIAGE_INTERNAL_DOMAINS", "").strip()
    if extra:
        for token in extra.split(","):
            cleaned = token.strip().lower()
            if cleaned:
                domains.add(cleaned)
    return domains


def no_reply_address_reason(sender: str, *, my_email: str) -> str | None:
    if not sender:
        return None
    if sender == my_email:
        return None
    if sender in ALWAYS_REPLY_SENDERS:
        return None
    if sender in FORCE_ARCHIVE_SENDERS:
        return f"force-archive-sender:{sender}"

    sender_domain = email_domain(sender)
    in_domains = internal_domains(my_email)
    if sender_domain in in_domains:
        return None

    if sender in NO_REPLY_EXACT_SENDERS:
        return f"exact-sender:{sender}"
    if sender in POST_EVENT_FOLLOWUP_SENDERS:
        return f"post-event-sender:{sender}"

    local_part = email_local_part(sender)
    if sender_domain in NO_REPLY_NOTIFICATION_DOMAINS and any(token in local_part for token in NO_REPLY_LOCALPART_TOKENS):
        return f"notif-domain-role-mailbox:{sender}"

    if sender_domain in SUPPORT_DOMAINS and any(token in local_part for token in SUPPORT_LOCALPART_TOKENS):
        return f"support-role-mailbox:{sender}"
    return None


def is_internal_handoff_message(message: dict[str, Any], *, my_email: str) -> bool:
    headers = header_map(message)
    sender = normalize_email(headers.get("from", ""))
    if not sender:
        return False

    in_domains = internal_domains(my_email)
    sender_domain = email_domain(sender)
    if sender_domain not in in_domains:
        return False

    recipients = split_header_emails(headers.get("to", "")) + split_header_emails(headers.get("cc", ""))
    if not recipients:
        return False

    external_recipients = [addr for addr in recipients if email_domain(addr) not in in_domains]
    if not external_recipients:
        return False

    # Internal teammate is leading communication with an external contact.
    return True


def always_reply_sender(message: dict[str, Any], *, my_email: str) -> str | None:
    headers = header_map(message)
    sender = normalize_email(headers.get("from", ""))
    if not sender or sender == my_email:
        return None
    if sender in ALWAYS_REPLY_SENDERS:
        return sender
    return None


def internal_fyi_reason(message: dict[str, Any], *, my_email: str) -> str | None:
    headers = header_map(message)
    sender = normalize_email(headers.get("from", ""))
    if not sender:
        return None
    in_domains = internal_domains(my_email)
    if email_domain(sender) not in in_domains:
        return None
    if sender == my_email:
        return None
    subject = headers.get("subject", "").lower()
    body = message_text(message).lower()
    haystack = f"{subject}\n{body}"
    if any(token in haystack for token in INTERNAL_FYI_KEYWORDS):
        return f"internal-fyi:{sender}"
    return None


def no_reply_notification_reason(message: dict[str, Any], *, my_email: str) -> str | None:
    headers = header_map(message)
    sender = normalize_email(headers.get("from", ""))
    direct_reason = no_reply_address_reason(sender, my_email=my_email)
    if direct_reason:
        return direct_reason

    header_reason = automated_header_reason(headers, sender=sender)
    if header_reason:
        return header_reason

    sender_domain = email_domain(sender)
    local_part = email_local_part(sender)
    precedence = headers.get("precedence", "").strip().lower()

    if any(token in local_part for token in NO_REPLY_LOCALPART_TOKENS):
        auto_submitted = headers.get("auto-submitted", "").strip().lower()
        if auto_submitted and auto_submitted != "no":
            return f"auto-submitted-role-mailbox:{sender}"
        if precedence in {"bulk", "list", "junk"}:
            return f"precedence-role-mailbox:{sender}"
        if headers.get("list-unsubscribe"):
            return f"unsubscribe-role-mailbox:{sender}"
    return None


def automated_header_reason(headers: dict[str, str], *, sender: str) -> str | None:
    sender_label = sender or "<unknown>"
    auto_submitted = headers.get("auto-submitted", "").strip().lower()
    if auto_submitted and auto_submitted != "no":
        return f"auto-submitted-header:{sender_label}"

    if headers.get("x-autoreply"):
        return f"x-autoreply-header:{sender_label}"

    if headers.get("x-auto-response-suppress"):
        return f"x-auto-response-suppress-header:{sender_label}"

    precedence = headers.get("precedence", "").strip().lower()
    if precedence in {"bulk", "list", "junk"}:
        return f"precedence-header:{precedence}:{sender_label}"

    if headers.get("list-unsubscribe"):
        return f"list-unsubscribe-header:{sender_label}"
    return None


def positive_reply_notification_reason(message: dict[str, Any], *, my_email: str) -> str | None:
    headers = header_map(message)
    sender = normalize_email(headers.get("from", ""))
    if sender == my_email:
        return None

    sender_domain = email_domain(sender)
    provider = ""
    if "instantly" in sender_domain:
        provider = "instantly"
    elif "lemlist" in sender_domain or "lemwarm" in sender_domain:
        provider = "lemlist"

    subject = headers.get("subject", "").strip()
    body = message_text(message)
    haystack = f"{subject}\n{body}".lower()
    if "may have sent a positive reply" in haystack:
        return f"positive-reply-notification:{provider or 'unknown'}"
    if provider and ("positive reply" in haystack or "replied positively" in haystack):
        return f"positive-reply-notification:{provider}"
    return None


def extract_email_from_text(value: str) -> str:
    match = re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", value)
    return match.group(0).lower() if match else ""


def slack_escape(value: str) -> str:
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def gmail_thread_url(thread_id: str) -> str:
    return f"https://mail.google.com/mail/u/0/#inbox/{thread_id}"


def format_slack_response_alert(
    *,
    message: dict[str, Any],
    thread_id: str,
    title: str,
    reason: str,
    mention_user_id: str,
    draft_id: str = "",
) -> str:
    headers = header_map(message)
    subject = headers.get("subject", "").strip()
    sender = headers.get("from", "").strip()
    body = message_text(message).strip()
    lead_email = extract_email_from_text(f"{subject}\n{body}")

    prefix = f"<@{mention_user_id}> " if mention_user_id else ""
    lines = [
        f"{prefix}*{slack_escape(title)}*",
        f"Subject: {slack_escape(subject or '(no subject)')}",
        f"From: {slack_escape(sender or '(unknown)')}",
        f"Reason: {slack_escape(reason)}",
    ]
    if lead_email:
        lines.append(f"Lead: {slack_escape(lead_email)}")
    if draft_id:
        lines.append(f"Draft: {slack_escape(draft_id)}")
    lines.append(f"Gmail: {gmail_thread_url(thread_id)}")
    return "\n".join(lines)


def slack_api(method: str, *, token: str, params: dict[str, str]) -> dict[str, Any]:
    data = urllib.parse.urlencode(
        params
    ).encode("utf-8")
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"Slack API {method} failed: {payload.get('error', 'unknown_error')}")
    return payload


def slack_channel_is_user_id(channel: str) -> bool:
    return bool(re.match(r"^[UW][A-Z0-9]+$", channel.strip()))


def resolve_slack_post_channel(*, token: str, channel: str) -> str:
    normalized = normalize_slack_channel(channel)
    if not slack_channel_is_user_id(normalized):
        return normalized
    payload = slack_api("conversations.open", token=token, params={"users": normalized})
    resolved = ((payload.get("channel") or {}).get("id") or "").strip()
    if not resolved:
        raise RuntimeError("Slack API conversations.open did not return a channel id")
    return resolved


def post_slack_message(*, token: str, channel: str, text: str) -> dict[str, Any]:
    target_channel = resolve_slack_post_channel(token=token, channel=channel)
    return slack_api(
        "chat.postMessage",
        token=token,
        params={
            "channel": target_channel,
            "text": text,
        },
    )


def maybe_notify_slack(
    *,
    config: TriageConfig,
    thread_record: dict[str, Any],
    thread_id: str,
    message: dict[str, Any],
    alert_kind: str,
    title: str,
    reason: str,
    draft_id: str = "",
) -> str:
    message_id = str(message.get("id", "") or message_internal_ms(message) or thread_id)
    alert_key = f"{alert_kind}:{message_id}"
    if thread_record.get("last_slack_alert_key") == alert_key:
        return "duplicate"
    if not config.slack_notifications:
        return "disabled"
    if config.dry_run:
        print(f"[slack:dry-run] thread={thread_id} kind={alert_kind} reason={reason}")
        return "dry_run"
    if not config.slack_token or not config.slack_channel:
        raise RuntimeError("Slack notifications are enabled but token/channel config is missing")

    text = format_slack_response_alert(
        message=message,
        thread_id=thread_id,
        title=title,
        reason=reason,
        mention_user_id=config.slack_mention_user_id,
        draft_id=draft_id,
    )
    try:
        post_slack_message(token=config.slack_token, channel=config.slack_channel, text=text)
    except Exception as exc:
        raise RuntimeError(f"Slack notification failed for thread {thread_id}: {exc}") from exc

    thread_record["last_slack_alert_key"] = alert_key
    thread_record["last_slack_alerted_at"] = datetime.now(timezone.utc).isoformat()
    return "posted"


def validate_slack_notification_config(config: TriageConfig) -> None:
    if not config.slack_notifications or config.dry_run:
        return
    if not config.slack_token:
        raise RuntimeError(
            "Missing Slack token for Gmail triage notifications. "
            "Set SLACK_BOT_TOKEN/SLACK_USER_TOKEN or pass --no-slack-notifications intentionally."
        )
    if not config.slack_channel:
        raise RuntimeError(
            "Missing Slack channel or user ID for Gmail triage notifications. "
            "Set GMAIL_TRIAGE_SLACK_CHANNEL, GMAIL_TRIAGE_SLACK_MENTION_USER_ID, or SLACK_USER_ID."
        )
    if not config.slack_mention_user_id and not re.match(r"^[UW][A-Z0-9]+$", config.slack_channel):
        raise RuntimeError(
            "Missing Slack mention user ID for channel notifications. "
            "Set GMAIL_TRIAGE_SLACK_MENTION_USER_ID or SLACK_USER_ID so response-needed alerts ping a user."
        )


def support_update_reason(message: dict[str, Any], *, my_email: str) -> str | None:
    headers = header_map(message)
    sender = normalize_email(headers.get("from", ""))
    if not sender or sender == my_email:
        return None
    if sender in ALWAYS_REPLY_SENDERS:
        return None
    domain = email_domain(sender)
    if domain not in SUPPORT_DOMAINS:
        return None
    local_part = email_local_part(sender)
    subject = headers.get("subject", "").lower()
    if any(token in local_part for token in SUPPORT_LOCALPART_TOKENS):
        return f"support-role-mailbox:{sender}"
    if any(token in subject for token in SUPPORT_SUBJECT_TOKENS):
        return f"support-subject:{sender}"
    return None


def post_event_followup_reason(message: dict[str, Any], *, my_email: str) -> str | None:
    headers = header_map(message)
    sender = normalize_email(headers.get("from", ""))
    if not sender or sender == my_email:
        return None
    if sender in ALWAYS_REPLY_SENDERS:
        return None
    subject = headers.get("subject", "").lower()
    body = message_text(message).lower()
    haystack = f"{subject}\n{body}"

    if sender in POST_EVENT_FOLLOWUP_SENDERS:
        return f"post-event-sender:{sender}"
    if "launch party" in haystack and any(token in haystack for token in ["thanks for joining", "have questions from the session"]):
        return "post-event-followup-keywords"
    if any(token in haystack for token in POST_EVENT_FOLLOWUP_KEYWORDS) and "reply here" in haystack:
        return "post-event-followup-template"
    return None


def force_archive_sender_reason(message: dict[str, Any], *, my_email: str) -> str | None:
    headers = header_map(message)
    sender = normalize_email(headers.get("from", ""))
    reason = no_reply_address_reason(sender, my_email=my_email)
    if not reason:
        return None
    if reason.startswith("force-archive-sender:"):
        return reason
    return None


def transactional_notification_reason(thread: dict[str, Any], *, my_email: str) -> str | None:
    inbound = latest_inbound_message(thread, my_email)
    if not inbound:
        return None
    headers = header_map(inbound)
    sender = normalize_email(headers.get("from", ""))
    if sender in ALWAYS_REPLY_SENDERS:
        return None
    subject = headers.get("subject", "").lower()
    body = message_text(inbound).lower()
    local_part = sender.split("@", 1)[0].lower() if "@" in sender else sender.lower()

    if any(token in subject for token in ["interview", "candidate", "[hiring@]", "re:"]):
        return None

    if any(token in subject for token in TRANSACTIONAL_SUBJECT_KEYWORDS):
        return f"subject-keyword:{subject[:60]}"

    if any(token in local_part for token in NO_REPLY_LOCALPART_TOKENS):
        return f"role-mailbox:{sender}"

    if any(token in body for token in TRANSACTIONAL_BODY_KEYWORDS):
        return "body-notification-token"

    return None


def header_map(message: dict[str, Any]) -> dict[str, str]:
    cached = message.get("__header_map")
    if isinstance(cached, dict):
        return cached
    headers = message.get("payload", {}).get("headers", [])
    resolved = {entry.get("name", "").lower(): entry.get("value", "") for entry in headers}
    message["__header_map"] = resolved
    return resolved


def decode_part_data(data: str) -> str:
    if not data:
        return ""
    decoded = base64.urlsafe_b64decode(data + "===")
    return decoded.decode("utf-8", errors="replace")


def extract_text_from_payload(payload: dict[str, Any]) -> str:
    mime_type = payload.get("mimeType", "")
    body = payload.get("body", {})
    data = body.get("data", "")

    if mime_type == "text/plain" and data:
        return decode_part_data(data)
    if mime_type == "text/html" and data:
        html = decode_part_data(data)
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()

    for part in payload.get("parts", []) or []:
        extracted = extract_text_from_payload(part)
        if extracted:
            return extracted

    if data:
        return decode_part_data(data)
    return ""


def clean_message_text(text: str) -> str:
    lines = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        lowered = line.lower()
        if line.startswith(">"):
            continue
        if lowered.startswith("on ") and " wrote:" in lowered:
            continue
        if lowered.startswith(REPLY_NOISE_LINE_PREFIXES):
            continue
        if lowered.startswith("[signature_"):
            continue
        if lowered.startswith(("http://", "https://")):
            continue
        if "linkedin.com/in/" in lowered:
            continue
        if re.search(r"\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b", line):
            continue
        lines.append(line)
    compact = "\n".join(lines)
    compact = re.sub(r"\n{3,}", "\n\n", compact)
    return compact.strip()


def message_text(message: dict[str, Any]) -> str:
    cached = message.get("__message_text")
    if isinstance(cached, str):
        return cached
    payload = message.get("payload", {})
    text = extract_text_from_payload(payload)
    if not text:
        text = message.get("snippet", "")
    resolved = clean_message_text(text)
    message["__message_text"] = resolved
    return resolved


def conference_thread_reason(thread: dict[str, Any], my_email: str) -> str | None:
    inbound = latest_inbound_message(thread, my_email)
    if inbound:
        inbound_sender = normalize_email(header_map(inbound).get("from", ""))
        if inbound_sender in FORCE_CONFERENCE_SENDERS:
            return f"force-conference-sender:{inbound_sender}"

    messages = sorted_thread_messages(thread)
    haystack_chunks: list[str] = []
    for message in messages:
        headers = header_map(message)
        from_email = normalize_email(headers.get("from", ""))
        if from_email == my_email:
            continue
        haystack_chunks.append(headers.get("subject", ""))
        haystack_chunks.append(message_text(message))

    if not haystack_chunks:
        return None

    haystack = "\n".join(haystack_chunks).lower()
    if any(token in haystack for token in NON_CONFERENCE_GUARD_TERMS):
        return None

    strong_hits = [token for token in CONFERENCE_STRONG_KEYWORDS if token in haystack]
    context_hits = [token for token in CONFERENCE_CONTEXT_KEYWORDS if token in haystack]

    if len(strong_hits) >= 1 and (len(context_hits) >= 1 or len(strong_hits) >= 2):
        return f"strong={strong_hits[:3]} context={context_hits[:3]}"
    return None


def message_internal_ms(message: dict[str, Any]) -> int:
    cached = message.get("__internal_ms")
    if isinstance(cached, int):
        return cached
    raw = str(message.get("internalDate", "0") or "0")
    try:
        resolved = int(raw)
    except ValueError:
        resolved = 0
    message["__internal_ms"] = resolved
    return resolved


def sorted_thread_messages(thread: dict[str, Any]) -> list[dict[str, Any]]:
    cached = thread.get("__sorted_messages")
    if isinstance(cached, list):
        return cached
    resolved = sorted(thread.get("messages", []), key=message_internal_ms)
    thread["__sorted_messages"] = resolved
    return resolved


def list_inbox_thread_ids(gmail_service, *, query: str, max_threads: int) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    page_token: str | None = None

    while len(ordered) < max_threads:
        response = (
            gmail_service.users()
            .messages()
            .list(
                userId="me",
                labelIds=["INBOX"],
                q=query,
                maxResults=min(100, max_threads - len(ordered)),
                pageToken=page_token,
            )
            .execute()
        )
        batch = response.get("messages", [])
        if not batch:
            break
        for item in batch:
            thread_id = item.get("threadId", "")
            if not thread_id or thread_id in seen:
                continue
            seen.add(thread_id)
            ordered.append(thread_id)
            if len(ordered) >= max_threads:
                break
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return ordered


def ensure_label(gmail_service, label_name: str, *, dry_run: bool) -> str:
    labels = gmail_service.users().labels().list(userId="me").execute().get("labels", [])
    for label in labels:
        if label.get("name", "").strip() == label_name:
            return label.get("id", "")

    if dry_run:
        return f"DRYRUN-{label_name}"

    created = (
        gmail_service.users()
        .labels()
        .create(
            userId="me",
            body={
                "name": label_name,
                "labelListVisibility": "labelShow",
                "messageListVisibility": "show",
            },
        )
        .execute()
    )
    return created.get("id", "")


def latest_inbound_message(thread: dict[str, Any], my_email: str) -> dict[str, Any] | None:
    messages = sorted_thread_messages(thread)
    for message in reversed(messages):
        from_email = normalize_email(header_map(message).get("from", ""))
        if from_email and from_email != my_email:
            return message
    return None


def latest_outbound_before(
    thread: dict[str, Any],
    *,
    my_email: str,
    before_ms: int,
) -> dict[str, Any] | None:
    messages = sorted_thread_messages(thread)
    for message in reversed(messages):
        if message_internal_ms(message) >= before_ms:
            continue
        headers = header_map(message)
        from_email = normalize_email(headers.get("from", ""))
        if from_email == my_email or "SENT" in set(message.get("labelIds", []) or []):
            return message
    return None


def thread_has_outbound_from_me(thread: dict[str, Any], my_email: str) -> bool:
    messages = thread.get("messages", []) or []
    for message in messages:
        headers = header_map(message)
        from_email = normalize_email(headers.get("from", ""))
        if from_email == my_email:
            return True
        if "SENT" in set(message.get("labelIds", []) or []):
            return True
    return False


def solicitation_outreach_reason(thread: dict[str, Any], my_email: str) -> str | None:
    inbound = latest_inbound_message(thread, my_email)
    if not inbound:
        return None
    headers = header_map(inbound)
    sender = normalize_email(headers.get("from", ""))
    if not sender or sender == my_email:
        return None
    if sender in ALWAYS_REPLY_SENDERS:
        return None

    if thread_has_outbound_from_me(thread, my_email):
        # Existing back-and-forth is not unsolicited outreach.
        return None

    subject = headers.get("subject", "").lower()
    body = message_text(inbound).lower()
    haystack = f"{subject}\n{body}"
    if any(term in haystack for term in SOLICITATION_EXEMPT_TERMS):
        return None

    hits = [term for term in SOLICITATION_KEYWORDS if term in haystack]
    if not hits:
        return None
    if not any(term in haystack for term in SOLICITATION_CTA_KEYWORDS):
        return None
    return f"unsolicited-solicitation:{hits[:2]}"


def classify_thread(thread: dict[str, Any], my_email: str) -> tuple[str, dict[str, Any]]:
    inbound = latest_inbound_message(thread, my_email)
    if not inbound:
        return "conversation", {"reason": "no-inbound-message"}

    headers = header_map(inbound)
    sender_email = normalize_email(headers.get("from", ""))
    if sender_email in ALWAYS_REPLY_SENDERS:
        return "conversation", {
            "subject": headers.get("subject", ""),
            "from": headers.get("from", ""),
            "auto_score": 0,
            "marketing_score": 0,
            "reasons": [f"always-reply-sender:{sender_email}"],
        }
    subject = headers.get("subject", "")
    from_header = headers.get("from", "")
    body = message_text(inbound)
    haystack = f"{subject}\n{body}".lower()

    auto_score = 0
    marketing_score = 0
    reasons: list[str] = []
    strong_auto_signal = False

    auto_submitted = headers.get("auto-submitted", "").strip().lower()
    if auto_submitted and auto_submitted != "no":
        auto_score += 5
        strong_auto_signal = True
        reasons.append(f"auto-submitted={auto_submitted}")

    precedence = headers.get("precedence", "").strip().lower()
    if precedence in {"bulk", "list", "junk"}:
        auto_score += 3
        marketing_score += 1
        reasons.append(f"precedence={precedence}")

    if headers.get("x-autoreply") or headers.get("x-auto-response-suppress"):
        auto_score += 4
        strong_auto_signal = True
        reasons.append("autoreply-header")

    if headers.get("list-unsubscribe"):
        marketing_score += 4
        reasons.append("list-unsubscribe")

    lowered_from = from_header.lower()
    if "no-reply" in lowered_from or "noreply" in lowered_from or "do-not-reply" in lowered_from:
        auto_score += 3
        reasons.append("noreply-sender")

    for token in AUTO_KEYWORDS:
        if token in haystack:
            auto_score += 2
            reasons.append(f"auto-keyword:{token}")

    if "day 1" in haystack:
        auto_score += 3
        strong_auto_signal = True
        reasons.append("auto-keyword:day1-strong")

    for token in MARKETING_KEYWORDS:
        if token in haystack:
            marketing_score += 2
            reasons.append(f"marketing-keyword:{token}")

    transactional_reason = transactional_notification_reason(thread, my_email=my_email)
    if transactional_reason:
        auto_score += 5
        strong_auto_signal = True
        reasons.append(f"transactional:{transactional_reason}")

    conference_reason = conference_thread_reason(thread, my_email)
    if conference_reason:
        reasons.append(f"conference:{conference_reason}")

    if re.match(r"^(re|fwd):", subject.strip(), re.IGNORECASE):
        auto_score = max(0, auto_score - 2)
        marketing_score = max(0, marketing_score - 2)

    decision = "conversation"
    if conference_reason:
        decision = "conference"
    elif auto_score >= 4 and (strong_auto_signal or auto_score >= marketing_score):
        decision = "auto"
    elif marketing_score >= 3:
        decision = "marketing"

    return decision, {
        "subject": subject,
        "from": from_header,
        "auto_score": auto_score,
        "marketing_score": marketing_score,
        "reasons": reasons[:8],
    }


def guess_first_name(from_header: str) -> str:
    display_name = parseaddr(from_header)[0].strip().strip('"')
    if not display_name:
        return "there"

    def _sanitize(token: str) -> str:
        return re.sub(r"[^A-Za-z'-]", "", token)

    if "," in display_name:
        parts = [part.strip() for part in display_name.split(",", 1)]
        if len(parts) == 2 and parts[1]:
            candidate = _sanitize(re.split(r"\s+", parts[1])[0])
            if candidate:
                return candidate

    tokens = [tok for tok in re.split(r"\s+", display_name) if tok]
    if not tokens:
        return "there"
    honorifics = {"mr", "mrs", "ms", "dr"}
    first = _sanitize(tokens[0])
    if first.lower().rstrip(".") in honorifics and len(tokens) > 1:
        first = _sanitize(tokens[1])
    return first or "there"


def is_non_content_sentence(sentence: str) -> bool:
    lowered = sentence.strip().lower()
    if not lowered:
        return True
    if lowered.startswith(REPLY_NOISE_LINE_PREFIXES):
        return True
    if lowered.startswith("[signature_"):
        return True
    if lowered.startswith(("http://", "https://")):
        return True
    if "linkedin.com/in/" in lowered:
        return True
    if re.search(r"\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b", sentence):
        return True
    if "@" in sentence and " " not in sentence.strip():
        return True
    words = sentence.split()
    if len(words) >= 6 and not any(ch in sentence for ch in ".?!"):
        capitalized = sum(1 for word in words if word and word[0].isupper())
        if capitalized >= len(words) - 1:
            return True
    return False


def extract_first_sentence(text: str) -> str:
    if not text:
        return ""
    stripped = re.sub(r"\s+", " ", text.strip())
    parts = re.split(r"(?<=[.!?])\s+", stripped)
    for part in parts:
        cleaned = part.strip()
        if len(cleaned) < 12:
            continue
        if cleaned.lower().startswith(("hi ", "hello ", "hey ")):
            continue
        if is_non_content_sentence(cleaned):
            continue
        return cleaned[:220]
    return ""


def detect_reply_intent(latest_inbound_text: str, previous_outbound_text: str) -> str:
    inbound = latest_inbound_text.lower()
    outbound = previous_outbound_text.lower()

    if any(token in inbound for token in FEEDBACK_REQUEST_KEYWORDS):
        return "feedback_request"
    if "feedback" in inbound and ("?" in inbound or any(token in inbound for token in ["can you", "could you", "let me know"])):
        return "feedback_request"

    if any(token in inbound for token in SCHEDULING_KEYWORDS) or any(
        token in outbound for token in SCHEDULING_KEYWORDS
    ):
        return "scheduling"

    if "?" in latest_inbound_text:
        return "question"

    if any(token in inbound for token in CONFIRMATION_KEYWORDS):
        return "confirmation"

    if any(token in inbound for token in ["please", "could you", "can you", "let me know"]):
        return "request"

    return "general"


def has_direct_ask(latest_inbound_text: str) -> bool:
    text = latest_inbound_text.lower()
    if any(token in text for token in FEEDBACK_REQUEST_KEYWORDS):
        return True
    if any(token in text for token in DIRECT_ASK_PATTERNS):
        return True
    if "?" in text and not any(token in text for token in PROMO_QUESTION_PATTERNS):
        return True
    return False


def draft_confidence_score(
    *,
    inbound: dict[str, Any],
    latest_inbound_text: str,
    intent: str,
    direct_ask: bool,
    classification_info: dict[str, Any],
    my_email: str,
) -> int:
    score = 0
    if intent in {"feedback_request", "scheduling", "request"}:
        score += 2
    elif intent == "question":
        score += 1

    if direct_ask:
        score += 2

    auto_score = int(classification_info.get("auto_score", 0) or 0)
    marketing_score = int(classification_info.get("marketing_score", 0) or 0)
    score -= min(4, auto_score)
    if marketing_score >= 2:
        score -= 1

    headers = header_map(inbound)
    sender = normalize_email(headers.get("from", ""))
    if sender in ALWAYS_REPLY_SENDERS:
        return max(score, 3)

    if headers.get("list-unsubscribe"):
        score -= 3
    auto_submitted = headers.get("auto-submitted", "").strip().lower()
    if auto_submitted and auto_submitted != "no":
        score -= 3
    precedence = headers.get("precedence", "").strip().lower()
    if precedence in {"bulk", "list", "junk"}:
        score -= 2

    addr_reason = no_reply_address_reason(sender, my_email=my_email)
    if addr_reason:
        score -= 4

    lower_text = latest_inbound_text.lower()
    if any(token in lower_text for token in TRANSACTIONAL_BODY_KEYWORDS):
        score -= 2
    if any(token in lower_text for token in POST_EVENT_FOLLOWUP_KEYWORDS):
        score -= 2
    return score


def evaluate_draft_decision(
    *,
    inbound: dict[str, Any],
    latest_inbound_text: str,
    previous_outbound_text: str,
    classification_info: dict[str, Any],
    my_email: str,
    min_draft_confidence: int,
) -> tuple[str, str, int]:
    automated_reason = no_reply_notification_reason(inbound, my_email=my_email)
    if automated_reason:
        return "skip", f"automated-sender:{automated_reason}", 0

    intent = detect_reply_intent(latest_inbound_text, previous_outbound_text)
    if intent not in DRAFTABLE_INTENTS:
        return "skip", f"intent-not-actionable:{intent}", 0

    direct_ask = has_direct_ask(latest_inbound_text)
    confidence = draft_confidence_score(
        inbound=inbound,
        latest_inbound_text=latest_inbound_text,
        intent=intent,
        direct_ask=direct_ask,
        classification_info=classification_info,
        my_email=my_email,
    )
    if not direct_ask:
        confidence -= 2

    if confidence < min_draft_confidence:
        return "review", f"low-confidence:intent={intent};score={confidence}", confidence
    return "draft", f"draftable:intent={intent};score={confidence}", confidence


def normalize_similarity_text(value: str) -> str:
    lowered = value.lower()
    lowered = re.sub(r"[^a-z0-9\s]", " ", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return lowered


def inbound_candidate_sentences(text: str) -> list[str]:
    candidates: list[str] = []
    for piece in re.split(r"[\n\r]+|(?<=[.!?])\s+", text):
        cleaned = normalize_similarity_text(piece)
        if len(cleaned) >= 20:
            candidates.append(cleaned)
    return candidates


def is_parrot_of_inbound(line: str, inbound_sentences: list[str]) -> bool:
    line_norm = normalize_similarity_text(line)
    if len(line_norm) < 20:
        return False
    for inbound_line in inbound_sentences:
        if len(inbound_line) < 20:
            continue
        if line_norm == inbound_line:
            return True
        ratio = SequenceMatcher(None, line_norm, inbound_line).ratio()
        if ratio >= 0.88:
            return True
    return False


def content_lines_for_quality(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        lowered = line.lower()
        if lowered.startswith(("hi ", "hello ", "hey ")):
            continue
        if lowered in {"best,", "thanks,", "thank you,", "regards,", "cheers,", "sincerely,", "warmly,"}:
            continue
        if len(line) <= 2:
            continue
        lines.append(line)
    return lines


def draft_quality_reason(
    *,
    intent: str,
    latest_inbound_text: str,
    draft_body: str,
) -> str | None:
    lowered_body = draft_body.lower()
    if intent == "question":
        for phrase in LOW_VALUE_QUESTION_PHRASES:
            if phrase in lowered_body:
                return f"low-value-question-line:{phrase}"

        inbound_sentences = inbound_candidate_sentences(latest_inbound_text)
        for line in content_lines_for_quality(draft_body):
            if is_parrot_of_inbound(line, inbound_sentences):
                return "parroted-inbound-line"

        content = content_lines_for_quality(draft_body)
        has_specific_question = any("?" in line for line in content)
        has_timebound_next_step = any(
            re.search(r"\b(today|tomorrow|eod|by [a-z0-9]|this (week|afternoon|morning)|\d{1,2}(:\d{2})?\s?(am|pm))\b", line.lower())
            for line in content
        )
        has_detail_anchor = any(
            token in line.lower()
            for line in content
            for token in ("which part", "what exactly", "scope", "timeline", "pricing", "implementation")
        )
        if not (has_specific_question or has_timebound_next_step or has_detail_anchor):
            return "question-reply-missing-concrete-next-step"
    return None


def thread_has_recent_rejection_from_sender(thread: dict[str, Any], my_email: str) -> bool:
    messages = sorted_thread_messages(thread)
    for message in reversed(messages):
        headers = header_map(message)
        from_email = normalize_email(headers.get("from", ""))
        if from_email != my_email and "SENT" not in set(message.get("labelIds", []) or []):
            continue
        text = message_text(message).lower()
        if any(marker in text for marker in REJECTION_MARKERS):
            return True
        if len(text) > 20:
            # Stop after the first substantive sender message.
            return False
    return False


def first_non_sender_message_text(thread: dict[str, Any], my_email: str) -> str:
    messages = sorted_thread_messages(thread)
    for message in messages:
        from_email = normalize_email(header_map(message).get("from", ""))
        if from_email and from_email != my_email:
            return message_text(message)
    return ""


def build_feedback_points(candidate_submission_text: str) -> list[str]:
    text = candidate_submission_text.lower()
    points: list[str] = []

    strategy_terms = sum(
        text.count(token)
        for token in ["audit", "review", "identify", "framework", "opportunity", "prioritized"]
    )
    metric_terms = sum(
        text.count(token)
        for token in ["%", "percent", "baseline", "target", "conversion", "cac", "ltv", "retention"]
    )

    if strategy_terms >= 4 and metric_terms <= 1:
        points.append(
            "Your plan was thoughtful but too diagnostic. We needed 2-3 concrete experiments with baseline, target, and timeline."
        )
    else:
        points.append(
            "We needed clearer proof of execution depth: what you shipped directly, how fast, and what changed numerically."
        )

    points.append(
        "We looked for tighter examples tied to our actual ICP (accounting firms and startup founders), not just a general growth framework."
    )
    points.append(
        "In this process, candidates who moved forward gave specific operating examples with metrics and clear tradeoffs."
    )
    return points


def is_closeout_acknowledgement(
    *,
    latest_inbound_text: str,
    thread_had_rejection: bool,
) -> bool:
    if not thread_had_rejection:
        return False
    text = latest_inbound_text.lower().strip()
    if not text:
        return False
    if "?" in text:
        return False
    if any(token in text for token in FEEDBACK_REQUEST_KEYWORDS):
        return False
    if any(token in text for token in SCHEDULING_KEYWORDS):
        return False
    return any(token in text for token in CLOSEOUT_ACK_KEYWORDS)


def is_scheduling_closeout(
    *,
    latest_inbound_text: str,
    previous_outbound_text: str,
) -> bool:
    text = latest_inbound_text.lower().strip()
    if not text:
        return False
    if "?" in text:
        return False

    if not any(token in text for token in SCHEDULING_CLOSEOUT_KEYWORDS):
        return False

    prior = previous_outbound_text.lower()
    if any(token in prior for token in SCHEDULING_KEYWORDS):
        return True
    return any(token in text for token in ["booked", "scheduled", "calendar invite"])


def extract_greeting(line: str) -> str | None:
    cleaned = line.strip()
    if not cleaned:
        return None
    lowered = cleaned.lower()
    if lowered.startswith("hi ") or lowered.startswith("hello ") or lowered.startswith("hey "):
        normalized = re.sub(r"^(Hi|Hello|Hey)\s+[^,]+,?", r"\1 {name},", cleaned, count=1)
        return normalized
    return None


def extract_signoff(lines: list[str]) -> tuple[str | None, str | None]:
    signoff = None
    signature = None
    endings = ("best", "thanks", "thank you", "regards", "cheers", "sincerely", "warmly")
    for idx in range(max(0, len(lines) - 6), len(lines)):
        line = lines[idx].strip()
        if not line:
            continue
        lowered = line.lower().rstrip("!.,")
        if any(lowered.startswith(prefix) for prefix in endings):
            signoff = line if line.endswith(",") else f"{line},"
            if idx + 1 < len(lines):
                candidate = lines[idx + 1].strip()
                if candidate and len(candidate) <= 40 and "@" not in candidate:
                    signature = candidate
            break
    return signoff, signature


def learn_style_profile(gmail_service, *, my_email: str, sample_size: int) -> dict[str, Any]:
    greetings: Counter[str] = Counter()
    signoffs: Counter[str] = Counter()
    signatures: Counter[str] = Counter()

    response = (
        gmail_service.users()
        .messages()
        .list(userId="me", labelIds=["SENT"], maxResults=max(5, min(sample_size, 100)))
        .execute()
    )
    sent_messages = response.get("messages", [])

    for item in sent_messages:
        message_id = item.get("id", "")
        if not message_id:
            continue
        message = (
            gmail_service.users().messages().get(userId="me", id=message_id, format="full").execute()
        )
        text = message_text(message)
        if not text:
            continue
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines:
            continue

        greeting = extract_greeting(lines[0])
        if greeting:
            greetings[greeting] += 1

        signoff, signature = extract_signoff(lines)
        if signoff:
            signoffs[signoff] += 1
        if signature:
            signatures[signature] += 1

    local_part = my_email.split("@", 1)[0] if "@" in my_email else my_email
    default_signature = re.sub(r"[^A-Za-z]", "", local_part).title() or "Thanks"

    profile = {
        "greeting_template": greetings.most_common(1)[0][0] if greetings else "Hi {name},",
        "signoff": signoffs.most_common(1)[0][0] if signoffs else "Best,",
        "signature": signatures.most_common(1)[0][0] if signatures else default_signature,
        "sampled_at": datetime.now(timezone.utc).isoformat(),
        "sample_size": len(sent_messages),
    }
    return profile


def render_greeting(template: str, name: str) -> str:
    if "{name}" in template:
        return template.replace("{name}", name)
    return template


def generate_reply_body(
    *,
    subject: str,
    latest_inbound_text: str,
    previous_outbound_text: str,
    from_header: str,
    style_profile: dict[str, Any],
    thread_had_rejection: bool,
    candidate_submission_text: str,
) -> str:
    first_name = guess_first_name(from_header)
    greeting = render_greeting(style_profile.get("greeting_template", "Hi {name},"), first_name)
    signoff = style_profile.get("signoff", "Best,")
    signature = style_profile.get("signature", "")

    intent = detect_reply_intent(latest_inbound_text, previous_outbound_text)
    question_haystack = f"{subject}\n{latest_inbound_text}".lower()

    body_lines = [greeting, ""]

    if intent == "feedback_request" or (thread_had_rejection and "why" in latest_inbound_text.lower()):
        body_lines.append("Direct answer below.")
        body_lines.append("")
        for point in build_feedback_points(candidate_submission_text):
            body_lines.append(f"- {point}")
        body_lines.append("")
        body_lines.append("If you want, I can share one revised 30/60/90 plan example that would have been stronger for this role.")
    elif intent == "scheduling":
        body_lines.append("Works on my side.")
        body_lines.append("Send two time options with timezone and I will confirm one.")
    elif intent == "question":
        if any(token in question_haystack for token in NEWSLETTER_GUIDELINE_QUESTION_TOKENS):
            body_lines.append("Totally understand you cannot share past editions.")
            body_lines.append(
                "Can you share any guidance on word count and number of images so we can prepare materials correctly?"
            )
            body_lines.append("I want to make sure we stay within reason.")
        elif any(token in question_haystack for token in MORE_INFO_REQUEST_PATTERNS):
            body_lines.append("Happy to share more detail.")
            body_lines.append("Which part should I prioritize: scope, pricing, implementation details, or timeline?")
            body_lines.append("Once you pick one, I will send specifics today.")
        else:
            body_lines.append("Understood.")
            body_lines.append("What exactly do you need from me so I can answer directly?")
            body_lines.append("I can turn this around today.")
    elif intent == "confirmation":
        body_lines.append("Confirmed.")
        body_lines.append("Proceeding on my side.")
    elif intent == "request":
        body_lines.append("Understood.")
        body_lines.append("I can do this, but I need one more detail before confirming.")
    else:
        body_lines.append("Thanks for the update.")
        body_lines.append("If you need action from me, send the exact ask and deadline.")

    body_lines.extend(["", signoff])
    if signature:
        body_lines.append(signature)
    return "\n".join(body_lines).strip() + "\n"


def create_reply_draft(
    gmail_service,
    *,
    thread: dict[str, Any],
    reply_to_message: dict[str, Any],
    sender_email: str,
    body_text: str,
) -> str:
    reply_headers = header_map(reply_to_message)
    to_email = normalize_email(reply_headers.get("from", ""))
    subject = reply_headers.get("subject", "").strip()
    message_id = reply_headers.get("message-id", "").strip()
    references = reply_headers.get("references", "").strip()

    if not to_email:
        raise ValueError("Cannot create draft without reply recipient")

    reply_subject = subject if subject.lower().startswith("re:") else f"Re: {subject}"
    merged_references = references
    if message_id and message_id not in merged_references:
        merged_references = f"{merged_references} {message_id}".strip()

    message = EmailMessage()
    message["From"] = sender_email
    message["To"] = to_email
    message["Subject"] = reply_subject
    if message_id:
        message["In-Reply-To"] = message_id
    if merged_references:
        message["References"] = merged_references
    message.set_content(body_text)

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
    created = (
        gmail_service.users()
        .drafts()
        .create(userId="me", body={"message": {"raw": raw, "threadId": thread.get("id", "")}})
        .execute()
    )
    return created.get("id", "")


def delete_draft(
    gmail_service,
    *,
    draft_id: str,
    dry_run: bool,
) -> None:
    if not draft_id:
        return
    if dry_run:
        return
    try:
        gmail_service.users().drafts().delete(userId="me", id=draft_id).execute()
    except Exception as exc:
        try:
            from googleapiclient.errors import HttpError
        except ModuleNotFoundError:
            raise
        if isinstance(exc, HttpError):
            status = getattr(getattr(exc, "resp", None), "status", None)
            if status == 404:
                # Draft may already be deleted manually or by a prior cleanup pass.
                return
        raise


def archive_with_label(
    gmail_service,
    *,
    thread_id: str,
    label_id: str,
    dry_run: bool,
) -> None:
    modify_thread_labels(
        gmail_service,
        thread_id=thread_id,
        add_label_ids=[label_id],
        remove_label_ids=["INBOX"],
        dry_run=dry_run,
    )


def add_label_to_thread(
    gmail_service,
    *,
    thread_id: str,
    label_id: str,
    dry_run: bool,
) -> None:
    modify_thread_labels(
        gmail_service,
        thread_id=thread_id,
        add_label_ids=[label_id],
        remove_label_ids=[],
        dry_run=dry_run,
    )


def modify_thread_labels(
    gmail_service,
    *,
    thread_id: str,
    add_label_ids: list[str],
    remove_label_ids: list[str],
    dry_run: bool,
) -> None:
    if dry_run:
        return
    (
        gmail_service.users()
        .threads()
        .modify(
            userId="me",
            id=thread_id,
            body={"addLabelIds": add_label_ids, "removeLabelIds": remove_label_ids},
        )
        .execute()
    )


def archive_thread(
    gmail_service,
    *,
    thread_id: str,
    dry_run: bool,
) -> None:
    if dry_run:
        return
    (
        gmail_service.users()
        .threads()
        .modify(
            userId="me",
            id=thread_id,
            body={"removeLabelIds": ["INBOX"]},
        )
        .execute()
    )


def run_triage(config: TriageConfig) -> int:
    validate_slack_notification_config(config)
    gmail_service = ensure_gmail_service(config.credentials_file, config.token_file)
    profile = gmail_service.users().getProfile(userId="me").execute()
    my_email = normalize_email(profile.get("emailAddress", ""))
    if not my_email:
        raise RuntimeError("Unable to read authenticated Gmail profile email")

    state = read_json(config.state_file, {"threads": {}})
    thread_state: dict[str, Any] = state.setdefault("threads", {})

    style_profile = (
        {}
        if config.refresh_style_profile
        else read_json(config.style_file, {})
    )
    if not style_profile_is_fresh(style_profile, ttl_hours=config.style_cache_ttl_hours):
        style_profile = learn_style_profile(
            gmail_service,
            my_email=my_email,
            sample_size=config.style_sample_size,
        )
        write_json(config.style_file, style_profile)

    marketing_label_id = ensure_label(gmail_service, config.marketing_label, dry_run=config.dry_run)
    auto_label_id = ensure_label(gmail_service, config.auto_label, dry_run=config.dry_run)
    conference_label_id = ensure_label(gmail_service, config.conference_label, dry_run=config.dry_run)
    review_label_id = ensure_label(gmail_service, config.review_label, dry_run=config.dry_run)

    thread_ids = list_inbox_thread_ids(gmail_service, query=config.query, max_threads=config.max_threads)
    counters = Counter()

    def record_slack_status(status: str) -> None:
        counters[f"slack_notifications_{status}"] += 1
        if status == "posted":
            write_json(config.state_file, state)

    for thread_id in thread_ids:
        thread = (
            gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
        )
        inbound_forced = latest_inbound_message(thread, my_email)
        if inbound_forced:
            forced_reason = force_archive_sender_reason(inbound_forced, my_email=my_email)
            if forced_reason:
                archive_thread(gmail_service, thread_id=thread_id, dry_run=config.dry_run)
                counters["conversation_force_archived_sender"] += 1
                thread_record = thread_state.setdefault(thread_id, {})
                thread_record["force_archived_sender"] = forced_reason
                thread_record["last_processed_at"] = datetime.now(timezone.utc).isoformat()
                print(f"[archive:forced-sender] thread={thread_id} reason={forced_reason}")
                continue

        decision, info = classify_thread(thread, my_email)
        counters[f"seen_{decision}"] += 1

        thread_record = thread_state.setdefault(thread_id, {})
        thread_record["last_classification"] = decision
        thread_record["last_subject"] = info.get("subject", "")
        thread_record["last_processed_at"] = datetime.now(timezone.utc).isoformat()

        inbound_for_alert = latest_inbound_message(thread, my_email)
        positive_reply_reason = (
            positive_reply_notification_reason(inbound_for_alert, my_email=my_email)
            if inbound_for_alert
            else None
        )
        if positive_reply_reason and inbound_for_alert:
            slack_status = maybe_notify_slack(
                config=config,
                thread_record=thread_record,
                thread_id=thread_id,
                message=inbound_for_alert,
                alert_kind="positive_reply_notification",
                title="Response needed: positive reply notification",
                reason=positive_reply_reason,
            )
            record_slack_status(slack_status)
            thread_record["positive_reply_notification"] = positive_reply_reason
            print(f"[slack:{slack_status}] thread={thread_id} subject={info.get('subject','')} reason={positive_reply_reason}")

        if decision == "marketing":
            archive_with_label(
                gmail_service,
                thread_id=thread_id,
                label_id=marketing_label_id,
                dry_run=config.dry_run,
            )
            counters["routed_marketing"] += 1
            print(
                f"[route:marketing] thread={thread_id} subject={info.get('subject','')} reasons={','.join(info.get('reasons', []))}"
            )
            continue

        if decision == "auto":
            archive_with_label(
                gmail_service,
                thread_id=thread_id,
                label_id=auto_label_id,
                dry_run=config.dry_run,
            )
            counters["routed_auto"] += 1
            print(f"[route:auto] thread={thread_id} subject={info.get('subject','')} reasons={','.join(info.get('reasons', []))}")
            continue
        if decision == "conference":
            archive_with_label(
                gmail_service,
                thread_id=thread_id,
                label_id=conference_label_id,
                dry_run=config.dry_run,
            )
            counters["routed_conference"] += 1
            print(
                f"[route:conference] thread={thread_id} subject={info.get('subject','')} reasons={','.join(info.get('reasons', []))}"
            )
            continue

        if config.route_only:
            counters["conversation_route_only_skipped"] += 1
            continue

        inbound = latest_inbound_message(thread, my_email)
        if not inbound:
            counters["conversation_no_inbound"] += 1
            continue

        latest_inbound_id = inbound.get("id", "")
        previous_draft_id = str(thread_record.get("last_draft_id", "") or "")

        sorted_messages = sorted_thread_messages(thread)
        if not sorted_messages:
            counters["conversation_no_inbound"] += 1
            continue
        last_message = sorted_messages[-1]
        last_from_email = normalize_email(header_map(last_message).get("from", ""))
        subject = header_map(inbound).get("subject", "")
        if is_internal_handoff_message(last_message, my_email=my_email):
            archive_thread(gmail_service, thread_id=thread_id, dry_run=config.dry_run)
            counters["conversation_internal_handoff_archived"] += 1
            thread_record["internal_handoff_archived"] = True
            print(f"[archive:internal-handoff] thread={thread_id} subject={subject}")
            continue
        fyi_reason = internal_fyi_reason(inbound, my_email=my_email)
        if fyi_reason:
            archive_thread(gmail_service, thread_id=thread_id, dry_run=config.dry_run)
            counters["conversation_internal_fyi_archived"] += 1
            thread_record["internal_fyi_archived"] = True
            print(f"[archive:internal-fyi] thread={thread_id} subject={subject} reason={fyi_reason}")
            continue
        notification_reason = no_reply_notification_reason(inbound, my_email=my_email)
        if notification_reason:
            archive_with_label(
                gmail_service,
                thread_id=thread_id,
                label_id=auto_label_id,
                dry_run=config.dry_run,
            )
            counters["conversation_auto_archived_notification"] += 1
            thread_record["auto_archived_notification"] = True
            print(
                f"[archive:no-reply-notification] thread={thread_id} subject={subject} reason={notification_reason}"
            )
            continue
        support_reason = support_update_reason(inbound, my_email=my_email)
        if support_reason:
            archive_with_label(
                gmail_service,
                thread_id=thread_id,
                label_id=auto_label_id,
                dry_run=config.dry_run,
            )
            counters["conversation_support_update_archived"] += 1
            thread_record["support_update_archived"] = True
            print(f"[archive:support-update] thread={thread_id} subject={subject} reason={support_reason}")
            continue
        post_event_reason = post_event_followup_reason(inbound, my_email=my_email)
        if post_event_reason:
            archive_thread(gmail_service, thread_id=thread_id, dry_run=config.dry_run)
            counters["conversation_post_event_followup_archived"] += 1
            thread_record["post_event_followup_archived"] = True
            print(
                f"[archive:post-event-followup] thread={thread_id} subject={subject} reason={post_event_reason}"
            )
            continue
        solicitation_reason = solicitation_outreach_reason(thread, my_email)
        if solicitation_reason:
            archive_with_label(
                gmail_service,
                thread_id=thread_id,
                label_id=marketing_label_id,
                dry_run=config.dry_run,
            )
            counters["conversation_solicitation_archived"] += 1
            thread_record["solicitation_archived"] = solicitation_reason
            print(
                f"[archive:solicitation] thread={thread_id} subject={subject} reason={solicitation_reason}"
            )
            continue
        if last_from_email == my_email:
            counters["conversation_waiting_on_other_side"] += 1
            continue

        inbound_text = message_text(inbound)
        previous_outbound = latest_outbound_before(
            thread,
            my_email=my_email,
            before_ms=message_internal_ms(inbound),
        )
        previous_outbound_text = message_text(previous_outbound) if previous_outbound else ""
        thread_had_rejection = thread_has_recent_rejection_from_sender(thread, my_email)
        candidate_submission_text = first_non_sender_message_text(thread, my_email)

        if is_closeout_acknowledgement(
            latest_inbound_text=inbound_text,
            thread_had_rejection=thread_had_rejection,
        ):
            archive_thread(gmail_service, thread_id=thread_id, dry_run=config.dry_run)
            counters["conversation_auto_archived_closeout"] += 1
            thread_record["auto_archived_closeout"] = True
            print(f"[archive:closeout] thread={thread_id} subject={subject}")
            continue
        if is_scheduling_closeout(
            latest_inbound_text=inbound_text,
            previous_outbound_text=previous_outbound_text,
        ):
            archive_thread(gmail_service, thread_id=thread_id, dry_run=config.dry_run)
            counters["conversation_auto_archived_scheduling_closeout"] += 1
            thread_record["auto_archived_scheduling_closeout"] = True
            print(f"[archive:scheduling-closeout] thread={thread_id} subject={subject}")
            continue

        draft_decision, draft_reason, draft_confidence = evaluate_draft_decision(
            inbound=inbound,
            latest_inbound_text=inbound_text,
            previous_outbound_text=previous_outbound_text,
            classification_info=info,
            my_email=my_email,
            min_draft_confidence=config.min_draft_confidence,
        )
        thread_record["last_draft_gate"] = draft_reason
        thread_record["last_draft_confidence"] = draft_confidence

        if draft_decision == "skip":
            if (
                thread_record.get("last_drafted_for_message_id") == latest_inbound_id
                and previous_draft_id
                and not previous_draft_id.startswith("DRYRUN-")
            ):
                delete_draft(gmail_service, draft_id=previous_draft_id, dry_run=config.dry_run)
                thread_record["last_drafted_for_message_id"] = ""
                thread_record["last_draft_id"] = ""
                counters["conversation_stale_drafts_deleted"] += 1
                print(f"[draft:deleted-stale] thread={thread_id} draft={previous_draft_id} reason={draft_reason}")
            counters["conversation_non_actionable_skipped"] += 1
            print(f"[skip:draft] thread={thread_id} subject={subject} reason={draft_reason}")
            continue
        if draft_decision == "review":
            if (
                thread_record.get("last_drafted_for_message_id") == latest_inbound_id
                and previous_draft_id
                and not previous_draft_id.startswith("DRYRUN-")
            ):
                delete_draft(gmail_service, draft_id=previous_draft_id, dry_run=config.dry_run)
                thread_record["last_drafted_for_message_id"] = ""
                thread_record["last_draft_id"] = ""
                counters["conversation_stale_drafts_deleted"] += 1
                print(f"[draft:deleted-stale] thread={thread_id} draft={previous_draft_id} reason={draft_reason}")
            add_label_to_thread(
                gmail_service,
                thread_id=thread_id,
                label_id=review_label_id,
                dry_run=config.dry_run,
            )
            slack_status = maybe_notify_slack(
                config=config,
                thread_record=thread_record,
                thread_id=thread_id,
                message=inbound,
                alert_kind="needs_review",
                title="Response needed: Gmail triage needs review",
                reason=draft_reason,
            )
            counters["conversation_needs_review_labeled"] += 1
            record_slack_status(slack_status)
            print(f"[label:needs-review] thread={thread_id} subject={subject} reason={draft_reason}")
            continue
        if (
            thread_record.get("last_drafted_for_message_id") == latest_inbound_id
            and previous_draft_id
            and not previous_draft_id.startswith("DRYRUN-")
        ):
            if config.refresh_existing_drafts and previous_draft_id:
                delete_draft(gmail_service, draft_id=previous_draft_id, dry_run=config.dry_run)
                thread_record["last_drafted_for_message_id"] = ""
                thread_record["last_draft_id"] = ""
                counters["conversation_existing_drafts_refreshed"] += 1
                print(f"[draft:refresh-delete] thread={thread_id} draft={previous_draft_id}")
            else:
                slack_status = maybe_notify_slack(
                    config=config,
                    thread_record=thread_record,
                    thread_id=thread_id,
                    message=inbound,
                    alert_kind="draft_created",
                    title="Response needed: Gmail draft exists",
                    reason=draft_reason,
                    draft_id=previous_draft_id,
                )
                record_slack_status(slack_status)
                counters["conversation_draft_skipped_existing"] += 1
                continue

        draft_body = generate_reply_body(
            subject=subject,
            latest_inbound_text=inbound_text,
            previous_outbound_text=previous_outbound_text,
            from_header=header_map(inbound).get("from", ""),
            style_profile=style_profile,
            thread_had_rejection=thread_had_rejection,
            candidate_submission_text=candidate_submission_text,
        )

        reply_intent = detect_reply_intent(inbound_text, previous_outbound_text)
        quality_reason = draft_quality_reason(
            intent=reply_intent,
            latest_inbound_text=inbound_text,
            draft_body=draft_body,
        )
        if quality_reason:
            if (
                thread_record.get("last_drafted_for_message_id") == latest_inbound_id
                and previous_draft_id
                and not previous_draft_id.startswith("DRYRUN-")
            ):
                delete_draft(gmail_service, draft_id=previous_draft_id, dry_run=config.dry_run)
                thread_record["last_drafted_for_message_id"] = ""
                thread_record["last_draft_id"] = ""
                counters["conversation_stale_drafts_deleted"] += 1
                print(f"[draft:deleted-stale] thread={thread_id} draft={previous_draft_id} reason={quality_reason}")
            add_label_to_thread(
                gmail_service,
                thread_id=thread_id,
                label_id=review_label_id,
                dry_run=config.dry_run,
            )
            slack_status = maybe_notify_slack(
                config=config,
                thread_record=thread_record,
                thread_id=thread_id,
                message=inbound,
                alert_kind="needs_review",
                title="Response needed: Gmail triage needs review",
                reason=quality_reason,
            )
            counters["conversation_needs_review_labeled"] += 1
            counters["conversation_draft_quality_blocked"] += 1
            record_slack_status(slack_status)
            thread_record["last_draft_gate"] = quality_reason
            print(f"[label:needs-review] thread={thread_id} subject={subject} reason={quality_reason}")
            continue

        if config.dry_run:
            draft_id = f"DRYRUN-{thread_id[:8]}"
        else:
            draft_id = create_reply_draft(
                gmail_service,
                thread=thread,
                reply_to_message=inbound,
                sender_email=my_email,
                body_text=draft_body,
            )
            thread_record["last_drafted_for_message_id"] = latest_inbound_id
            thread_record["last_draft_id"] = draft_id
        slack_status = maybe_notify_slack(
            config=config,
            thread_record=thread_record,
            thread_id=thread_id,
            message=inbound,
            alert_kind="draft_created",
            title="Response needed: Gmail draft created",
            reason=draft_reason,
            draft_id=draft_id,
        )
        counters["drafts_created"] += 1
        record_slack_status(slack_status)
        print(f"[draft] thread={thread_id} draft={draft_id} subject={subject}")

    write_json(config.state_file, state)

    print("\nSummary")
    print(f"- inbox_threads_scanned: {len(thread_ids)}")
    print(f"- routed_marketing: {counters.get('routed_marketing', 0)}")
    print(f"- routed_auto: {counters.get('routed_auto', 0)}")
    print(f"- routed_conference: {counters.get('routed_conference', 0)}")
    print(f"- drafts_created: {counters.get('drafts_created', 0)}")
    print(f"- conversation_force_archived_sender: {counters.get('conversation_force_archived_sender', 0)}")
    print(f"- conversation_internal_handoff_archived: {counters.get('conversation_internal_handoff_archived', 0)}")
    print(f"- conversation_internal_fyi_archived: {counters.get('conversation_internal_fyi_archived', 0)}")
    print(f"- conversation_auto_archived_notification: {counters.get('conversation_auto_archived_notification', 0)}")
    print(f"- conversation_support_update_archived: {counters.get('conversation_support_update_archived', 0)}")
    print(f"- conversation_post_event_followup_archived: {counters.get('conversation_post_event_followup_archived', 0)}")
    print(f"- conversation_solicitation_archived: {counters.get('conversation_solicitation_archived', 0)}")
    print(f"- conversation_auto_archived_closeout: {counters.get('conversation_auto_archived_closeout', 0)}")
    print(
        f"- conversation_auto_archived_scheduling_closeout: {counters.get('conversation_auto_archived_scheduling_closeout', 0)}"
    )
    print(f"- conversation_non_actionable_skipped: {counters.get('conversation_non_actionable_skipped', 0)}")
    print(f"- conversation_needs_review_labeled: {counters.get('conversation_needs_review_labeled', 0)}")
    print(f"- conversation_draft_quality_blocked: {counters.get('conversation_draft_quality_blocked', 0)}")
    print(f"- conversation_existing_drafts_refreshed: {counters.get('conversation_existing_drafts_refreshed', 0)}")
    print(f"- conversation_stale_drafts_deleted: {counters.get('conversation_stale_drafts_deleted', 0)}")
    print(f"- conversation_skipped_existing: {counters.get('conversation_draft_skipped_existing', 0)}")
    print(f"- conversation_route_only_skipped: {counters.get('conversation_route_only_skipped', 0)}")
    print(f"- waiting_on_other_side: {counters.get('conversation_waiting_on_other_side', 0)}")
    print(f"- slack_notifications_posted: {counters.get('slack_notifications_posted', 0)}")
    print(f"- slack_notifications_duplicate: {counters.get('slack_notifications_duplicate', 0)}")
    print(f"- slack_notifications_disabled: {counters.get('slack_notifications_disabled', 0)}")
    print(f"- slack_notifications_failed: {counters.get('slack_notifications_failed', 0)}")
    print(f"- slack_notifications_dry_run: {counters.get('slack_notifications_dry_run', 0)}")
    if config.dry_run:
        print("- mode: dry-run (no Gmail mutations)")

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Auto-route marketing/auto inbox threads and draft replies for conversations.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth = subparsers.add_parser("auth", help="Run OAuth flow and verify required Gmail scopes")
    auth.add_argument(
        "--credentials-file",
        default=os.getenv("GOOGLE_GMAIL_CREDENTIALS_FILE", "secrets/google-gmail-credentials.json"),
        help="Path to Google OAuth client credentials JSON",
    )
    auth.add_argument(
        "--token-file",
        default=os.getenv("GOOGLE_GMAIL_TOKEN_FILE", "secrets/google-gmail-token.json"),
        help="Path to OAuth token JSON",
    )

    run = subparsers.add_parser("run", help="Classify inbox threads and create drafts")
    run.add_argument(
        "--credentials-file",
        default=os.getenv("GOOGLE_GMAIL_CREDENTIALS_FILE", "secrets/google-gmail-credentials.json"),
        help="Path to Google OAuth client credentials JSON",
    )
    run.add_argument(
        "--token-file",
        default=os.getenv("GOOGLE_GMAIL_TOKEN_FILE", "secrets/google-gmail-token.json"),
        help="Path to OAuth token JSON",
    )
    run.add_argument(
        "--state-file",
        default=os.getenv("GMAIL_TRIAGE_STATE_FILE", "outputs/gmail/inbox_triage_state.json"),
        help="Path to local triage state JSON",
    )
    run.add_argument(
        "--style-file",
        default=os.getenv("GMAIL_TRIAGE_STYLE_FILE", "outputs/gmail/style_profile.json"),
        help="Path to learned style profile JSON",
    )
    run.add_argument(
        "--max-threads",
        type=int,
        default=int(os.getenv("GMAIL_TRIAGE_MAX_THREADS", "50")),
        help="Maximum inbox threads to process per run",
    )
    run.add_argument(
        "--query",
        default=os.getenv("GMAIL_TRIAGE_QUERY", "-in:chats"),
        help="Additional Gmail query filter applied to inbox message search",
    )
    run.add_argument(
        "--marketing-label",
        default=os.getenv("GMAIL_TRIAGE_MARKETING_LABEL", "gen-marketing"),
        help="Label for marketing/promotional emails",
    )
    run.add_argument(
        "--auto-label",
        default=os.getenv("GMAIL_TRIAGE_AUTO_LABEL", "gen-auto"),
        help="Label for auto-reply/subscription onboarding emails",
    )
    run.add_argument(
        "--conference-label",
        default=os.getenv("GMAIL_TRIAGE_CONFERENCE_LABEL", "gen-conference"),
        help="Label for conference/event-related emails",
    )
    run.add_argument(
        "--review-label",
        default=os.getenv("GMAIL_TRIAGE_REVIEW_LABEL", "gen-needs-review"),
        help="Label for threads that are not safe enough to auto-draft",
    )
    run.add_argument(
        "--style-sample-size",
        type=int,
        default=int(os.getenv("GMAIL_TRIAGE_STYLE_SAMPLE_SIZE", "40")),
        help="Number of recent sent emails used to infer style",
    )
    run.add_argument(
        "--style-cache-ttl-hours",
        type=int,
        default=int(os.getenv("GMAIL_TRIAGE_STYLE_CACHE_TTL_HOURS", "24")),
        help="Reuse cached style profile if sampled within this many hours",
    )
    run.add_argument(
        "--refresh-style-profile",
        action="store_true",
        help="Force recomputing style profile from sent mail on this run",
    )
    run.add_argument(
        "--min-draft-confidence",
        type=int,
        default=int(os.getenv("GMAIL_TRIAGE_MIN_DRAFT_CONFIDENCE", "2")),
        help="Minimum confidence score required before creating a draft reply",
    )
    run.add_argument(
        "--refresh-existing-drafts",
        action="store_true",
        help="Delete and recreate existing drafts for the same latest inbound message",
    )
    run.add_argument(
        "--route-only",
        action="store_true",
        help="Only apply auto/marketing routing; skip conversation draft creation",
    )
    run.add_argument(
        "--slack-token-env",
        default=os.getenv("GMAIL_TRIAGE_SLACK_TOKEN_ENV", "SLACK_BOT_TOKEN"),
        help="Env var containing the Slack token used for response-needed notifications",
    )
    run.add_argument(
        "--slack-channel",
        default=default_slack_channel(),
        help="Slack channel for response-needed notifications",
    )
    run.add_argument(
        "--slack-mention-user-id",
        default=first_env(
            "GMAIL_TRIAGE_SLACK_MENTION_USER_ID",
            "INSTANTLY_POSITIVE_REPLY_SLACK_MENTION_USER_ID",
            "SLACK_USER_ID",
        ),
        help="Optional Slack user ID to mention on response-needed notifications",
    )
    run.add_argument(
        "--no-slack-notifications",
        action="store_true",
        help="Disable Slack response-needed notifications for this run",
    )
    run.add_argument("--dry-run", action="store_true", help="Log intended actions without changing Gmail")

    clean = subparsers.add_parser("clean-drafts", help="Remove banned boilerplate lines from existing drafts")
    clean.add_argument(
        "--credentials-file",
        default=os.getenv("GOOGLE_GMAIL_CREDENTIALS_FILE", "secrets/google-gmail-credentials.json"),
        help="Path to Google OAuth client credentials JSON",
    )
    clean.add_argument(
        "--token-file",
        default=os.getenv("GOOGLE_GMAIL_TOKEN_FILE", "secrets/google-gmail-token.json"),
        help="Path to OAuth token JSON",
    )
    clean.add_argument(
        "--max-drafts",
        type=int,
        default=200,
        help="Maximum drafts to inspect",
    )
    clean.add_argument(
        "--dry-run",
        action="store_true",
        help="Log intended changes without updating drafts",
    )

    clean_handoff = subparsers.add_parser(
        "clean-handoff-drafts",
        help="Delete drafts incorrectly addressed to internal teammates on candidate handoff threads",
    )
    clean_handoff.add_argument(
        "--credentials-file",
        default=os.getenv("GOOGLE_GMAIL_CREDENTIALS_FILE", "secrets/google-gmail-credentials.json"),
        help="Path to Google OAuth client credentials JSON",
    )
    clean_handoff.add_argument(
        "--token-file",
        default=os.getenv("GOOGLE_GMAIL_TOKEN_FILE", "secrets/google-gmail-token.json"),
        help="Path to OAuth token JSON",
    )
    clean_handoff.add_argument(
        "--max-drafts",
        type=int,
        default=500,
        help="Maximum drafts to inspect",
    )
    clean_handoff.add_argument(
        "--dry-run",
        action="store_true",
        help="Log intended changes without deleting drafts",
    )

    clean_sched = subparsers.add_parser(
        "clean-scheduling-closeout-drafts",
        help="Delete drafts on threads that already confirmed booking/scheduling",
    )
    clean_sched.add_argument(
        "--credentials-file",
        default=os.getenv("GOOGLE_GMAIL_CREDENTIALS_FILE", "secrets/google-gmail-credentials.json"),
        help="Path to Google OAuth client credentials JSON",
    )
    clean_sched.add_argument(
        "--token-file",
        default=os.getenv("GOOGLE_GMAIL_TOKEN_FILE", "secrets/google-gmail-token.json"),
        help="Path to OAuth token JSON",
    )
    clean_sched.add_argument(
        "--max-drafts",
        type=int,
        default=500,
        help="Maximum drafts to inspect",
    )
    clean_sched.add_argument(
        "--dry-run",
        action="store_true",
        help="Log intended changes without deleting drafts",
    )

    audit_blocked = subparsers.add_parser(
        "audit-blocked-drafts",
        help="Find and optionally delete drafts addressed to blocked/no-reply senders",
    )
    audit_blocked.add_argument(
        "--credentials-file",
        default=os.getenv("GOOGLE_GMAIL_CREDENTIALS_FILE", "secrets/google-gmail-credentials.json"),
        help="Path to Google OAuth client credentials JSON",
    )
    audit_blocked.add_argument(
        "--token-file",
        default=os.getenv("GOOGLE_GMAIL_TOKEN_FILE", "secrets/google-gmail-token.json"),
        help="Path to OAuth token JSON",
    )
    audit_blocked.add_argument(
        "--max-drafts",
        type=int,
        default=500,
        help="Maximum drafts to inspect",
    )
    audit_blocked.add_argument(
        "--delete",
        action="store_true",
        help="Delete matched drafts (default is report-only)",
    )
    audit_blocked.add_argument(
        "--dry-run",
        action="store_true",
        help="Log intended deletes without mutating drafts",
    )

    return parser.parse_args()


def command_auth(args: argparse.Namespace) -> int:
    credentials_file = resolve_existing_path(args.credentials_file)
    token_file = resolve_existing_path(args.token_file)
    gmail_service = ensure_gmail_service(credentials_file, token_file)
    profile = gmail_service.users().getProfile(userId="me").execute()
    email = profile.get("emailAddress", "<unknown>")
    print("Gmail auth ready")
    print(f"- account: {email}")
    print(f"- token: {token_file}")
    print("- scopes:")
    for scope in SCOPES:
        print(f"  - {scope}")
    return 0


def command_run(args: argparse.Namespace) -> int:
    config = TriageConfig(
        credentials_file=resolve_existing_path(args.credentials_file),
        token_file=resolve_existing_path(args.token_file),
        state_file=resolve_existing_path(args.state_file),
        style_file=resolve_existing_path(args.style_file),
        max_threads=max(1, args.max_threads),
        query=args.query.strip(),
        marketing_label=args.marketing_label.strip(),
        auto_label=args.auto_label.strip(),
        conference_label=args.conference_label.strip(),
        review_label=args.review_label.strip(),
        style_sample_size=max(5, args.style_sample_size),
        style_cache_ttl_hours=max(1, int(args.style_cache_ttl_hours)),
        refresh_style_profile=bool(args.refresh_style_profile),
        min_draft_confidence=max(0, int(args.min_draft_confidence)),
        refresh_existing_drafts=bool(args.refresh_existing_drafts),
        dry_run=bool(args.dry_run),
        route_only=bool(args.route_only),
        slack_token=first_env(args.slack_token_env, "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"),
        slack_channel=normalize_slack_channel(args.slack_channel),
        slack_mention_user_id=args.slack_mention_user_id.strip(),
        slack_notifications=not bool(args.no_slack_notifications),
    )
    return run_triage(config)


def _extract_text_parts(message_obj: EmailMessage) -> list[EmailMessage]:
    if message_obj.is_multipart():
        parts: list[EmailMessage] = []
        for part in message_obj.walk():
            if part.get_content_maintype() == "multipart":
                continue
            if part.get_filename():
                continue
            if part.get_content_type() == "text/plain":
                parts.append(part)
        return parts
    if message_obj.get_content_type() == "text/plain":
        return [message_obj]
    return []


def _strip_banned_lines(text: str) -> tuple[str, bool]:
    lines = text.splitlines()
    kept: list[str] = []
    changed = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("(Context:"):
            changed = True
            continue
        kept.append(line)
    cleaned = "\n".join(kept).strip() + ("\n" if text.endswith("\n") else "")
    return cleaned, changed


def command_clean_drafts(args: argparse.Namespace) -> int:
    credentials_file = resolve_existing_path(args.credentials_file)
    token_file = resolve_existing_path(args.token_file)
    gmail_service = ensure_gmail_service(credentials_file, token_file)
    max_drafts = max(1, int(args.max_drafts))
    dry_run = bool(args.dry_run)

    draft_ids: list[str] = []
    page_token: str | None = None
    while len(draft_ids) < max_drafts:
        resp = (
            gmail_service.users()
            .drafts()
            .list(userId="me", maxResults=min(100, max_drafts - len(draft_ids)), pageToken=page_token)
            .execute()
        )
        for draft in resp.get("drafts", []) or []:
            did = draft.get("id", "")
            if did:
                draft_ids.append(did)
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    scanned = 0
    updated = 0
    for draft_id in draft_ids:
        scanned += 1
        draft = gmail_service.users().drafts().get(userId="me", id=draft_id, format="raw").execute()
        message = draft.get("message", {})
        raw = message.get("raw", "")
        if not raw:
            continue
        raw_bytes = base64.urlsafe_b64decode(raw + "===")
        parsed = BytesParser(policy=policy.default).parsebytes(raw_bytes)

        part_changed = False
        for part in _extract_text_parts(parsed):
            payload_text = part.get_content()
            cleaned_text, changed = _strip_banned_lines(payload_text)
            if not changed:
                continue
            part.set_content(cleaned_text)
            part_changed = True

        if not part_changed:
            continue

        updated += 1
        if dry_run:
            print(f"[clean-drafts:dry-run] draft={draft_id}")
            continue

        new_raw = base64.urlsafe_b64encode(parsed.as_bytes()).decode("utf-8")
        body = {
            "id": draft_id,
            "message": {
                "raw": new_raw,
                "threadId": message.get("threadId", ""),
            },
        }
        gmail_service.users().drafts().update(userId="me", id=draft_id, body=body).execute()
        print(f"[clean-drafts] draft={draft_id}")

    print("Summary")
    print(f"- drafts_scanned: {scanned}")
    print(f"- drafts_updated: {updated}")
    if dry_run:
        print("- mode: dry-run")
    return 0


def command_clean_handoff_drafts(args: argparse.Namespace) -> int:
    credentials_file = resolve_existing_path(args.credentials_file)
    token_file = resolve_existing_path(args.token_file)
    gmail_service = ensure_gmail_service(credentials_file, token_file)
    max_drafts = max(1, int(args.max_drafts))
    dry_run = bool(args.dry_run)

    profile = gmail_service.users().getProfile(userId="me").execute()
    my_email = normalize_email(profile.get("emailAddress", ""))
    if not my_email:
        raise RuntimeError("Unable to read authenticated Gmail profile email")
    in_domains = internal_domains(my_email)

    draft_ids: list[str] = []
    page_token: str | None = None
    while len(draft_ids) < max_drafts:
        resp = (
            gmail_service.users()
            .drafts()
            .list(userId="me", maxResults=min(100, max_drafts - len(draft_ids)), pageToken=page_token)
            .execute()
        )
        for draft in resp.get("drafts", []) or []:
            did = draft.get("id", "")
            if did:
                draft_ids.append(did)
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    scanned = 0
    matched = 0
    deleted = 0
    archived = 0
    thread_cache: dict[str, dict[str, Any]] = {}
    for draft_id in draft_ids:
        scanned += 1
        draft = gmail_service.users().drafts().get(userId="me", id=draft_id, format="metadata").execute()
        message = draft.get("message", {})
        thread_id = message.get("threadId", "")
        if not thread_id:
            continue

        headers = {
            item.get("name", "").lower(): item.get("value", "")
            for item in message.get("payload", {}).get("headers", [])
        }
        to_email = normalize_email(headers.get("to", ""))
        if not to_email:
            continue
        if email_domain(to_email) not in in_domains:
            continue

        thread = thread_cache.get(thread_id)
        if thread is None:
            thread = (
                gmail_service.users()
                .threads()
                .get(
                    userId="me",
                    id=thread_id,
                    format="metadata",
                    metadataHeaders=["From", "To", "Cc", "Subject"],
                )
                .execute()
            )
            thread_cache[thread_id] = thread
        messages = thread.get("messages", [])
        if not messages:
            continue
        last_message = messages[-1]
        if not is_internal_handoff_message(last_message, my_email=my_email):
            continue

        subject = ""
        for item in last_message.get("payload", {}).get("headers", []):
            if item.get("name", "").lower() == "subject":
                subject = item.get("value", "")
                break

        matched += 1
        if dry_run:
            print(f"[clean-handoff:dry-run] draft={draft_id} thread={thread_id} to={to_email} subject={subject}")
            continue

        gmail_service.users().drafts().delete(userId="me", id=draft_id).execute()
        deleted += 1
        archive_thread(gmail_service, thread_id=thread_id, dry_run=False)
        archived += 1
        print(f"[clean-handoff] draft={draft_id} thread={thread_id} to={to_email} subject={subject}")

    print("Summary")
    print(f"- drafts_scanned: {scanned}")
    print(f"- drafts_matched_internal_handoff: {matched}")
    print(f"- drafts_deleted: {deleted}")
    print(f"- threads_archived: {archived}")
    if dry_run:
        print("- mode: dry-run")
    return 0


def command_clean_scheduling_closeout_drafts(args: argparse.Namespace) -> int:
    credentials_file = resolve_existing_path(args.credentials_file)
    token_file = resolve_existing_path(args.token_file)
    gmail_service = ensure_gmail_service(credentials_file, token_file)
    max_drafts = max(1, int(args.max_drafts))
    dry_run = bool(args.dry_run)

    profile = gmail_service.users().getProfile(userId="me").execute()
    my_email = normalize_email(profile.get("emailAddress", ""))
    if not my_email:
        raise RuntimeError("Unable to read authenticated Gmail profile email")

    draft_ids: list[str] = []
    page_token: str | None = None
    while len(draft_ids) < max_drafts:
        resp = (
            gmail_service.users()
            .drafts()
            .list(userId="me", maxResults=min(100, max_drafts - len(draft_ids)), pageToken=page_token)
            .execute()
        )
        for draft in resp.get("drafts", []) or []:
            did = draft.get("id", "")
            if did:
                draft_ids.append(did)
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    scanned = 0
    matched = 0
    deleted = 0
    archived = 0
    thread_cache: dict[str, dict[str, Any]] = {}
    for draft_id in draft_ids:
        scanned += 1
        draft = gmail_service.users().drafts().get(userId="me", id=draft_id, format="metadata").execute()
        message = draft.get("message", {})
        thread_id = message.get("threadId", "")
        if not thread_id:
            continue

        thread = thread_cache.get(thread_id)
        if thread is None:
            thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
            thread_cache[thread_id] = thread
        inbound = latest_inbound_message(thread, my_email)
        if not inbound:
            continue
        inbound_text = message_text(inbound)
        previous_outbound = latest_outbound_before(
            thread,
            my_email=my_email,
            before_ms=message_internal_ms(inbound),
        )
        previous_outbound_text = message_text(previous_outbound) if previous_outbound else ""

        if not is_scheduling_closeout(
            latest_inbound_text=inbound_text,
            previous_outbound_text=previous_outbound_text,
        ):
            continue

        headers = {
            item.get("name", "").lower(): item.get("value", "")
            for item in message.get("payload", {}).get("headers", [])
        }
        subject = headers.get("subject", "")
        to_email = normalize_email(headers.get("to", ""))
        matched += 1

        if dry_run:
            print(
                f"[clean-scheduling-closeout:dry-run] draft={draft_id} thread={thread_id} to={to_email} subject={subject}"
            )
            continue

        delete_draft(gmail_service, draft_id=draft_id, dry_run=False)
        deleted += 1
        archive_thread(gmail_service, thread_id=thread_id, dry_run=False)
        archived += 1
        print(f"[clean-scheduling-closeout] draft={draft_id} thread={thread_id} to={to_email} subject={subject}")

    print("Summary")
    print(f"- drafts_scanned: {scanned}")
    print(f"- drafts_matched_scheduling_closeout: {matched}")
    print(f"- drafts_deleted: {deleted}")
    print(f"- threads_archived: {archived}")
    if dry_run:
        print("- mode: dry-run")
    return 0


def command_audit_blocked_drafts(args: argparse.Namespace) -> int:
    credentials_file = resolve_existing_path(args.credentials_file)
    token_file = resolve_existing_path(args.token_file)
    gmail_service = ensure_gmail_service(credentials_file, token_file)
    max_drafts = max(1, int(args.max_drafts))
    dry_run = bool(args.dry_run)
    should_delete = bool(args.delete)

    profile = gmail_service.users().getProfile(userId="me").execute()
    my_email = normalize_email(profile.get("emailAddress", ""))
    if not my_email:
        raise RuntimeError("Unable to read authenticated Gmail profile email")

    draft_ids: list[str] = []
    page_token: str | None = None
    while len(draft_ids) < max_drafts:
        resp = (
            gmail_service.users()
            .drafts()
            .list(userId="me", maxResults=min(100, max_drafts - len(draft_ids)), pageToken=page_token)
            .execute()
        )
        for draft in resp.get("drafts", []) or []:
            did = draft.get("id", "")
            if did:
                draft_ids.append(did)
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    scanned = 0
    matched = 0
    deleted = 0
    for draft_id in draft_ids:
        scanned += 1
        draft = gmail_service.users().drafts().get(userId="me", id=draft_id, format="metadata").execute()
        message = draft.get("message", {})
        headers = {
            item.get("name", "").lower(): item.get("value", "")
            for item in message.get("payload", {}).get("headers", [])
        }
        to_email = normalize_email(headers.get("to", ""))
        if not to_email:
            continue

        reason = no_reply_address_reason(to_email, my_email=my_email)
        if not reason:
            continue

        matched += 1
        thread_id = message.get("threadId", "")
        subject = headers.get("subject", "")

        if not should_delete or dry_run:
            print(
                f"[audit-blocked-drafts] draft={draft_id} thread={thread_id} to={to_email} reason={reason} subject={subject}"
            )
            continue

        gmail_service.users().drafts().delete(userId="me", id=draft_id).execute()
        deleted += 1
        print(
            f"[audit-blocked-drafts:deleted] draft={draft_id} thread={thread_id} to={to_email} reason={reason} subject={subject}"
        )

    print("Summary")
    print(f"- drafts_scanned: {scanned}")
    print(f"- drafts_matched_blocked_recipient: {matched}")
    print(f"- drafts_deleted: {deleted}")
    if dry_run or not should_delete:
        print("- mode: report-only")
    return 0


def main() -> int:
    load_env_files()
    args = parse_args()
    if args.command == "auth":
        return command_auth(args)
    if args.command == "run":
        return command_run(args)
    if args.command == "clean-drafts":
        return command_clean_drafts(args)
    if args.command == "clean-handoff-drafts":
        return command_clean_handoff_drafts(args)
    if args.command == "clean-scheduling-closeout-drafts":
        return command_clean_scheduling_closeout_drafts(args)
    if args.command == "audit-blocked-drafts":
        return command_audit_blocked_drafts(args)
    raise ValueError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
