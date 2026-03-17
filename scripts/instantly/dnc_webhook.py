#!/usr/bin/env python3
"""
Webhook listener for Instantly → HubSpot "Do Not Contact" automation.

Listens for Instantly webhook events (lead_unsubscribed, reply_received) and
sets do_not_contact=true on the matching HubSpot contact record.

Usage:
    python scripts/instantly/dnc_webhook.py
    python scripts/instantly/dnc_webhook.py --port 8900 --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib import error, request


# ---------------------------------------------------------------------------
# Env loader (same pattern as hubspot_linkedin_enrich.py)
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
# HubSpot helpers
# ---------------------------------------------------------------------------

HUBSPOT_BASE = "https://api.hubapi.com"


def hubspot_request(
    method: str,
    path: str,
    token: str,
    body: dict | None = None,
    retries: int = 3,
) -> dict[str, Any]:
    url = f"{HUBSPOT_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body else None

    for attempt in range(retries + 1):
        req = request.Request(url, data=data, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as exc:
            if exc.code == 429 and attempt < retries:
                retry_after = int(exc.headers.get("Retry-After", 2))
                time.sleep(retry_after)
                continue
            if exc.code in (500, 502, 503, 504) and attempt < retries:
                time.sleep(2 ** attempt)
                continue
            text = ""
            try:
                text = exc.read().decode("utf-8")
            except Exception:
                pass
            raise RuntimeError(f"HubSpot API error {exc.code}: {text}") from exc


def search_contact_by_email(token: str, email: str) -> dict[str, Any] | None:
    """Search HubSpot for a contact by email. Returns first match or None."""
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
    resp = hubspot_request("POST", "/crm/v3/objects/contacts/search", token, body=body)
    results = resp.get("results", [])
    return results[0] if results else None


def set_do_not_contact(token: str, contact_id: str) -> None:
    """Set do_not_contact=true on a HubSpot contact."""
    hubspot_request(
        "PATCH",
        f"/crm/v3/objects/contacts/{contact_id}",
        token,
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
    """Check if reply text contains an opt-out phrase."""
    lower = text.lower()
    return any(phrase in lower for phrase in OPT_OUT_PHRASES)


# ---------------------------------------------------------------------------
# Webhook handler
# ---------------------------------------------------------------------------

class WebhookHandler(BaseHTTPRequestHandler):
    dry_run: bool = False
    hubspot_token: str = ""

    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(content_length) if content_length else b""

        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._respond(400, {"error": "invalid JSON"})
            return

        event_type = payload.get("event_type", "")
        # Instantly may nest lead data differently; normalize email extraction
        lead_email = (
            payload.get("lead_email", "")
            or payload.get("email", "")
            or payload.get("lead", {}).get("email", "")
            or ""
        ).strip().lower()

        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        if not lead_email:
            print(f"[{ts}] {event_type} — no email in payload, skipping")
            self._respond(200, {"status": "skipped", "reason": "no_email"})
            return

        should_dnc = False
        reason = ""

        if event_type == "lead_unsubscribed":
            should_dnc = True
            reason = "unsubscribed"
        elif event_type == "reply_received":
            reply_text = (
                payload.get("reply_text", "")
                or payload.get("text", "")
                or payload.get("body", "")
                or ""
            )
            if is_opt_out(reply_text):
                should_dnc = True
                reason = "opt-out reply"
            else:
                print(f"[{ts}] reply_received from {lead_email} — not an opt-out, ignoring")
                self._respond(200, {"status": "ignored", "reason": "not_opt_out"})
                return
        else:
            print(f"[{ts}] unknown event_type '{event_type}', ignoring")
            self._respond(200, {"status": "ignored", "reason": "unknown_event"})
            return

        # Look up contact in HubSpot
        print(f"[{ts}] {event_type} from {lead_email} ({reason}) — searching HubSpot...")

        if self.dry_run:
            print(f"[{ts}] [DRY RUN] Would set do_not_contact=true for {lead_email}")
            self._respond(200, {"status": "dry_run", "email": lead_email, "reason": reason})
            return

        contact = search_contact_by_email(self.hubspot_token, lead_email)
        if not contact:
            print(f"[{ts}] Contact not found in HubSpot: {lead_email}")
            self._respond(200, {"status": "contact_not_found", "email": lead_email})
            return

        contact_id = contact["id"]
        name = f"{contact.get('properties', {}).get('firstname', '')} {contact.get('properties', {}).get('lastname', '')}".strip()
        current_dnc = contact.get("properties", {}).get("do_not_contact", "")

        if current_dnc == "true":
            print(f"[{ts}] {lead_email} ({name}) already do_not_contact=true, no-op")
            self._respond(200, {"status": "already_dnc", "email": lead_email, "contact_id": contact_id})
            return

        set_do_not_contact(self.hubspot_token, contact_id)
        print(f"[{ts}] Set do_not_contact=true for {lead_email} ({name}, id={contact_id})")
        self._respond(200, {"status": "updated", "email": lead_email, "contact_id": contact_id, "reason": reason})

    def do_GET(self) -> None:
        """Health check endpoint."""
        self._respond(200, {"status": "ok", "service": "instantly-dnc-webhook"})

    def _respond(self, code: int, body: dict) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def log_message(self, format: str, *args: Any) -> None:
        # Suppress default access logs (we log our own)
        pass


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Instantly → HubSpot Do-Not-Contact webhook listener"
    )
    parser.add_argument("--port", type=int, default=8900, help="Port to listen on (default: 8900)")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind (default: 0.0.0.0)")
    parser.add_argument("--dry-run", action="store_true", help="Log actions without updating HubSpot")
    parser.add_argument(
        "--hubspot-key-env",
        default="HUBSPOT_PRIVATE_TOKEN",
        help="Env var for HubSpot token",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env_defaults()

    hubspot_token = os.environ.get(args.hubspot_key_env, "").strip()
    if not hubspot_token and not args.dry_run:
        raise SystemExit(f"Missing HubSpot token: {args.hubspot_key_env}")

    WebhookHandler.dry_run = args.dry_run
    WebhookHandler.hubspot_token = hubspot_token

    server = HTTPServer((args.host, args.port), WebhookHandler)
    mode = " [DRY RUN]" if args.dry_run else ""
    print(f"Instantly DNC webhook listening on {args.host}:{args.port}{mode}")
    print("Waiting for events...")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
