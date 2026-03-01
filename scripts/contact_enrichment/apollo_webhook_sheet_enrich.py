#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request

SOURCE_REQUIRED_COLUMNS = [
    "first name",
    "last name",
    "company",
    "title",
    "city",
    "state",
    "country",
]

TARGET_COLUMNS = [
    "first name",
    "last name",
    "company",
    "title",
    "email",
    "phone",
    "city",
    "state",
    "country",
]


def load_env_defaults() -> None:
    """Lightweight .env/.env.local loader without third-party deps."""
    for candidate in (Path('.env.local'), Path('.env')):
        if not candidate.exists():
            continue
        for raw in candidate.read_text(encoding='utf-8').splitlines():
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            if not key or key in os.environ:
                continue
            value = value.strip().strip('"').strip("'")
            os.environ[key] = value


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def require_google_deps():
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Missing Google API deps. Install: pip install google-api-python-client google-auth google-auth-httplib2"
        ) from exc
    return Request, Credentials, build


def load_sheets_service(token_file: Path):
    Request, Credentials, build = require_google_deps()
    scopes = ["https://www.googleapis.com/auth/drive"]
    creds = Credentials.from_authorized_user_file(str(token_file), scopes)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text(creds.to_json(), encoding="utf-8")
    if not creds.valid:
        raise RuntimeError(
            f"Google token is invalid: {token_file}. Re-auth and retry."
        )
    return build("sheets", "v4", credentials=creds)


def _normalize_header(value: str) -> str:
    return " ".join((value or "").strip().lower().replace("_", " ").split())


def _row_to_dict(headers: list[str], row_values: list[str]) -> dict[str, str]:
    row: dict[str, str] = {}
    for i, header in enumerate(headers):
        row[header] = row_values[i] if i < len(row_values) else ""
    return row


def _pick(row: dict[str, str], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _identity_key(first_name: str, last_name: str, company: str, title: str) -> str:
    return "||".join(
        [
            (first_name or "").strip().lower(),
            (last_name or "").strip().lower(),
            (company or "").strip().lower(),
            (title or "").strip().lower(),
        ]
    )


def ensure_tab(sheets, spreadsheet_id: str, tab_name: str) -> int:
    meta = sheets.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    for sheet in meta.get("sheets", []):
        props = sheet.get("properties", {})
        if props.get("title") == tab_name:
            return int(props.get("sheetId"))

    sheets.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": [{"addSheet": {"properties": {"title": tab_name}}}]},
    ).execute()
    meta = sheets.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    for sheet in meta.get("sheets", []):
        props = sheet.get("properties", {})
        if props.get("title") == tab_name:
            return int(props.get("sheetId"))
    raise RuntimeError(f"Failed to create/find tab: {tab_name}")


def read_source_rows(sheets, spreadsheet_id: str, tab_name: str) -> list[dict[str, str]]:
    resp = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=f"'{tab_name}'!A:Z")
        .execute()
    )
    values = resp.get("values", [])
    if not values:
        return []

    headers = [_normalize_header(v) for v in values[0]]
    data_rows = values[1:]
    rows = [_row_to_dict(headers, row) for row in data_rows]

    normalized: list[dict[str, str]] = []
    for row in rows:
        out = {
            "first name": _pick(row, "first name", "firstname", "first_name"),
            "last name": _pick(row, "last name", "lastname", "last_name"),
            "company": _pick(row, "company", "organization", "organization name"),
            "title": _pick(row, "title", "job title", "role"),
            "city": _pick(row, "city"),
            "state": _pick(row, "state", "province", "region"),
            "country": _pick(row, "country"),
        }
        normalized.append(out)

    for column in SOURCE_REQUIRED_COLUMNS:
        if column not in normalized[0]:
            raise RuntimeError(f"Source tab missing required column: {column}")
    return normalized


