#!/usr/bin/env python3
"""Post daily lead progress counts to Slack.

Default behavior:
- Inbound count: messages in #leads containing "Booked Calendly Meeting"
- Outbound count: messages in #gtm-outbound containing "New Meeting"
- Target channel: #gtm-general
- Week is Sunday-Saturday in report timezone.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, Tuple
from zoneinfo import ZoneInfo


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-channel", default=None, help="Slack channel name override")
    parser.add_argument("--dry-run", action="store_true", help="Print message only; do not post")
    return parser.parse_args()


def load_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
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


def get_config(repo_root: Path, args: argparse.Namespace) -> Dict[str, str]:
    env_local = load_env_file(repo_root / ".env.local")
    env_file = load_env_file(repo_root / ".env")

    def pick(key: str, default: str = "") -> str:
        return os.getenv(key) or env_local.get(key) or env_file.get(key) or default

    token = pick("SLACK_USER_TOKEN") or pick("SLACK_BOT_TOKEN")
    if not token:
        raise RuntimeError("Missing SLACK_USER_TOKEN (or SLACK_BOT_TOKEN) in env/.env.local/.env")

    target_override = args.target_channel.strip() if args.target_channel else ""
    return {
        "token": token,
        "inbound_channel": pick("LEAD_REPORT_INBOUND_CHANNEL", "leads"),
        "outbound_channel": pick("LEAD_REPORT_OUTBOUND_CHANNEL", "gtm-outbound"),
        "target_channel": target_override or pick("LEAD_REPORT_TARGET_CHANNEL", "gtm-general"),
        "inbound_phrase": pick("LEAD_REPORT_INBOUND_PHRASE", "Booked Calendly Meeting"),
        "outbound_phrase": pick("LEAD_REPORT_OUTBOUND_PHRASE", "New Meeting"),
        "report_tz": pick("LEAD_REPORT_TIMEZONE", "America/Los_Angeles"),
        "weekly_goal": pick("LEAD_REPORT_WEEKLY_GOAL", "17.5"),
    }


def slack_api(method: str, token: str, params: Dict[str, str], use_get: bool = False) -> Dict:
    headers = {"Authorization": f"Bearer {token}"}
    if use_get:
        url = f"https://slack.com/api/{method}?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=headers)
    else:
        data = urllib.parse.urlencode(params).encode("utf-8")
        req = urllib.request.Request(f"https://slack.com/api/{method}", data=data, headers=headers)

    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        err = payload.get("error", "unknown_error")
        need = payload.get("needed", "")
        raise RuntimeError(f"Slack API {method} failed: {err} needed={need}")
    return payload


def resolve_public_channels(token: str, names: Iterable[str]) -> Dict[str, str]:
    needed = set(names)
    found: Dict[str, str] = {}
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
            name = channel.get("name", "")
            if name in needed:
                found[name] = channel.get("id", "")
        if needed.issubset(found.keys()):
            return found
        cursor = (payload.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            return found


def count_contains_phrase(token: str, channel_id: str, phrase: str, oldest: float, latest: float) -> int:
    total = 0
    cursor = ""
    while True:
        payload = slack_api(
            "conversations.history",
            token,
            {
                "channel": channel_id,
                "oldest": str(oldest),
                "latest": str(latest),
                "inclusive": "true",
                "limit": "200",
                "cursor": cursor,
            },
            use_get=True,
        )
        for msg in payload.get("messages", []):
            if phrase in (msg.get("text") or ""):
                total += 1
        cursor = (payload.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            return total


def build_message(
    now_local: datetime,
    today_inbound: int,
    today_outbound: int,
    week_inbound: int,
    week_outbound: int,
    weekly_goal: float,
) -> str:
    def fmt_num(value: float) -> str:
        text = f"{value:.2f}".rstrip("0").rstrip(".")
        return text if text else "0"

    date_label = f"{now_local.month}/{now_local.day}/{now_local.strftime('%y')}"
    week_total = week_inbound + week_outbound
    remaining = max(weekly_goal - week_total, 0.0)
    if now_local.weekday() == 5:
        return (
            ":star2: Total Count for The Week\n"
            f"Inbound: {week_inbound}\n"
            f"Outbound: {week_outbound}\n"
            f"Total: {week_total}\n"
            "\n"
            f"Weekly Goal: {fmt_num(weekly_goal)}\n"
            f":star2: How many more do we need? {fmt_num(remaining)}"
        )

    today_total = today_inbound + today_outbound
    return (
        f"Today {date_label}\n"
        f"Inbound: {today_inbound}\n"
        f"Outbound: {today_outbound}\n"
        f"Total: {today_total}\n"
        "\n\n"
        "This week so far\n"
        f"Inbound: {week_inbound}\n"
        f"Outbound: {week_outbound}\n"
        f"Total: {week_total}\n"
        "\n"
        f"Weekly Goal: {fmt_num(weekly_goal)}\n"
        f":star2: How many more do we need? {fmt_num(remaining)}"
    )


def compute_counts(config: Dict[str, str]) -> Tuple[datetime, int, int, int, int, str]:
    token = config["token"]
    names = [config["inbound_channel"], config["outbound_channel"], config["target_channel"]]
    channels = resolve_public_channels(token, names)

    for name in names:
        if name not in channels:
            raise RuntimeError(f"Channel not found or not public: #{name}")

    report_tz = ZoneInfo(config["report_tz"])
    now_local = datetime.now(report_tz)
    start_today_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    days_since_sunday = (now_local.weekday() + 1) % 7
    start_week_local = start_today_local - timedelta(days=days_since_sunday)

    def count_for_window(start_local: datetime) -> Tuple[int, int]:
        oldest = start_local.astimezone(timezone.utc).timestamp()
        latest = now_local.astimezone(timezone.utc).timestamp()
        inbound = count_contains_phrase(
            token,
            channels[config["inbound_channel"]],
            config["inbound_phrase"],
            oldest,
            latest,
        )
        outbound = count_contains_phrase(
            token,
            channels[config["outbound_channel"]],
            config["outbound_phrase"],
            oldest,
            latest,
        )
        return inbound, outbound

    today_inbound, today_outbound = count_for_window(start_today_local)
    week_inbound, week_outbound = count_for_window(start_week_local)
    target_channel_id = channels[config["target_channel"]]
    return now_local, today_inbound, today_outbound, week_inbound, week_outbound, target_channel_id


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[2]
    config = get_config(repo_root, args)
    try:
        weekly_goal = float(config["weekly_goal"])
    except ValueError as exc:
        raise RuntimeError(f"Invalid LEAD_REPORT_WEEKLY_GOAL: {config['weekly_goal']}") from exc

    (
        now_local,
        today_inbound,
        today_outbound,
        week_inbound,
        week_outbound,
        target_channel_id,
    ) = compute_counts(config)
    text = build_message(
        now_local,
        today_inbound,
        today_outbound,
        week_inbound,
        week_outbound,
        weekly_goal,
    )

    if args.dry_run:
        print(text)
        return 0

    payload = slack_api(
        "chat.postMessage",
        config["token"],
        {"channel": target_channel_id, "text": text},
        use_get=False,
    )
    print(
        f"posted channel=#{config['target_channel']} "
        f"channel_id={target_channel_id} ts={payload.get('ts')} "
        f"today_inbound={today_inbound} today_outbound={today_outbound} "
        f"week_inbound={week_inbound} week_outbound={week_outbound} "
        f"local_time={now_local.isoformat()}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
