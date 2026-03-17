#!/usr/bin/env python3
"""
Poll Instantly for opt-outs and unsubscribes, then set do_not_contact=true in HubSpot.

Checks two sources:
  1. Recent replies containing opt-out phrases (via GET /api/v2/emails)
  2. Unsubscribed leads (via POST /api/v2/leads/list)

Designed to run on a cron (e.g. every 15 min via GitHub Actions). Since setting
do_not_contact=true is idempotent, overlapping windows are safe.

Usage:
    python scripts/instantly/poll_dnc.py
    python scripts/instantly/poll_dnc.py --lookback-minutes 60 --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request

import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Env loader
# ---------------------------------------------------------------------------

def load_env_defaults() -> None:
    repo_root = Path(__file__).resolve().parent.parent.parent
    for candidate in (repo_root / ".env.local", repo_root / ".env", Path(".env.local"), Path(".env")):
        if not candidate.exists():
            continue
        raw_text = candidate.read_text(encoding="utf-8")
        raw_text = re.sub(r"\n=", "=", raw_text)
        for raw in raw_text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip().strip('"').strip("'")
            os.environ[key] = value
        break


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def api_request(
    method: str,
    url: str,
    headers: dict[str, str],
    body: dict | None = None,
    retries: int = 5,
) -> dict[str, Any] | list:
    data = json.dumps(body).encode("utf-8") if body else None

    for attempt in range(retries + 1):
        req = request.Request(url, data=data, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as exc:
            if exc.code == 429 and attempt < retries:
                retry_after = int(exc.headers.get("Retry-After", 0) or 0)
                wait = max(retry_after, 10)
                print(f"  Rate limited, waiting {wait}s (attempt {attempt + 1})...")
                time.sleep(wait)
                continue
            if exc.code in (500, 502, 503, 504) and attempt < retries:
                time.sleep(2 ** attempt)
                continue
            text = ""
            try:
                text = exc.read().decode("utf-8")
            except Exception:
                pass
            raise RuntimeError(f"API error {exc.code} on {method} {url}: {text}") from exc


# ---------------------------------------------------------------------------
# Instantly helpers
# ---------------------------------------------------------------------------

INSTANTLY_BASE = "https://api.instantly.ai/api/v2"


def instantly_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
    }


def fetch_recent_replies(api_key: str, since: datetime) -> list[dict[str, Any]]:
    """Fetch all received emails since the given timestamp."""
    headers = instantly_headers(api_key)
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    all_emails: list[dict[str, Any]] = []
    cursor: str | None = None

    while True:
        params: dict[str, str] = {
            "email_type": "received",
            "min_timestamp_created": since_iso,
            "limit": "100",
            "sort_order": "desc",
        }
        if cursor:
            params["starting_after"] = cursor

        url = f"{INSTANTLY_BASE}/emails?{parse.urlencode(params)}"
        resp = api_request("GET", url, headers)

        items = resp.get("items", []) if isinstance(resp, dict) else []
        all_emails.extend(items)

        cursor = resp.get("next_starting_after") if isinstance(resp, dict) else None
        if not cursor or not items:
            break
        time.sleep(3.5)  # respect rate limits (20 req/min)

    return all_emails


def fetch_unsubscribed_leads(api_key: str) -> list[dict[str, Any]]:
    """Fetch all unsubscribed leads across campaigns."""
    headers = instantly_headers(api_key)
    all_leads: list[dict[str, Any]] = []
    cursor: str | None = None

    while True:
        body: dict[str, Any] = {
            "filter": "FILTER_VAL_UNSUBSCRIBED",
            "limit": 100,
        }
        if cursor:
            body["starting_after"] = cursor

        url = f"{INSTANTLY_BASE}/leads/list"
        resp = api_request("POST", url, headers, body=body)

        items = resp.get("items", []) if isinstance(resp, dict) else []
        all_leads.extend(items)

        cursor = resp.get("next_starting_after") if isinstance(resp, dict) else None
        if not cursor or not items:
            break
        time.sleep(0.3)

    return all_leads


# ---------------------------------------------------------------------------
# HubSpot helpers
# ---------------------------------------------------------------------------

HUBSPOT_BASE = "https://api.hubapi.com"


def hubspot_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def search_contact_by_email(token: str, email: str) -> dict[str, Any] | None:
    body = {
        "filterGroups": [{
            "filters": [{
                "propertyName": "email",
                "operator": "EQ",
                "value": email,
            }]
        }],
        "properties": ["email", "firstname", "lastname", "do_not_contact"],
        "limit": 1,
    }
    resp = api_request(
        "POST",
        f"{HUBSPOT_BASE}/crm/v3/objects/contacts/search",
        hubspot_headers(token),
        body=body,
    )
    results = resp.get("results", []) if isinstance(resp, dict) else []
    return results[0] if results else None


def set_do_not_contact(token: str, contact_id: str) -> None:
    api_request(
        "PATCH",
        f"{HUBSPOT_BASE}/crm/v3/objects/contacts/{contact_id}",
        hubspot_headers(token),
        body={"properties": {"do_not_contact": "true"}},
    )


# ---------------------------------------------------------------------------
# Opt-out detection
# ---------------------------------------------------------------------------

OPT_OUT_PHRASES = [
    "take me off",
    "unsubscribe",
    "remove me",
    "opt out",
    "opt-out",
    "stop emailing",
    "stop contacting",
    "do not contact",
    "don't contact",
    "not interested",
    "leave me alone",
    "remove my email",
    "take me off your list",
    "no longer interested",
    "please remove",
    "stop sending",
    "don't email",
    "cease and desist",
]


def is_opt_out(text: str) -> bool:
    lower = text.lower()
    return any(phrase in lower for phrase in OPT_OUT_PHRASES)


# ---------------------------------------------------------------------------
# Slack helpers
# ---------------------------------------------------------------------------

SLACK_CHANNEL = "slack-testing"


def slack_api(method: str, token: str, params: dict[str, str]) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(f"https://slack.com/api/{method}", data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(f"Slack API {method} failed: {payload.get('error', 'unknown')}")
    return payload


def resolve_channel_id(token: str, name: str) -> str | None:
    cursor = ""
    while True:
        params: dict[str, str] = {
            "exclude_archived": "true",
            "types": "public_channel",
            "limit": "1000",
        }
        if cursor:
            params["cursor"] = cursor
        payload = slack_api("conversations.list", token, params)
        for ch in payload.get("channels", []):
            if ch.get("name") == name:
                return ch["id"]
        cursor = payload.get("response_metadata", {}).get("next_cursor", "")
        if not cursor:
            break
    return None


def post_slack_notification(
    token: str,
    updated_contacts: list[dict[str, str]],
) -> None:
    """Post a summary of DNC updates to Slack."""
    channel_id = resolve_channel_id(token, SLACK_CHANNEL)
    if not channel_id:
        print(f"  Slack channel #{SLACK_CHANNEL} not found, skipping notification")
        return

    lines = [f"*Instantly DNC Sync* — marked {len(updated_contacts)} contact(s) as Do Not Contact:\n"]
    for c in updated_contacts:
        lines.append(f"• {c['email']} — {c['reason']}")

    text = "\n".join(lines)
    slack_api("chat.postMessage", token, {"channel": channel_id, "text": text})
    print(f"  Posted Slack notification to #{SLACK_CHANNEL}")


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def mark_dnc(
    hubspot_token: str,
    email: str,
    reason: str,
    updated_contacts: list[dict[str, str]],
    dry_run: bool = False,
) -> str:
    """Look up contact in HubSpot and set do_not_contact=true. Returns status."""
    if dry_run:
        print(f"  [DRY RUN] Would mark DNC: {email} ({reason})")
        return "dry_run"

    contact = search_contact_by_email(hubspot_token, email)
    if not contact:
        print(f"  Not in HubSpot: {email}")
        return "not_found"

    contact_id = contact["id"]
    props = contact.get("properties", {})
    name = f"{props.get('firstname', '')} {props.get('lastname', '')}".strip()

    if props.get("do_not_contact") == "true":
        print(f"  Already DNC: {email} ({name})")
        return "already_dnc"

    set_do_not_contact(hubspot_token, contact_id)
    print(f"  Marked DNC: {email} ({name}, id={contact_id}) — {reason}")
    updated_contacts.append({"email": email, "name": name, "reason": reason})
    return "updated"


def process_replies(
    instantly_key: str,
    hubspot_token: str,
    since: datetime,
    updated_contacts: list[dict[str, str]],
    dry_run: bool = False,
) -> dict[str, int]:
    """Check recent replies for opt-out phrases."""
    stats = {"checked": 0, "opt_out": 0, "updated": 0, "already_dnc": 0, "not_found": 0}

    print(f"\nFetching replies since {since.isoformat()}...")
    replies = fetch_recent_replies(instantly_key, since)
    print(f"  Found {len(replies)} replies")

    for reply in replies:
        stats["checked"] += 1
        from_email = (reply.get("from_address_email") or "").strip().lower()
        body_text = reply.get("body", {}).get("text", "") if isinstance(reply.get("body"), dict) else ""

        if not from_email:
            continue

        if not is_opt_out(body_text):
            continue

        stats["opt_out"] += 1
        status = mark_dnc(hubspot_token, from_email, "opt-out reply", updated_contacts, dry_run=dry_run)
        if status == "updated" or status == "dry_run":
            stats["updated"] += 1
        elif status == "already_dnc":
            stats["already_dnc"] += 1
        elif status == "not_found":
            stats["not_found"] += 1

    return stats


def process_unsubscribes(
    instantly_key: str,
    hubspot_token: str,
    updated_contacts: list[dict[str, str]],
    dry_run: bool = False,
) -> dict[str, int]:
    """Check all unsubscribed leads."""
    stats = {"total": 0, "updated": 0, "already_dnc": 0, "not_found": 0}

    print("\nFetching unsubscribed leads...")
    leads = fetch_unsubscribed_leads(instantly_key)
    stats["total"] = len(leads)
    print(f"  Found {len(leads)} unsubscribed leads")

    for lead in leads:
        email = (lead.get("email") or "").strip().lower()
        if not email:
            continue

        status = mark_dnc(hubspot_token, email, "unsubscribed", updated_contacts, dry_run=dry_run)
        if status == "updated" or status == "dry_run":
            stats["updated"] += 1
        elif status == "already_dnc":
            stats["already_dnc"] += 1
        elif status == "not_found":
            stats["not_found"] += 1

    return stats


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Poll Instantly for opt-outs/unsubscribes and set do_not_contact in HubSpot"
    )
    parser.add_argument(
        "--lookback-minutes",
        type=int,
        default=30,
        help="How far back to check for replies (default: 30)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Log actions without updating HubSpot")
    parser.add_argument("--skip-replies", action="store_true", help="Skip checking replies")
    parser.add_argument("--skip-unsubscribes", action="store_true", help="Skip checking unsubscribes")
    parser.add_argument(
        "--instantly-key-env",
        default="INSTANTLY_API_KEY",
        help="Env var for Instantly API key",
    )
    parser.add_argument(
        "--hubspot-key-env",
        default="HUBSPOT_PRIVATE_TOKEN",
        help="Env var for HubSpot token",
    )
    parser.add_argument(
        "--slack-key-env",
        default="SLACK_USER_TOKEN",
        help="Env var for Slack token",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env_defaults()

    instantly_key = os.environ.get(args.instantly_key_env, "").strip()
    hubspot_token = os.environ.get(args.hubspot_key_env, "").strip()
    slack_token = os.environ.get(args.slack_key_env, "").strip()

    if not instantly_key:
        raise SystemExit(f"Missing Instantly API key: {args.instantly_key_env}")
    if not hubspot_token and not args.dry_run:
        raise SystemExit(f"Missing HubSpot token: {args.hubspot_key_env}")

    mode = " [DRY RUN]" if args.dry_run else ""
    print(f"Instantly → HubSpot DNC poll{mode}")

    since = datetime.now(timezone.utc) - timedelta(minutes=args.lookback_minutes)
    updated_contacts: list[dict[str, str]] = []

    # 1. Check recent replies for opt-out phrases
    reply_stats = {"checked": 0, "opt_out": 0, "updated": 0}
    if not args.skip_replies:
        reply_stats = process_replies(instantly_key, hubspot_token, since, updated_contacts, dry_run=args.dry_run)

    # 2. Check unsubscribed leads
    unsub_stats = {"total": 0, "updated": 0}
    if not args.skip_unsubscribes:
        unsub_stats = process_unsubscribes(instantly_key, hubspot_token, updated_contacts, dry_run=args.dry_run)

    # 3. Post Slack notification if any contacts were actually updated
    if updated_contacts and slack_token and not args.dry_run:
        post_slack_notification(slack_token, updated_contacts)
    elif updated_contacts and not slack_token:
        print("  No Slack token, skipping notification")

    # Summary
    print(f"\n{'='*50}")
    print(f"Replies checked:       {reply_stats.get('checked', 0)}")
    print(f"Opt-out replies:       {reply_stats.get('opt_out', 0)}")
    print(f"DNC from replies:      {reply_stats.get('updated', 0)}")
    print(f"Unsubscribed leads:    {unsub_stats.get('total', 0)}")
    print(f"DNC from unsubscribes: {unsub_stats.get('updated', 0)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