def read_existing_target_map(
    sheets, spreadsheet_id: str, tab_name: str
) -> dict[str, dict[str, str]]:
    resp = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=f"'{tab_name}'!A:I")
        .execute()
    )
    values = resp.get("values", [])
    if not values:
        return {}

    headers = [_normalize_header(v) for v in values[0]]
    rows = [_row_to_dict(headers, row) for row in values[1:]]
    result: dict[str, dict[str, str]] = {}

    for row in rows:
        first_name = _pick(row, "first name", "firstname", "first_name")
        last_name = _pick(row, "last name", "lastname", "last_name")
        company = _pick(row, "company")
        title = _pick(row, "title", "job title", "role")
        email = _pick(row, "email")
        phone = _pick(row, "phone")
        if not (first_name or last_name or company):
            continue
        key = _identity_key(first_name, last_name, company, title)
        result[key] = {"email": email, "phone": phone}
    return result


def write_target_rows(
    sheets,
    spreadsheet_id: str,
    tab_name: str,
    rows: list[dict[str, str]],
) -> None:
    values = [TARGET_COLUMNS]
    for row in rows:
        values.append([row.get(col, "") for col in TARGET_COLUMNS])

    sheets.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id,
        range=f"'{tab_name}'!A:I",
    ).execute()
    sheets.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"'{tab_name}'!A1",
        valueInputOption="RAW",
        body={"values": values},
    ).execute()


def create_webhook_site_token() -> tuple[str, str]:
    req = request.Request(
        "https://webhook.site/token",
        data=b"{}",
        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
        method="POST",
    )
    with request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    token = payload["uuid"]
    return token, f"https://webhook.site/{token}"


def apollo_match(
    api_key: str,
    first_name: str,
    last_name: str,
    organization_name: str,
    person_title: str,
    webhook_url: str,
    retries: int = 3,
) -> tuple[int, dict[str, Any]]:
    payload: dict[str, Any] = {
        "first_name": first_name,
        "last_name": last_name,
        "organization_name": organization_name,
        "reveal_phone_number": True,
        "webhook_url": webhook_url,
    }
    if person_title:
        payload["person_title"] = person_title

    body = json.dumps(payload).encode("utf-8")
    headers = {
        "X-Api-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
    }

    for attempt in range(retries + 1):
        req = request.Request(
            "https://api.apollo.io/api/v1/people/match",
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=30) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as exc:
            text = ""
            try:
                text = exc.read().decode("utf-8")
            except Exception:
                pass
            if exc.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep((2**attempt) * 0.8)
                continue
            return exc.code, {"_error": text}
        except Exception as exc:
            if attempt < retries:
                time.sleep((2**attempt) * 0.8)
                continue
            return -1, {"_error": str(exc)}


def _extract_email(person: dict[str, Any]) -> str:
    for key in ("email", "work_email", "personal_email"):
        value = person.get(key)
        if isinstance(value, str) and "@" in value:
            return value.strip()
    emails = person.get("emails") or []
    if isinstance(emails, list):
        for item in emails:
            if isinstance(item, dict):
                for key in ("email", "address", "value"):
                    value = item.get(key)
                    if isinstance(value, str) and "@" in value:
                        return value.strip()
            elif isinstance(item, str) and "@" in item:
                return item.strip()
    return ""


def _extract_immediate_phone(person: dict[str, Any]) -> str:
    nums = person.get("phone_numbers") or []
    if isinstance(nums, list) and nums:
        first = nums[0]
        if isinstance(first, dict):
            for key in ("raw_number", "sanitized_number", "number"):
                value = first.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        elif isinstance(first, str):
            return first.strip()
    return ""


