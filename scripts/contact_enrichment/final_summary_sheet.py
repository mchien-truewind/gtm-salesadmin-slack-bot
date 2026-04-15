#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

try:
    from scripts.contact_enrichment.apollo_webhook_sheet_enrich import load_sheets_service
    from scripts.contact_enrichment.icp_title_filters import row_has_non_icp_title
except ModuleNotFoundError:
    from apollo_webhook_sheet_enrich import load_sheets_service
    from icp_title_filters import row_has_non_icp_title


FINAL_HEADERS = [
    "Email",
    "First Name",
    "Last Name",
    "Job Title",
    "Company Name",
    "Company Domain Name",
    "Website URL",
    "Phone Number",
    "LinkedIn URL",
    "Lifecycle Stage",
    "Lead Status",
    "Contact Type",
    "Do Not Contact",
    "Lead Source",
    "Event Name",
    "ICP Tier",
]

TITLE_FIELDS = (
    "title",
    "title_clean",
    "candidate_title",
    "apollo_title",
)


def pick(*values: object) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def website_from_domain(domain: object) -> str:
    text = str(domain or "").strip().lower()
    if not text:
        return ""
    if text.startswith(("http://", "https://")):
        return text
    return f"https://{text}"


def row_to_dict(headers: list[str], values: list[str]) -> dict[str, str]:
    return {header: values[i] if i < len(values) else "" for i, header in enumerate(headers)}


def source_rows_from_values(values: list[list[str]]) -> list[dict[str, str]]:
    if not values:
        return []
    headers = values[0]
    rows = []
    for raw in values[1:]:
        row = row_to_dict(headers, raw)
        if any(str(value).strip() for value in row.values()):
            rows.append(row)
    return rows


def build_final_summary_rows(
    source_rows: list[dict[str, str]],
    event_name: str,
) -> tuple[list[list[str]], dict[str, Any]]:
    output: list[list[str]] = []
    seen_emails: set[str] = set()
    skipped = {
        "no_email": 0,
        "duplicate_email": 0,
        "non_icp_title": 0,
    }
    excluded_non_icp_titles: list[dict[str, str]] = []

    for row in source_rows:
        if row_has_non_icp_title(row, TITLE_FIELDS):
            skipped["non_icp_title"] += 1
            excluded_non_icp_titles.append(
                {
                    "source_row_number": row.get("source_row_number", ""),
                    "first_name": row.get("first_name", ""),
                    "last_name": row.get("last_name", ""),
                    "source_title": pick(row.get("title_clean"), row.get("title")),
                    "candidate_title": row.get("candidate_title", ""),
                    "apollo_title": row.get("apollo_title", ""),
                    "apollo_match_status": row.get("apollo_match_status", ""),
                }
            )
            continue

        email = pick(row.get("apollo_email"), row.get("fallback_email")).lower()
        if not email:
            skipped["no_email"] += 1
            continue
        if email in seen_emails:
            skipped["duplicate_email"] += 1
            continue
        seen_emails.add(email)

        domain = pick(row.get("apollo_org_domain"))
        output.append(
            [
                email,
                pick(row.get("first_name")),
                pick(row.get("last_name")),
                pick(
                    row.get("apollo_title"),
                    row.get("candidate_title"),
                    row.get("title_clean"),
                    row.get("title"),
                ),
                pick(
                    row.get("apollo_company"),
                    row.get("candidate_company"),
                    row.get("company_clean"),
                    row.get("company"),
                ),
                domain,
                website_from_domain(domain),
                pick(
                    row.get("phone_enrichment_phone"),
                    row.get("apollo_phone"),
                    row.get("fallback_phone"),
                ),
                pick(
                    row.get("apollo_linkedin_url"),
                    row.get("candidate_linkedin_url"),
                    row.get("source_url"),
                ),
                "Lead",
                "No one has contacted them",
                "Prospective Customer",
                "FALSE",
                "Event",
                event_name,
                pick(row.get("icp_tier_final")),
            ]
        )

    return output, {
        "source_rows": len(source_rows),
        "written_rows": len(output),
        "skipped": skipped,
        "excluded_non_icp_titles": excluded_non_icp_titles,
    }


