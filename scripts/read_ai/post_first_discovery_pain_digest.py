#!/usr/bin/env python3
"""Post first-discovery-call product-pain insights to Slack."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

INTERNAL_DOMAINS_DEFAULT = ("trytruewind.com",)
NON_CUSTOMER_TITLE_TERMS = (
    "roleplay",
    "role play",
    "training",
    "internal",
    "all-hands",
    "round",
    "hiring",
    "interview",
    "sales planning",
    "hubspot",
    "power hour",
    "sync",
)
LATE_STAGE_TITLE_TERMS = (
    "demo",
    "poc",
    "proof of concept",
    "follow up",
    "follow-up",
    "check in",
    "check-in",
    "review",
    "proposal",
    "kick off",
    "kickoff",
    "onboarding",
    "implementation",
    "security review",
)

# Source priority for quote selection: prefer direct customer asks.
SOURCE_RANK = {"key_question": 0, "topic": 1, "summary": 2}


@dataclass
class CallItem:
    meeting_id: str
    title: str
    report_url: str
    start_time_ms: int
    customer_key: str
    key_questions: list[str]
    topics: list[str]
    summary: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="First discovery call product-pain digest")
    parser.add_argument("--input-meetings-json", default="", help="Optional local meetings JSON (details/expanded).")
    parser.add_argument("--max-meetings", type=int, default=5000, help="Max meetings to fetch from Read.ai list API.")
    parser.add_argument("--timezone", default="America/Los_Angeles", help="Timezone for scheduling and display.")
    parser.add_argument("--cutoff-hour", type=int, default=14, help="Do not run before this local hour on scheduled days.")
    parser.add_argument(
        "--schedule-mode",
        choices=("wed_fri_split", "weekly_wed"),
        default="weekly_wed",
        help="Scheduling/window mode.",
    )
    parser.add_argument("--window-days", type=int, default=7, help="Days to include for weekly_wed mode.")
    parser.add_argument("--target-channel", default="", help="Slack channel (default from env).")
    parser.add_argument("--post-to-slack", action="store_true", help="Post message to Slack.")
    parser.add_argument("--force-run", action="store_true", help="Run even if today is not Wed/Fri.")
    parser.add_argument("--now-iso", default="", help="Override current time (ISO) for testing.")
    parser.add_argument("--output-file", default="", help="Optional path to write generated message.")
    parser.add_argument("--max-quotes-per-bullet", type=int, default=3, help="Max evidence quotes per pain bullet.")
    return parser.parse_args()


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, val = line.split("=", 1)
        values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def compute_config_roots(repo_root: Path) -> list[Path]:
    roots: list[Path] = [repo_root]
    if repo_root.parent.name == ".worktrees":
        roots.append(repo_root.parent.parent)
    ag_home = (os.getenv("AGENTIC_HOME") or "").strip()
    if ag_home:
        roots.append(Path(ag_home).expanduser().resolve())

    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = str(root.resolve())
        if key in seen:
            continue
        seen.add(key)
        unique.append(root.resolve())
    return unique


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def normalize_domain(value: str) -> str:
    text = value.strip().lower()
    if "@" in text:
        text = text.split("@", 1)[1]
    text = re.sub(r"^https?://", "", text)
    text = text.split("/", 1)[0]
    text = text.split(":", 1)[0]
    return text


def participant_external_emails(meeting: dict[str, Any], internal_domains: set[str]) -> list[str]:
    output: set[str] = set()
    for participant in meeting.get("participants") or []:
        if not isinstance(participant, dict):
            continue
        email = (participant.get("email") or "").strip().lower()
        if "@" not in email:
            continue
        if participant.get("attended") is False:
            continue
        domain = normalize_domain(email)
        if domain and domain not in internal_domains:
            output.add(email)
    return sorted(output)


def is_sarah_related(meeting: dict[str, Any], owner_email: str, owner_name: str) -> bool:
    owner_payload = meeting.get("owner") or {}
    if normalize_text(str(owner_payload.get("email") or "")).lower() == owner_email.lower():
        return True
    if normalize_text(str(owner_payload.get("name") or "")).lower() == owner_name.lower():
        return True
    for participant in meeting.get("participants") or []:
        if not isinstance(participant, dict):
            continue
        if normalize_text(str(participant.get("email") or "")).lower() == owner_email.lower():
            return True
        if normalize_text(str(participant.get("name") or "")).lower() == owner_name.lower():
            return True
    return False


def extract_start_ms(meeting: dict[str, Any]) -> int:
    for key in ("start_time_ms", "scheduled_start_time_ms", "end_time_ms", "scheduled_end_time_ms"):
        value = meeting.get(key)
        if isinstance(value, int):
            return value
    return 0


def request_json(url: str, headers: dict[str, str]) -> Any:
    req = urllib.request.Request(url=url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}
    except Exception:
        return request_json_with_curl(url=url, headers=headers)


def request_json_with_curl(url: str, headers: dict[str, str]) -> Any:
    cmd = ["curl", "-sS"]
    for key, value in headers.items():
        cmd.extend(["-H", f"{key}: {value}"])
    cmd.append(url)
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"curl request failed ({result.returncode}): {stderr}")
    raw = result.stdout.strip()
    return json.loads(raw) if raw else {}


def parse_meeting_items(payload: Any) -> tuple[list[dict[str, Any]], str]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)], ""
    if isinstance(payload, dict):
        for key in ("meetings", "data", "results", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                cursor = (
                    payload.get("next_cursor")
                    or payload.get("cursor")
                    or payload.get("next")
                    or payload.get("next_page_token")
                    or ""
                )
                return [item for item in value if isinstance(item, dict)], str(cursor or "")
        if "id" in payload:
            return [payload], ""
    return [], ""


def fetch_meetings_from_api(access_token: str, api_base: str, max_meetings: int = 5000) -> list[dict[str, Any]]:
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    meetings: list[dict[str, Any]] = []
    cursor = ""
    page_size = max(1, min(10, max_meetings))
    max_pages = max(1, (max_meetings + page_size - 1) // page_size)
    for _ in range(max_pages):
        params = {"limit": str(page_size)}
        if cursor:
            params["cursor"] = cursor
        url = f"{api_base.rstrip('/')}/meetings?{urllib.parse.urlencode(params)}"
        payload = request_json(url, headers=headers)
        page_items, next_cursor = parse_meeting_items(payload)
        if not page_items:
            if isinstance(payload, dict):
                err = (
                    payload.get("error_description")
                    or payload.get("error")
                    or payload.get("message")
                    or payload.get("detail")
                    or ""
                )
                if err:
                    raise RuntimeError(f"Read.ai meetings API returned an error: {err}")
            break
        meetings.extend(page_items)
        if len(meetings) >= max_meetings:
            break
        if not next_cursor or next_cursor == cursor:
            break
        cursor = next_cursor
    return meetings[:max_meetings]


def fetch_meeting_detail(access_token: str, api_base: str, meeting_id: str) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    for suffix in (
        f"/meetings/{meeting_id}",
        f"/meetings/{meeting_id}?include=all",
        f"/meetings/{meeting_id}?expand=transcript",
    ):
        url = f"{api_base.rstrip('/')}{suffix}"
        try:
            payload = request_json(url, headers=headers)
        except Exception:
            continue
        if isinstance(payload, dict) and payload.get("id"):
            return payload
    return {}


def refresh_access_token(tokens_path: Path, oauth_state_path: Path) -> str:
    if not tokens_path.exists() or not oauth_state_path.exists():
        return ""
    tokens = json.loads(tokens_path.read_text())
    refresh_token = (tokens.get("refresh_token") or "").strip()
    if not refresh_token:
        return ""

    oauth = json.loads(oauth_state_path.read_text())
    token_endpoint = (oauth.get("token_endpoint") or "").strip()
    if not token_endpoint:
        return ""
    client_id = (oauth.get("client_id") or "").strip()
    client_secret = (oauth.get("client_secret") or "").strip()
    if not client_id or not client_secret:
        return ""

    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "redirect_uri": oauth.get("redirect_uri", ""),
        }
    ).encode("utf-8")
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")

    req = urllib.request.Request(
        token_endpoint,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "Authorization": f"Basic {basic}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return ""

    access = (payload.get("access_token") or "").strip()
    if not access:
        return ""
    merged = dict(tokens)
    merged.update(payload)
    tokens_path.parent.mkdir(parents=True, exist_ok=True)
    tokens_path.write_text(json.dumps(merged, indent=2))
    return access


def resolve_path_with_roots(
    raw_value: str,
    roots: list[Path],
    default_rel: str,
    fallback_absolutes: list[Path],
) -> Path:
    def readable_file(path: Path) -> bool:
        return path.exists() and os.access(path, os.R_OK)

    value = (raw_value or "").strip()
    if value:
        candidate = Path(value)
        if candidate.is_absolute():
            if readable_file(candidate):
                return candidate
        for root in roots:
            rooted = (root / candidate).resolve()
            if readable_file(rooted):
                return rooted
        return (roots[0] / candidate).resolve()

    for root in roots:
        rooted = (root / default_rel).resolve()
        if readable_file(rooted):
            return rooted
    for path in fallback_absolutes:
        if readable_file(path):
            return path
    return (roots[0] / default_rel).resolve()


def resolve_token_paths(env_values: dict[str, str], config_roots: list[Path]) -> tuple[Path, Path]:
    tokens_path = resolve_path_with_roots(
        raw_value=os.getenv("READ_AI_TOKENS_FILE") or env_values.get("READ_AI_TOKENS_FILE") or "",
        roots=config_roots,
        default_rel="secrets/read_ai_tokens.json",
        fallback_absolutes=[Path.home() / "Documents/New project/secrets/read_ai_tokens.json"],
    )
    oauth_state_path = resolve_path_with_roots(
        raw_value=os.getenv("READ_AI_OAUTH_STATE_FILE") or env_values.get("READ_AI_OAUTH_STATE_FILE") or "",
        roots=config_roots,
        default_rel="secrets/read_ai_oauth_state.json",
        fallback_absolutes=[Path.home() / "Documents/New project/secrets/read_ai_oauth_state.json"],
    )
    return tokens_path, oauth_state_path


def get_access_token(
    repo_root: Path,
    env_values: dict[str, str],
    config_roots: list[Path],
    tokens_path: Path,
    oauth_state_path: Path,
) -> str:
    explicit = (os.getenv("READ_AI_ACCESS_TOKEN") or env_values.get("READ_AI_ACCESS_TOKEN") or "").strip()
    if explicit:
        return explicit

    tokens: dict[str, Any] = {}
    if tokens_path.exists():
        try:
            tokens = json.loads(tokens_path.read_text())
        except Exception:
            tokens = {}

    # Prefer refresh on each run when possible so launchd jobs don't fail on token_expired.
    if (tokens.get("refresh_token") or "").strip():
        refreshed = refresh_access_token(tokens_path=tokens_path, oauth_state_path=oauth_state_path)
        if refreshed:
            return refreshed

    access = (tokens.get("access_token") or "").strip()
    if access:
        return access
    return refresh_access_token(tokens_path=tokens_path, oauth_state_path=oauth_state_path)


def classify_first_discovery_calls(
    meetings: list[dict[str, Any]],
    owner_email: str,
    owner_name: str,
    internal_domains: set[str],
) -> list[dict[str, Any]]:
    customer_candidates: list[dict[str, Any]] = []
    for meeting in meetings:
        title = normalize_text(str(meeting.get("title") or ""))
        title_lower = title.lower()
        if any(term in title_lower for term in NON_CUSTOMER_TITLE_TERMS):
            continue
        if all(marker not in title_lower for marker in ("truewind", "intro", "introduction")) and "/" not in title:
            continue
        if not is_sarah_related(meeting, owner_email=owner_email, owner_name=owner_name):
            continue
        external = participant_external_emails(meeting, internal_domains=internal_domains)
        if not external:
            continue
        customer_candidates.append(meeting)

    first_by_customer_key: dict[str, dict[str, Any]] = {}
    for meeting in customer_candidates:
        external = participant_external_emails(meeting, internal_domains=internal_domains)
        if not external:
            continue
        customer_key = external[0].split("@", 1)[1]
        start_ms = extract_start_ms(meeting)
        current = first_by_customer_key.get(customer_key)
        if current is None or (start_ms and start_ms < extract_start_ms(current)):
            first_by_customer_key[customer_key] = meeting

    first_calls = sorted(first_by_customer_key.values(), key=extract_start_ms)
    first_discovery = []
    for meeting in first_calls:
        title_lower = normalize_text(str(meeting.get("title") or "")).lower()
        if any(term in title_lower for term in LATE_STAGE_TITLE_TERMS):
            continue
        first_discovery.append(meeting)
    return first_discovery


def split_sentences(text: str) -> list[str]:
    normalized = normalize_text(text)
    if not normalized:
        return []
    chunks = re.split(r"(?<=[.!?])\s+", normalized)
    return [chunk.strip() for chunk in chunks if chunk.strip()]


def extract_records(call: CallItem) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for item in call.key_questions:
        records.append({"source": "key_question", "text": normalize_text(item)})
    for item in call.topics:
        records.append({"source": "topic", "text": normalize_text(item)})
    if call.summary:
        for sentence in split_sentences(call.summary):
            if len(sentence) >= 40:
                records.append({"source": "summary", "text": sentence})
    return records


def build_pain_categories() -> list[dict[str, Any]]:
    return [
        {
            "title": "Manual accounting workflows are still heavy and brittle.",
            "terms": ("manual", "reconcile", "reconciliation", "spreadsheet", "refresh", "workpaper", "accrual"),
            "exclude": (),
        },
        {
            "title": "System integrations are a core product concern from the first call.",
            "terms": ("integration", "integrate", "quickbooks", "qbo", "sage", "appfolio", "mercury", "sync", "connector"),
            "exclude": ("timeline",),
        },
        {
            "title": "Customers are worried about data quality/control in-sync (not just can it connect).",
            "terms": ("duplicate", "manual refresh", "data flow", "accuracy", "data pushed back", "syncing process"),
            "exclude": (),
        },
        {
            "title": "They expect depth for close/review use cases, not just automation headlines.",
            "terms": ("financial reviews", "flux analysis", "fixed asset", "prepaid", "close", "vendor reviews"),
            "exclude": (),
        },
    ]


def select_quotes_by_category(
    calls: list[CallItem],
    max_quotes_per_bullet: int,
) -> list[tuple[str, list[tuple[str, str]]]]:
    categories = build_pain_categories()
    call_number = {call.meeting_id: idx + 1 for idx, call in enumerate(calls)}
    selected_output: list[tuple[str, list[tuple[str, str]]]] = []

    all_records: list[dict[str, Any]] = []
    for call in calls:
        for record in extract_records(call):
            all_records.append(
                {
                    "meeting_id": call.meeting_id,
                    "title": call.title,
                    "url": call.report_url,
                    "source": record["source"],
                    "text": record["text"],
                    "call_label": f"Call {call_number[call.meeting_id]}",
                }
            )

    for category in categories:
        candidates: list[dict[str, Any]] = []
        for record in all_records:
            text_lower = record["text"].lower()
            if not any(term in text_lower for term in category["terms"]):
                continue
            if any(term in text_lower for term in category["exclude"]):
                continue
            candidates.append(record)

        # Prefer key questions, then topics, then summary. Keep one quote per call.
        candidates.sort(key=lambda item: (SOURCE_RANK.get(item["source"], 9), len(item["text"])))
        chosen: list[tuple[str, str]] = []
        used_calls: set[str] = set()
        used_text: set[str] = set()
        for candidate in candidates:
            dedupe = re.sub(r"\W+", "", candidate["text"].lower())
            if dedupe in used_text:
                continue
            if candidate["meeting_id"] in used_calls:
                continue
            used_text.add(dedupe)
            used_calls.add(candidate["meeting_id"])
            quote = candidate["text"]
            if len(quote) > 220:
                quote = quote[:217].rstrip() + "..."
            chosen.append((quote, f"<{candidate['url']}|{candidate['call_label']}>"))
            if len(chosen) >= max_quotes_per_bullet:
                break
        if chosen:
            selected_output.append((category["title"], chosen))
    return selected_output


def select_fallback_pain_quotes(calls: list[CallItem], max_quotes: int) -> list[tuple[str, str]]:
    pain_terms = (
        "pain",
        "challenge",
        "problem",
        "issue",
        "manual",
        "slow",
        "error",
        "risk",
        "reconcile",
        "reconciliation",
        "close",
        "visibility",
        "confidence",
        "integration",
        "sync",
    )
    call_number = {call.meeting_id: idx + 1 for idx, call in enumerate(calls)}
    candidates: list[dict[str, str]] = []
    for call in calls:
        for record in extract_records(call):
            text = record["text"]
            text_lower = text.lower()
            if not any(term in text_lower for term in pain_terms):
                continue
            candidates.append(
                {
                    "meeting_id": call.meeting_id,
                    "text": text if len(text) <= 220 else text[:217].rstrip() + "...",
                    "url": call.report_url,
                    "label": f"Call {call_number[call.meeting_id]}",
                    "source": record["source"],
                }
            )

    if not candidates:
        return []
    candidates.sort(key=lambda item: (SOURCE_RANK.get(item["source"], 9), len(item["text"])))
    chosen: list[tuple[str, str]] = []
    used_calls: set[str] = set()
    used_text: set[str] = set()
    for item in candidates:
        key = re.sub(r"\W+", "", item["text"].lower())
        if key in used_text or item["meeting_id"] in used_calls:
            continue
        used_text.add(key)
        used_calls.add(item["meeting_id"])
        chosen.append((item["text"], f"<{item['url']}|{item['label']}>"))
        if len(chosen) >= max_quotes:
            break
    return chosen


def format_timestamp(now_local: datetime) -> str:
    return now_local.strftime("%B %-d, %Y %-I:%M %p %Z")


def build_message(now_local: datetime, calls: list[CallItem], max_quotes_per_bullet: int) -> str:
    lines: list[str] = [
        ":star: Learnings from Past Week's Discovery Calls :star:",
        "",
        f"Analyzed from *{len(calls)} first discovery calls* as of *{format_timestamp(now_local)}*",
        "",
    ]
    lines.append("*Pain points:*")

    if not calls:
        lines.append("- *No discovery calls.*")
        return "\n".join(lines)

    selected = select_quotes_by_category(calls=calls, max_quotes_per_bullet=max_quotes_per_bullet)
    if not selected:
        fallback = select_fallback_pain_quotes(calls=calls, max_quotes=max_quotes_per_bullet)
        if not fallback:
            lines.append("- *No product pain points were detected in this first-discovery slice.*")
            return "\n".join(lines)
        lines.append("- *Customers described operational friction in their current process.*")
        for quote, link in fallback:
            lines.append(f'  - "{quote}" — {link}')
        return "\n".join(lines)

    for title, quotes in selected:
        lines.append(f"- *{title}*")
        for quote, link in quotes:
            lines.append(f'  - "{quote}" — {link}')
        lines.append("")
    if lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def format_call_datetime(start_time_ms: int, tz_name: str) -> str:
    if start_time_ms <= 0:
        return "Unknown date/time"
    local = datetime.fromtimestamp(start_time_ms / 1000, tz=timezone.utc).astimezone(ZoneInfo(tz_name))
    return local.strftime("%B %-d, %Y at %-I:%M %p %Z")


def build_supporting_reply(calls: list[CallItem], tz_name: str, start_ms: int, end_ms: int) -> str:
    if not calls:
        start_local = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).astimezone(ZoneInfo(tz_name))
        end_local = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).astimezone(ZoneInfo(tz_name))
        return (
            "Supporting details:\n\n"
            "No first discovery calls found in this posting window.\n"
            f"Window: {start_local.strftime('%B %-d, %Y %-I:%M %p %Z')} -> "
            f"{end_local.strftime('%B %-d, %Y %-I:%M %p %Z')}"
        )

    lines = [f"Supporting details: {len(calls)} first discovery calls in this post window.", ""]
    for idx, call in enumerate(calls, start=1):
        label = call.title or f"Call {idx}"
        lines.append(f"{idx}. {format_call_datetime(call.start_time_ms, tz_name)} — <{call.report_url}|{label}>")
    return "\n".join(lines)


def resolve_window(
    now_local: datetime,
    force_run: bool,
    cutoff_hour: int,
    schedule_mode: str,
    window_days: int,
) -> tuple[tuple[int, int] | None, str]:
    # Monday=0 ... Sunday=6
    weekday = now_local.weekday()
    if schedule_mode == "weekly_wed":
        if not force_run:
            if weekday != 2:  # Wednesday
                return None, "not_scheduled_day"
            cutoff = now_local.replace(hour=cutoff_hour, minute=0, second=0, microsecond=0)
            if now_local < cutoff:
                return None, "before_cutoff"
        start_local = now_local - timedelta(days=max(1, window_days))
    else:
        if not force_run:
            if weekday not in (2, 4):  # Wednesday or Friday
                return None, "not_scheduled_day"
            cutoff = now_local.replace(hour=cutoff_hour, minute=0, second=0, microsecond=0)
            if now_local < cutoff:
                return None, "before_cutoff"

        if weekday == 4:  # Friday: include Thursday + Friday
            days_back = 1
        else:  # Wednesday (or forced non-Friday): include Monday -> current time
            days_back = weekday
        start_local = (now_local - timedelta(days=days_back)).replace(hour=0, minute=0, second=0, microsecond=0)

    start_ms = int(start_local.astimezone(timezone.utc).timestamp() * 1000)
    end_ms = int(now_local.astimezone(timezone.utc).timestamp() * 1000)
    return (start_ms, end_ms), ""


def filter_calls_by_window(calls: list[dict[str, Any]], start_ms: int, end_ms: int) -> list[dict[str, Any]]:
    output = []
    for call in calls:
        start = extract_start_ms(call)
        if start < start_ms or start > end_ms:
            continue
        output.append(call)
    return output


def slack_api(method: str, token: str, params: dict[str, str], use_get: bool = False) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    if use_get:
        url = f"https://slack.com/api/{method}?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=headers)
    else:
        body = urllib.parse.urlencode(params).encode("utf-8")
        req = urllib.request.Request(f"https://slack.com/api/{method}", data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"Slack API {method} failed: {payload.get('error', 'unknown_error')}")
    return payload


def resolve_public_channel(token: str, channel_name: str) -> str:
    cursor = ""
    while True:
        payload = slack_api(
            "conversations.list",
            token,
            {
                "exclude_archived": "true",
                "types": "public_channel",
                "limit": "1000",
                "cursor": cursor,
            },
            use_get=False,
        )
        for channel in payload.get("channels", []):
            if channel.get("name") == channel_name:
                return channel.get("id", "")
        cursor = (payload.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            return ""


def parse_now(now_iso: str, tz_name: str) -> datetime:
    tz = ZoneInfo(tz_name)
    if now_iso.strip():
        parsed = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=tz)
        return parsed.astimezone(tz)
    return datetime.now(tz)


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[2]
    config_roots = compute_config_roots(repo_root=repo_root)
    env_values = {}
    for root in reversed(config_roots):
        env_values.update(load_env_file(root / ".env"))
        env_values.update(load_env_file(root / ".env.local"))

    tz_name = os.getenv("READ_AI_DISCOVERY_PAIN_TZ") or env_values.get("READ_AI_DISCOVERY_PAIN_TZ") or args.timezone
    now_local = parse_now(now_iso=args.now_iso, tz_name=tz_name)
    window, skip_reason = resolve_window(
        now_local=now_local,
        force_run=args.force_run,
        cutoff_hour=args.cutoff_hour,
        schedule_mode=args.schedule_mode,
        window_days=args.window_days,
    )
    if window is None:
        print(f"skip_reason={skip_reason}")
        return 0
    start_ms, end_ms = window

    internal_domains = {
        normalize_domain(item)
        for item in (
            os.getenv("READ_AI_INTERNAL_DOMAINS", "")
            or env_values.get("READ_AI_INTERNAL_DOMAINS", "")
            or ",".join(INTERNAL_DOMAINS_DEFAULT)
        ).split(",")
        if normalize_domain(item)
    }
    owner_email = os.getenv("READ_AI_OWNER_EMAIL") or env_values.get("READ_AI_OWNER_EMAIL") or "sarah@trytruewind.com"
    owner_name = os.getenv("READ_AI_OWNER_NAME") or env_values.get("READ_AI_OWNER_NAME") or "Sarah Elix"

    meetings: list[dict[str, Any]]
    access_token = ""
    api_base = os.getenv("READ_AI_API_BASE") or env_values.get("READ_AI_API_BASE") or "https://api.read.ai/v1"
    tokens_path, oauth_state_path = resolve_token_paths(env_values=env_values, config_roots=config_roots)
    if args.input_meetings_json.strip():
        input_path = Path(args.input_meetings_json)
        if not input_path.is_absolute():
            input_path = (repo_root / input_path).resolve()
        payload = json.loads(input_path.read_text())
        if isinstance(payload, list):
            meetings = [item for item in payload if isinstance(item, dict)]
        else:
            meetings, _ = parse_meeting_items(payload)
    else:
        access_token = get_access_token(
            repo_root=repo_root,
            env_values=env_values,
            config_roots=config_roots,
            tokens_path=tokens_path,
            oauth_state_path=oauth_state_path,
        )
        if not access_token:
            raise RuntimeError("Missing Read.ai access token configuration.")
        try:
            meetings = fetch_meetings_from_api(
                access_token=access_token,
                api_base=api_base,
                max_meetings=args.max_meetings,
            )
        except RuntimeError as exc:
            if "token_expired" not in str(exc):
                raise
            refreshed = refresh_access_token(tokens_path=tokens_path, oauth_state_path=oauth_state_path)
            if not refreshed:
                raise
            access_token = refreshed
            meetings = fetch_meetings_from_api(
                access_token=access_token,
                api_base=api_base,
                max_meetings=args.max_meetings,
            )

    first_discovery = classify_first_discovery_calls(
        meetings=meetings,
        owner_email=owner_email,
        owner_name=owner_name,
        internal_domains=internal_domains,
    )
    slice_calls = filter_calls_by_window(first_discovery, start_ms=start_ms, end_ms=end_ms)

    # If source is list endpoint (no details), fetch details only for slice calls.
    call_items: list[CallItem] = []
    for call in slice_calls:
        detail = call
        if not args.input_meetings_json.strip() and access_token:
            # Pull details for richer key_questions/topics/summary.
            fetched = fetch_meeting_detail(access_token=access_token, api_base=api_base, meeting_id=str(call.get("id") or ""))
            if fetched:
                detail = fetched
        call_items.append(
            CallItem(
                meeting_id=str(detail.get("id") or call.get("id") or ""),
                title=normalize_text(str(detail.get("title") or call.get("title") or "")),
                report_url=str(detail.get("report_url") or call.get("report_url") or ""),
                start_time_ms=extract_start_ms(detail) or extract_start_ms(call),
                customer_key="",  # not used in output
                key_questions=[item for item in (detail.get("key_questions") or []) if isinstance(item, str)],
                topics=[item for item in (detail.get("topics") or []) if isinstance(item, str)],
                summary=str(detail.get("summary") or ""),
            )
        )

    call_items.sort(key=lambda item: item.start_time_ms)
    message = build_message(now_local=now_local, calls=call_items, max_quotes_per_bullet=args.max_quotes_per_bullet)
    supporting_reply = build_supporting_reply(calls=call_items, tz_name=tz_name, start_ms=start_ms, end_ms=end_ms)

    if args.output_file.strip():
        out_path = Path(args.output_file)
        if not out_path.is_absolute():
            out_path = (repo_root / out_path).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(message, encoding="utf-8")
        print(f"output_file={out_path}")

    print(f"first_discovery_total={len(first_discovery)}")
    print(f"window_calls={len(call_items)}")
    print(f"window_start_ms={start_ms}")
    print(f"window_end_ms={end_ms}")
    print(f"schedule_mode={args.schedule_mode}")

    if args.post_to_slack:
        token = (
            os.getenv("SLACK_USER_TOKEN")
            or os.getenv("SLACK_BOT_TOKEN")
            or env_values.get("SLACK_USER_TOKEN")
            or env_values.get("SLACK_BOT_TOKEN")
            or ""
        ).strip()
        if not token:
            raise RuntimeError("Missing Slack token.")
        channel_name = (
            args.target_channel.strip()
            or os.getenv("READ_AI_DISCOVERY_PAIN_CHANNEL")
            or env_values.get("READ_AI_DISCOVERY_PAIN_CHANNEL")
            or "slack-testing"
        )
        channel_id = resolve_public_channel(token=token, channel_name=channel_name)
        if not channel_id:
            raise RuntimeError(f"Slack channel not found: #{channel_name}")
        parent = slack_api(
            "chat.postMessage",
            token,
            {
                "channel": channel_id,
                "text": message,
                "mrkdwn": "true",
                "unfurl_links": "false",
                "unfurl_media": "false",
            },
            use_get=False,
        )
        parent_ts = str(parent.get("ts") or "")
        reply = slack_api(
            "chat.postMessage",
            token,
            {
                "channel": channel_id,
                "thread_ts": parent_ts,
                "text": supporting_reply,
                "mrkdwn": "true",
                "unfurl_links": "false",
                "unfurl_media": "false",
            },
            use_get=False,
        )
        reply_ts = str(reply.get("ts") or "")
        print(f"slack_posted=true channel={channel_name} parent_ts={parent_ts} reply_ts={reply_ts}")
    else:
        print("slack_posted=false")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