def fetch_webhook_requests(token: str, page: int = 1) -> dict[str, Any]:
    url = f"https://webhook.site/token/{token}/requests?sorting=newest&page={page}"
    req = request.Request(url, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"})
    with request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def empty_stats() -> dict[str, Any]:
    return {
        "apollo_requests_sent": 0,
        "apollo_http_200": 0,
        "apollo_http_errors": 0,
        "apollo_person_id_missing": 0,
        "reused_email_rows": 0,
        "reused_phone_rows": 0,
        "reused_full_rows": 0,
        "skipped_already_enriched": 0,
        "webhook_callbacks_seen": 0,
        "webhook_callbacks_parsed": 0,
        "webhook_phones_applied": 0,
        "webhook_credits_consumed_sum": 0,
        "sheet_writes": 0,
    }


@dataclass
class RuntimeConfig:
    sheet_id: str
    source_tab: str
    target_tab: str
    apollo_key: str
    state_file: Path
    summary_file: Path
    google_token_file: Path
    submit_sleep_seconds: float
    poll_seconds: float
    max_poll_minutes: float
    save_every: int
    write_every: int
    submit_write_every: int
    max_submit: int | None


def initialize_state(
    source_rows: list[dict[str, str]],
    cfg: RuntimeConfig,
    webhook_token: str,
    webhook_url: str,
    existing_target_map: dict[str, dict[str, str]] | None = None,
) -> dict[str, Any]:
    stats = empty_stats()
    rows: dict[str, dict[str, Any]] = {}
    for index, src in enumerate(source_rows):
        key = str(index)
        first_name = src.get("first name", "")
        last_name = src.get("last name", "")
        company = src.get("company", "")
        title = src.get("title", "")
        lookup_key = _identity_key(first_name, last_name, company, title)
        existing = (existing_target_map or {}).get(lookup_key, {})
        existing_email = str(existing.get("email", "")).strip()
        existing_phone = str(existing.get("phone", "")).strip()

        if existing_email:
            stats["reused_email_rows"] = _to_int(stats.get("reused_email_rows"), 0) + 1
        if existing_phone:
            stats["reused_phone_rows"] = _to_int(stats.get("reused_phone_rows"), 0) + 1

        submitted = bool(existing_email and existing_phone)
        if submitted:
            stats["reused_full_rows"] = _to_int(stats.get("reused_full_rows"), 0) + 1
            stats["skipped_already_enriched"] = _to_int(
                stats.get("skipped_already_enriched"), 0
            ) + 1

        rows[key] = {
            "first name": first_name,
            "last name": last_name,
            "company": company,
            "title": title,
            "email": existing_email,
            "phone": existing_phone,
            "city": src.get("city", ""),
            "state": src.get("state", ""),
            "country": src.get("country", ""),
            "submitted": submitted,
            "person_id": "",
            "request_id": "",
            "submit_http_status": "reused" if submitted else None,
            "submit_error": "",
        }

    return {
        "run_id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "sheet_id": cfg.sheet_id,
        "source_tab": cfg.source_tab,
        "target_tab": cfg.target_tab,
        "webhook_token": webhook_token,
        "webhook_url": webhook_url,
        "row_order": [str(i) for i in range(len(source_rows))],
        "rows": rows,
        "person_to_rows": {},
        "seen_callback_ids": [],
        "stats": stats,
    }


def _append_person_to_row(state: dict[str, Any], person_id: str, row_key: str) -> None:
    person_to_rows = state.setdefault("person_to_rows", {})
    row_keys = person_to_rows.setdefault(person_id, [])
    if row_key not in row_keys:
        row_keys.append(row_key)


def _rows_for_sheet(state: dict[str, Any]) -> list[dict[str, str]]:
    output: list[dict[str, str]] = []
    for row_key in state["row_order"]:
        row = state["rows"][row_key]
        output.append({col: str(row.get(col, "")) for col in TARGET_COLUMNS})
    return output


def save_state(state: dict[str, Any], cfg: RuntimeConfig) -> None:
    state["updated_at"] = utc_now()
    atomic_write_json(cfg.state_file, state)


def write_sheet(state: dict[str, Any], sheets, cfg: RuntimeConfig) -> None:
    rows = _rows_for_sheet(state)
    write_target_rows(sheets, cfg.sheet_id, cfg.target_tab, rows)
    state["stats"]["sheet_writes"] = _to_int(state["stats"].get("sheet_writes"), 0) + 1


def submit_apollo_jobs(state: dict[str, Any], cfg: RuntimeConfig, sheets=None) -> None:
    sent_in_run = 0
    for row_key in state["row_order"]:
        if cfg.max_submit is not None and sent_in_run >= cfg.max_submit:
            break

        row = state["rows"][row_key]
        if row.get("submitted"):
            continue

        status, payload = apollo_match(
            api_key=cfg.apollo_key,
            first_name=row.get("first name", ""),
            last_name=row.get("last name", ""),
            organization_name=row.get("company", ""),
            person_title=row.get("title", ""),
            webhook_url=state["webhook_url"],
        )

        state["stats"]["apollo_requests_sent"] = _to_int(
            state["stats"].get("apollo_requests_sent"), 0
        ) + 1
        row["submitted"] = True
        row["submit_http_status"] = status

        if status == 200:
            state["stats"]["apollo_http_200"] = _to_int(
                state["stats"].get("apollo_http_200"), 0
            ) + 1
            person = payload.get("person") or {}
            request_id = payload.get("request_id") or ""
            row["request_id"] = str(request_id)
            person_id = str(person.get("id") or "")
            if person_id:
                row["person_id"] = person_id
                _append_person_to_row(state, person_id, row_key)
            else:
                state["stats"]["apollo_person_id_missing"] = _to_int(
                    state["stats"].get("apollo_person_id_missing"), 0
                ) + 1

            email = _extract_email(person)
            if email:
                row["email"] = email
            immediate_phone = _extract_immediate_phone(person)
            if immediate_phone and not row.get("phone"):
                row["phone"] = immediate_phone
        else:
            state["stats"]["apollo_http_errors"] = _to_int(
                state["stats"].get("apollo_http_errors"), 0
            ) + 1
            row["submit_error"] = str(payload.get("_error") or "")[:1000]

        sent_in_run += 1
        if sent_in_run % cfg.save_every == 0:
            save_state(state, cfg)
        if sheets is not None and sent_in_run % cfg.submit_write_every == 0:
            write_sheet(state, sheets, cfg)
            save_state(state, cfg)
            email_count = sum(
                1 for k in state["row_order"] if state["rows"][k].get("email")
            )
            phone_count = sum(
                1 for k in state["row_order"] if state["rows"][k].get("phone")
            )
            print(
                f"submit_progress submitted={sent_in_run} "
                f"emails={email_count} phones={phone_count}"
            )
        time.sleep(cfg.submit_sleep_seconds)


def process_callbacks(state: dict[str, Any]) -> tuple[int, int]:
    token = state["webhook_token"]
    seen: set[str] = set(state.get("seen_callback_ids") or [])

    new_callbacks = 0
    new_phone_updates = 0
    page = 1
    while True:
        payload = fetch_webhook_requests(token, page=page)
        entries = payload.get("data") or []

        for entry in entries:
            callback_id = entry.get("uuid")
            if not callback_id or callback_id in seen:
                continue
            seen.add(callback_id)
            new_callbacks += 1

            state["stats"]["webhook_callbacks_seen"] = _to_int(
                state["stats"].get("webhook_callbacks_seen"), 0
            ) + 1

            content = entry.get("content") or ""
            try:
                callback_payload = json.loads(content)
            except Exception:
                continue

            state["stats"]["webhook_callbacks_parsed"] = _to_int(
                state["stats"].get("webhook_callbacks_parsed"), 0
            ) + 1

            credits = callback_payload.get("credits_consumed")
            if isinstance(credits, (int, float)):
                state["stats"]["webhook_credits_consumed_sum"] = _to_float(
                    state["stats"].get("webhook_credits_consumed_sum"), 0.0
                ) + float(credits)

            people = callback_payload.get("people") or []
            for person in people:
                person_id = str(person.get("id") or "")
                if not person_id:
                    continue
                phones = person.get("phone_numbers") or []
                if not phones:
                    continue

                phone = ""
                first = phones[0]
                if isinstance(first, dict):
                    phone = (
                        str(
                            first.get("raw_number")
                            or first.get("sanitized_number")
                            or first.get("number")
                            or ""
                        ).strip()
                    )
                elif isinstance(first, str):
                    phone = first.strip()
                if not phone:
                    continue

                for row_key in state.get("person_to_rows", {}).get(person_id, []):
                    row = state["rows"].get(row_key)
                    if row is None:
                        continue
                    if not row.get("phone"):
                        row["phone"] = phone
                        new_phone_updates += 1
                        state["stats"]["webhook_phones_applied"] = _to_int(
                            state["stats"].get("webhook_phones_applied"), 0
                        ) + 1

        if payload.get("is_last_page", True):
            break
        page += 1

    state["seen_callback_ids"] = sorted(seen)
    return new_callbacks, new_phone_updates


def build_summary(state: dict[str, Any]) -> dict[str, Any]:
    rows = [state["rows"][k] for k in state["row_order"]]
    email_count = sum(1 for row in rows if str(row.get("email") or "").strip())
    phone_count = sum(1 for row in rows if str(row.get("phone") or "").strip())

    submitted_count = sum(1 for row in rows if row.get("submitted"))
    return {
        "run_id": state.get("run_id"),
        "created_at": state.get("created_at"),
        "updated_at": state.get("updated_at"),
        "sheet_id": state.get("sheet_id"),
        "source_tab": state.get("source_tab"),
        "target_tab": state.get("target_tab"),
        "webhook_token": state.get("webhook_token"),
        "webhook_url": state.get("webhook_url"),
        "rows_total": len(rows),
        "rows_submitted": submitted_count,
        "rows_with_email": email_count,
        "rows_with_phone": phone_count,
        "rows_with_email_or_phone": sum(
            1
            for row in rows
            if str(row.get("email") or "").strip() or str(row.get("phone") or "").strip()
        ),
        "stats": state.get("stats", {}),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Overnight Apollo webhook enrichment runner for Google Sheets",
    )
    parser.add_argument("--sheet-id", required=True, help="Target Google Sheet ID")
    parser.add_argument(
        "--source-tab",
        default="Non-Accounting Firm Buyers (2025)",
        help="Source tab to read contacts from",
    )
    parser.add_argument(
        "--target-tab",
        default="Non-Accounting Buyers Enriched",
        help="Destination tab to write enriched rows",
    )
    parser.add_argument(
        "--apollo-key-env",
        default="APOLLO_SEARCH",
        help="Environment variable name for Apollo API key",
    )
    parser.add_argument(
        "--state-file",
        default="outputs/contact_enrichment/apollo_webhook_enrichment_state.json",
        help="Checkpoint JSON path",
    )
    parser.add_argument(
        "--summary-file",
        default="outputs/contact_enrichment/apollo_webhook_enrichment_summary.json",
        help="Summary JSON output path",
    )
    parser.add_argument(
        "--google-token-file",
        default="secrets/google-drive-token.json",
        help="Google OAuth token JSON with drive scope",
    )
    parser.add_argument(
        "--submit-sleep-seconds",
        type=float,
        default=0.08,
        help="Sleep between Apollo submit calls",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=10.0,
        help="Seconds between webhook polling loops",
    )
    parser.add_argument(
        "--max-poll-minutes",
        type=float,
        default=480.0,
        help="Maximum polling duration after submission",
    )
    parser.add_argument(
        "--save-every",
        type=int,
        default=25,
        help="Persist state every N submissions",
    )
    parser.add_argument(
        "--write-every",
        type=int,
        default=25,
        help="Write destination sheet every N new callbacks",
    )
    parser.add_argument(
        "--submit-write-every",
        type=int,
        default=10,
        help="Write destination sheet every N Apollo submissions",
    )
    parser.add_argument(
        "--max-submit",
        type=int,
        default=None,
        help="Optional limit for Apollo submissions this run",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from existing state file",
    )
    parser.add_argument(
        "--webhook-token",
        default="",
        help="Optional existing webhook.site token",
    )
    parser.add_argument(
        "--webhook-url",
        default="",
        help="Optional explicit webhook url (overrides token)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    load_env_defaults()
    apollo_key = os.getenv(args.apollo_key_env, "").strip()
    if not apollo_key:
        raise SystemExit(
            f"Missing Apollo API key in env var: {args.apollo_key_env}"
        )

    cfg = RuntimeConfig(
        sheet_id=args.sheet_id,
        source_tab=args.source_tab,
        target_tab=args.target_tab,
        apollo_key=apollo_key,
        state_file=Path(args.state_file).expanduser().resolve(),
        summary_file=Path(args.summary_file).expanduser().resolve(),
        google_token_file=Path(args.google_token_file).expanduser().resolve(),
        submit_sleep_seconds=max(0.0, args.submit_sleep_seconds),
        poll_seconds=max(1.0, args.poll_seconds),
        max_poll_minutes=max(1.0, args.max_poll_minutes),
        save_every=max(1, args.save_every),
        write_every=max(1, args.write_every),
        submit_write_every=max(1, args.submit_write_every),
        max_submit=args.max_submit,
    )

    sheets = load_sheets_service(cfg.google_token_file)
    gid = ensure_tab(sheets, cfg.sheet_id, cfg.target_tab)
    print(f"target_tab={cfg.target_tab} gid={gid}")

    state = load_state(cfg.state_file) if args.resume else None
    if state:
        print(f"resume_state={cfg.state_file}")
    else:
        source_rows = read_source_rows(sheets, cfg.sheet_id, cfg.source_tab)
        print(f"source_rows={len(source_rows)}")
        existing_target_map = read_existing_target_map(
            sheets, cfg.sheet_id, cfg.target_tab
        )
        print(
            f"existing_target_rows_with_data="
            f"{sum(1 for v in existing_target_map.values() if v.get('email') or v.get('phone'))}"
        )

        if args.webhook_url:
            webhook_url = args.webhook_url.strip()
            webhook_token = args.webhook_token.strip()
        elif args.webhook_token:
            webhook_token = args.webhook_token.strip()
            webhook_url = f"https://webhook.site/{webhook_token}"
        else:
            webhook_token, webhook_url = create_webhook_site_token()

        print(f"webhook_url={webhook_url}")
        state = initialize_state(
            source_rows,
            cfg,
            webhook_token,
            webhook_url,
            existing_target_map=existing_target_map,
        )
        write_sheet(state, sheets, cfg)
        save_state(state, cfg)

    submit_apollo_jobs(state, cfg, sheets=sheets)
    save_state(state, cfg)
    write_sheet(state, sheets, cfg)

    poll_deadline = time.time() + (cfg.max_poll_minutes * 60.0)
    new_callbacks_since_write = 0
    last_progress = time.time()

    while time.time() < poll_deadline:
        callbacks, phone_updates = process_callbacks(state)
        if callbacks > 0:
            new_callbacks_since_write += callbacks
            save_state(state, cfg)

        if callbacks > 0 or phone_updates > 0:
            print(
                f"callbacks+={callbacks} phones+={phone_updates} "
                f"total_callbacks={state['stats']['webhook_callbacks_seen']} "
                f"phones_total={state['stats']['webhook_phones_applied']}"
            )

        if new_callbacks_since_write >= cfg.write_every or phone_updates > 0:
            write_sheet(state, sheets, cfg)
            save_state(state, cfg)
            new_callbacks_since_write = 0

        rows_total = len(state["row_order"])
        submitted = sum(1 for k in state["row_order"] if state["rows"][k].get("submitted"))
        callbacks_seen = _to_int(state["stats"].get("webhook_callbacks_seen"), 0)
        if submitted >= rows_total and callbacks_seen >= submitted:
            print("all callbacks received for submitted rows")
            break

        now = time.time()
        if now - last_progress >= 60:
            last_progress = now
            summary = build_summary(state)
            print(
                "progress "
                f"submitted={summary['rows_submitted']}/{summary['rows_total']} "
                f"phones={summary['rows_with_phone']} emails={summary['rows_with_email']}"
            )

        time.sleep(cfg.poll_seconds)

    write_sheet(state, sheets, cfg)
    save_state(state, cfg)
    summary = build_summary(state)
    cfg.summary_file.parent.mkdir(parents=True, exist_ok=True)
    cfg.summary_file.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print("done")
    print(json.dumps(summary, indent=2))
    print(f"state_file={cfg.state_file}")
    print(f"summary_file={cfg.summary_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