def ensure_tab(sheets, spreadsheet_id: str, tab_name: str) -> int:
    meta = sheets.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    existing_sheet_id = find_tab_id(meta, tab_name)
    if existing_sheet_id is not None:
        return existing_sheet_id

    case_insensitive_sheet_id = None
    for sheet in meta.get("sheets", []):
        props = sheet.get("properties", {})
        title = props.get("title", "")
        if title.lower() == tab_name.lower():
            case_insensitive_sheet_id = int(props["sheetId"])

    if case_insensitive_sheet_id is not None:
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "requests": [
                    {
                        "updateSheetProperties": {
                            "properties": {
                                "sheetId": case_insensitive_sheet_id,
                                "title": tab_name,
                            },
                            "fields": "title",
                        }
                    }
                ]
            },
        ).execute()
        return case_insensitive_sheet_id

    response = sheets.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": [{"addSheet": {"properties": {"title": tab_name}}}]},
    ).execute()
    return int(response["replies"][0]["addSheet"]["properties"]["sheetId"])


def find_tab_id(meta: dict[str, Any], tab_name: str) -> int | None:
    for sheet in meta.get("sheets", []):
        props = sheet.get("properties", {})
        if props.get("title") == tab_name:
            return int(props["sheetId"])
    return None


def write_final_summary(
    sheets,
    spreadsheet_id: str,
    target_tab: str,
    sheet_id: int,
    rows: list[list[str]],
) -> None:
    values = [FINAL_HEADERS] + rows
    sheets.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id,
        range=f"'{target_tab}'!A:ZZ",
    ).execute()
    sheets.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"'{target_tab}'!A1",
        valueInputOption="RAW",
        body={"values": values},
    ).execute()
    sheets.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "requests": [
                {
                    "updateSheetProperties": {
                        "properties": {
                            "sheetId": sheet_id,
                            "gridProperties": {
                                "frozenRowCount": 1,
                                "rowCount": max(len(values) + 25, 200),
                                "columnCount": len(FINAL_HEADERS),
                            },
                        },
                        "fields": "gridProperties.frozenRowCount,gridProperties.rowCount,gridProperties.columnCount",
                    }
                },
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": 0,
                            "endRowIndex": 1,
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "textFormat": {"bold": True},
                                "backgroundColor": {
                                    "red": 0.85,
                                    "green": 0.92,
                                    "blue": 0.98,
                                },
                            }
                        },
                        "fields": "userEnteredFormat(textFormat,backgroundColor)",
                    }
                },
                {
                    "setBasicFilter": {
                        "filter": {
                            "range": {
                                "sheetId": sheet_id,
                                "startRowIndex": 0,
                                "endRowIndex": len(values),
                                "startColumnIndex": 0,
                                "endColumnIndex": len(FINAL_HEADERS),
                            }
                        }
                    }
                },
                {
                    "autoResizeDimensions": {
                        "dimensions": {
                            "sheetId": sheet_id,
                            "dimension": "COLUMNS",
                            "startIndex": 0,
                            "endIndex": len(FINAL_HEADERS),
                        }
                    }
                },
            ]
        },
    ).execute()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a compact HubSpot-ready FINAL SUMMARY tab from Apollo enrichment output.",
    )
    parser.add_argument("--sheet-id", required=True, help="Google Sheet ID")
    parser.add_argument(
        "--source-tab",
        default="final_enriched_icp_apollo",
        help="Source Apollo-enriched tab",
    )
    parser.add_argument(
        "--target-tab",
        default="FINAL SUMMARY",
        help="Destination final summary tab",
    )
    parser.add_argument(
        "--google-token-file",
        default="secrets/google-drive-token.json",
        help="Google OAuth token JSON with Drive scope",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the summary without rewriting the target tab",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    sheets = load_sheets_service(Path(args.google_token_file).expanduser().resolve())
    meta = sheets.spreadsheets().get(spreadsheetId=args.sheet_id).execute()
    event_name = meta.get("properties", {}).get("title", "").strip()
    sheet_id = (
        find_tab_id(meta, args.target_tab)
        if args.dry_run
        else ensure_tab(sheets, args.sheet_id, args.target_tab)
    )
    values = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=args.sheet_id, range=f"'{args.source_tab}'!A:BL")
        .execute()
        .get("values", [])
    )
    source_rows = source_rows_from_values(values)
    rows, summary = build_final_summary_rows(source_rows, event_name)
    if not args.dry_run:
        write_final_summary(sheets, args.sheet_id, args.target_tab, sheet_id, rows)
    summary.update(
        {
            "dry_run": args.dry_run,
            "spreadsheet_id": args.sheet_id,
            "source_tab": args.source_tab,
            "target_tab": args.target_tab,
            "target_sheet_id": sheet_id,
            "headers": len(FINAL_HEADERS),
            "event_name": event_name,
        }
    )
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
