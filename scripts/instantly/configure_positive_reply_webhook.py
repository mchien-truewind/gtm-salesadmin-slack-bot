#!/usr/bin/env python3
"""Create or update the all-campaign Instantly positive-reply webhook."""
from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib import error, request


INSTANTLY_BASE = "https://api.instantly.ai/api/v2"
DEFAULT_WEBHOOK_NAME = "Slack positive reply alert"
DEFAULT_WEBHOOK_PATH = "/webhooks/instantly/positive-reply"
POSITIVE_REPLY_EVENT = "lead_interested"


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
            os.environ[key] = value.strip().strip('"').strip("'")
        break


def instantly_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "agentic-lite-instantly-positive-reply-webhook",
    }


def api_request(
    method: str,
    path: str,
    api_key: str,
    body: dict[str, Any] | None = None,
    retries: int = 4,
) -> dict[str, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    url = f"{INSTANTLY_BASE}{path}"
    for attempt in range(retries + 1):
        req = request.Request(url, data=data, headers=instantly_headers(api_key), method=method)
        try:
            with request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as exc:
            if exc.code == 429 and attempt < retries:
                wait = int(exc.headers.get("Retry-After", "0") or "0") or 10
                time.sleep(wait)
                continue
            if exc.code in (500, 502, 503, 504) and attempt < retries:
                time.sleep(2**attempt)
                continue
            text = ""
            try:
                text = exc.read().decode("utf-8")
            except Exception:
                pass
            raise RuntimeError(f"Instantly API error {exc.code} on {method} {path}: {text}") from exc

    raise RuntimeError(f"Instantly API request exhausted retries: {method} {path}")


def build_target_url(base_url: str, explicit_url: str = "") -> str:
    if explicit_url.strip():
        target_url = explicit_url.strip()
    else:
        cleaned_base = base_url.strip().rstrip("/")
        if not cleaned_base:
            raise ValueError("Missing webhook URL. Set --target-url or INSTANTLY_POSITIVE_REPLY_WEBHOOK_URL.")
        target_url = f"{cleaned_base}{DEFAULT_WEBHOOK_PATH}"

    if not target_url.startswith(("https://", "http://")):
        raise ValueError("Webhook URL must start with http:// or https://")
    return target_url


def build_webhook_body(
    *,
    target_url: str,
    name: str,
    webhook_secret: str = "",
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "target_hook_url": target_url,
        "campaign": None,
        "name": name,
        "event_type": POSITIVE_REPLY_EVENT,
    }
    if webhook_secret:
        body["headers"] = {"X-INSTANTLY-WEBHOOK-SECRET": webhook_secret}
    return body


def list_webhooks(api_key: str) -> list[dict[str, Any]]:
    webhooks: list[dict[str, Any]] = []
    cursor = ""
    while True:
        params = f"?event_type={POSITIVE_REPLY_EVENT}&limit=100"
        if cursor:
            params += f"&starting_after={cursor}"
        payload = api_request("GET", f"/webhooks{params}", api_key)
        items = payload.get("items", []) if isinstance(payload, dict) else []
        webhooks.extend(item for item in items if isinstance(item, dict))
        cursor = payload.get("next_starting_after", "") if isinstance(payload, dict) else ""
        if not cursor:
            return webhooks


def is_workspace_positive_reply_webhook(webhook: dict[str, Any]) -> bool:
    return (
        webhook.get("event_type") == POSITIVE_REPLY_EVENT
        and webhook.get("campaign") in (None, "")
    )


def find_existing_webhook(webhooks: list[dict[str, Any]], name: str, target_url: str) -> dict[str, Any] | None:
    for webhook in webhooks:
        if webhook.get("target_hook_url") == target_url and is_workspace_positive_reply_webhook(webhook):
            return webhook
    for webhook in webhooks:
        if webhook.get("name") == name and is_workspace_positive_reply_webhook(webhook):
            return webhook
    return None


def upsert_webhook(api_key: str, body: dict[str, Any], dry_run: bool = False) -> tuple[str, dict[str, Any]]:
    existing = find_existing_webhook(
        list_webhooks(api_key),
        name=str(body["name"]),
        target_url=str(body["target_hook_url"]),
    )
    if dry_run:
        return ("would_update" if existing else "would_create"), body

    if existing:
        webhook_id = existing["id"]
        payload = api_request("PATCH", f"/webhooks/{webhook_id}", api_key, body)
        return "updated", payload

    payload = api_request("POST", "/webhooks", api_key, body)
    return "created", payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Build the payload without changing Instantly.")
    parser.add_argument("--name", default=DEFAULT_WEBHOOK_NAME, help="Webhook name to create/update.")
    parser.add_argument(
        "--target-url",
        default="",
        help="Full webhook URL. Defaults to INSTANTLY_POSITIVE_REPLY_WEBHOOK_URL or PUBLIC_BASE_URL + path.",
    )
    parser.add_argument(
        "--instantly-key-env",
        default="INSTANTLY_API_KEY",
        help="Env var containing the Instantly API v2 key.",
    )
    parser.add_argument(
        "--webhook-secret-env",
        default="INSTANTLY_WEBHOOK_SECRET",
        help="Env var containing the optional shared webhook secret.",
    )
    return parser.parse_args()


def main() -> int:
    load_env_defaults()
    args = parse_args()

    api_key = os.environ.get(args.instantly_key_env, "").strip()
    if not api_key:
        raise SystemExit(f"Missing Instantly API key: {args.instantly_key_env}")

    target_url = build_target_url(
        os.environ.get("INSTANTLY_POSITIVE_REPLY_WEBHOOK_URL", "").strip()
        or os.environ.get("PUBLIC_BASE_URL", "").strip(),
        explicit_url=args.target_url,
    )
    secret = os.environ.get(args.webhook_secret_env, "").strip()
    body = build_webhook_body(target_url=target_url, name=args.name, webhook_secret=secret)
    action, payload = upsert_webhook(api_key, body, dry_run=args.dry_run)

    webhook_id = payload.get("id", "") if isinstance(payload, dict) else ""
    print(f"action={action}")
    print(f"event_type={POSITIVE_REPLY_EVENT}")
    print("campaign=all")
    print(f"target_url={target_url}")
    print(f"secret_header={'configured' if secret else 'not_configured'}")
    if webhook_id:
        print(f"webhook_id={webhook_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
