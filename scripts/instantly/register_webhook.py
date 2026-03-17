#!/usr/bin/env python3
"""
Register, list, or delete Instantly webhooks for the DNC automation.

Usage:
    python scripts/instantly/register_webhook.py --action register --webhook-url https://your-domain.com/
    python scripts/instantly/register_webhook.py --action list
    python scripts/instantly/register_webhook.py --action delete --webhook-id <id>
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib import error, request


INSTANTLY_API_BASE = "https://api.instantly.ai/api/v2"
EVENT_TYPES = ["reply_received", "lead_unsubscribed"]


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


def instantly_request(
    method: str,
    path: str,
    api_key: str,
    body: dict | None = None,
) -> dict[str, Any]:
    url = f"{INSTANTLY_API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body else None

    req = request.Request(url, data=data, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        text = ""
        try:
            text = exc.read().decode("utf-8")
        except Exception:
            pass
        raise RuntimeError(f"Instantly API error {exc.code}: {text}") from exc


def register_webhooks(api_key: str, webhook_url: str) -> None:
    """Register webhooks for each event type."""
    for event_type in EVENT_TYPES:
        print(f"Registering webhook for '{event_type}'...")
        resp = instantly_request(
            "POST",
            "/webhooks",
            api_key,
            body={
                "url": webhook_url,
                "event_type": event_type,
            },
        )
        webhook_id = resp.get("id", "unknown")
        print(f"  Created webhook {webhook_id} for {event_type}")
    print("\nDone. Webhooks registered.")


def list_webhooks(api_key: str) -> None:
    """List all registered webhooks."""
    resp = instantly_request("GET", "/webhooks", api_key)
    webhooks = resp if isinstance(resp, list) else resp.get("data", resp.get("webhooks", []))

    if not webhooks:
        print("No webhooks registered.")
        return

    print(f"Found {len(webhooks)} webhook(s):\n")
    for wh in webhooks:
        wh_id = wh.get("id", "?")
        url = wh.get("url", "?")
        event = wh.get("event_type", "?")
        print(f"  ID: {wh_id}")
        print(f"  URL: {url}")
        print(f"  Event: {event}")
        print()


def delete_webhook(api_key: str, webhook_id: str) -> None:
    """Delete a webhook by ID."""
    instantly_request("DELETE", f"/webhooks/{webhook_id}", api_key)
    print(f"Deleted webhook {webhook_id}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Register/list/delete Instantly webhooks for DNC automation"
    )
    parser.add_argument(
        "--action",
        choices=["register", "list", "delete"],
        required=True,
        help="Action to perform",
    )
    parser.add_argument("--webhook-url", help="Public URL for webhook (required for register)")
    parser.add_argument("--webhook-id", help="Webhook ID (required for delete)")
    parser.add_argument(
        "--api-key-env",
        default="INSTANTLY_API_KEY",
        help="Env var for Instantly API key",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env_defaults()

    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        raise SystemExit(f"Missing Instantly API key: {args.api_key_env}")

    if args.action == "register":
        if not args.webhook_url:
            raise SystemExit("--webhook-url is required for register action")
        register_webhooks(api_key, args.webhook_url)
    elif args.action == "list":
        list_webhooks(api_key)
    elif args.action == "delete":
        if not args.webhook_id:
            raise SystemExit("--webhook-id is required for delete action")
        delete_webhook(api_key, args.webhook_id)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
