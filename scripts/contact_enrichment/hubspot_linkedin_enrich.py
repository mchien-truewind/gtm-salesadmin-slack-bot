#!/usr/bin/env python3
"""
Enrich HubSpot contacts with LinkedIn profile URLs via Apollo people/match.

Pulls contacts from a HubSpot list (default: list 660), filters to those
missing `linkedin___profile`, enriches via Apollo, and writes back to HubSpot.
Falls back to PDL for Apollo misses.

Usage:
    python scripts/contact_enrichment/hubspot_linkedin_enrich.py
    python scripts/contact_enrichment/hubspot_linkedin_enrich.py --list-id 660 --dry-run
    python scripts/contact_enrichment/hubspot_linkedin_enrich.py --max-enrich 50
"""
from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import error, parse, request


def load_env_defaults() -> None:
    import re
    repo_root = Path(__file__).resolve().parent.parent.parent
    for candidate in (repo_root / ".env.local", repo_root / ".env", Path(".env.local"), Path(".env")):
        if not candidate.exists():
            continue
        raw_text = candidate.read_text(encoding="utf-8")
        raw_text = re.sub(r"\n=", "=", raw_text)  # merge continuation lines
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
CONTACT_PROPS = [
    "firstname",
    "lastname",
    "company",
    "jobtitle",
    "linkedin___profile",
    "hs_linkedin_url",
    "email",
    "domain",
]


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
                print(f"  Rate limited, waiting {retry_after}s...")
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


def fetch_list_contacts(
    token: str, list_id: str
) -> list[dict[str, Any]]:
    """Fetch all contacts in a HubSpot list via v3 lists API + batch read."""
    # Step 1: Get all member IDs from the list
    all_ids: list[str] = []
    after: str | None = None

    while True:
        path = f"/crm/v3/lists/{list_id}/memberships?limit=100"
        if after:
            path += f"&after={after}"
        resp = hubspot_request("GET", path, token)
        for member in resp.get("results", []):
            all_ids.append(member["recordId"])
        paging = resp.get("paging", {}).get("next", {})
        after = paging.get("after")
        if not after:
            break
        time.sleep(0.15)

    # Step 2: Batch read contact properties in chunks of 100
    all_contacts: list[dict[str, Any]] = []
    for i in range(0, len(all_ids), 100):
        chunk = all_ids[i : i + 100]
        batch_resp = hubspot_request(
            "POST",
            "/crm/v3/objects/contacts/batch/read",
            token,
            body={
                "inputs": [{"id": cid} for cid in chunk],
                "properties": CONTACT_PROPS,
            },
        )
        for c in batch_resp.get("results", []):
            all_contacts.append({
                "id": c["id"],
                "properties": c.get("properties", {}),
            })
        time.sleep(0.15)

    return all_contacts


def batch_update_contacts(
    token: str, updates: list[dict[str, Any]]
) -> None:
    """Batch update contacts in chunks of 100."""
    for i in range(0, len(updates), 100):
        batch = updates[i : i + 100]
        inputs = [
            {"id": u["id"], "properties": u["properties"]}
            for u in batch
        ]
        hubspot_request(
            "POST",
            "/crm/v3/objects/contacts/batch/update",
            token,
            body={"inputs": inputs},
        )
        print(f"  HubSpot batch update: {len(inputs)} contacts (batch {i // 100 + 1})")
        time.sleep(0.3)


# ---------------------------------------------------------------------------
# Apollo enrichment
# ---------------------------------------------------------------------------


def apollo_match_linkedin(
    api_key: str,
    first_name: str,
    last_name: str,
    organization_name: str,
    domain: str = "",
    email: str = "",
    retries: int = 3,
) -> str | None:
    """Call Apollo people/match and return LinkedIn URL if found."""
    payload: dict[str, Any] = {
        "first_name": first_name,
        "last_name": last_name,
        "organization_name": organization_name,
    }
    if domain:
        payload["domain"] = domain
    if email:
        payload["email"] = email

    body = json.dumps(payload).encode("utf-8")
    headers = {
        "X-Api-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
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
                data = json.loads(resp.read().decode("utf-8"))
                person = data.get("person") or {}
                return person.get("linkedin_url") or None
        except error.HTTPError as exc:
            if exc.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(2 ** attempt)
                continue
            return None
        except Exception:
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            return None


# ---------------------------------------------------------------------------
# PDL fallback
# ---------------------------------------------------------------------------


def pdl_match_linkedin(
    api_key: str,
    first_name: str,
    last_name: str,
    company: str,
    domain: str = "",
    email: str = "",
) -> str | None:
    """Call PDL person enrichment and return LinkedIn URL if found."""
    params: dict[str, str] = {}
    # Email is the strongest signal — try it first
    if email:
        params["email"] = email
    params["first_name"] = first_name
    params["last_name"] = last_name
    params["company"] = company
    if domain:
        params["website"] = domain

    qs = parse.urlencode(params)
    url = f"https://api.peopledatalabs.com/v5/person/enrich?{qs}"
    headers = {
        "X-Api-Key": api_key,
        "Accept": "application/json",
    }

    try:
        req = request.Request(url, headers=headers, method="GET")
        with request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("data", {}).get("linkedin_url") or None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


@dataclass
class Stats:
    total_in_list: int = 0
    synced_hs_to_custom: int = 0
    synced_custom_to_hs: int = 0
    already_have_linkedin: int = 0
    need_enrichment: int = 0
    apollo_found: int = 0
    apollo_miss: int = 0
    pdl_found: int = 0
    pdl_miss: int = 0
    hubspot_updated: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Enrich HubSpot contacts with LinkedIn URLs via Apollo + PDL"
    )
    parser.add_argument("--list-id", default="660", help="HubSpot list ID")
    parser.add_argument(
        "--apollo-key-env",
        default="APOLLO_BULK_MATCH",
        help="Env var for Apollo API key",
    )
    parser.add_argument(
        "--pdl-key-env", default="PDL_API", help="Env var for PDL API key"
    )
    parser.add_argument(
        "--hubspot-key-env",
        default="HUBSPOT_PRIVATE_TOKEN",
        help="Env var for HubSpot private app token",
    )
    parser.add_argument(
        "--max-enrich",
        type=int,
        default=None,
        help="Max contacts to enrich (for testing)",
    )
    parser.add_argument(
        "--skip-pdl",
        action="store_true",
        help="Skip PDL, only use Apollo",
    )
    parser.add_argument(
        "--skip-apollo",
        action="store_true",
        help="Skip Apollo, only use PDL",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Find and enrich but don't write back to HubSpot",
    )
    parser.add_argument(
        "--output",
        default="outputs/contact_enrichment/linkedin_enrich_results.json",
        help="Output JSON path for results",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.2,
        help="Sleep between enrichment API calls",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env_defaults()

    hubspot_token = os.environ.get(args.hubspot_key_env, "").strip()
    apollo_key = os.environ.get(args.apollo_key_env, "").strip()
    pdl_key = os.environ.get(args.pdl_key_env, "").strip()

    if not hubspot_token:
        raise SystemExit(f"Missing HubSpot token: {args.hubspot_key_env}")
    if not apollo_key:
        raise SystemExit(f"Missing Apollo key: {args.apollo_key_env}")

    stats = Stats()

    # Step 1: Fetch all contacts from the list
    print(f"Fetching contacts from HubSpot list {args.list_id}...")
    contacts = fetch_list_contacts(hubspot_token, args.list_id)
    stats.total_in_list = len(contacts)
    print(f"  Found {stats.total_in_list} contacts in list")

    # Step 2: Bidirectional sync between linkedin___profile and hs_linkedin_url
    print("\nSyncing linkedin___profile <-> hs_linkedin_url...")
    sync_updates: list[dict[str, Any]] = []
    for c in contacts:
        props = c["properties"]
        custom = (props.get("linkedin___profile") or "").strip()
        hs_url = (props.get("hs_linkedin_url") or "").strip()

        if custom and not hs_url:
            # Custom has value, HubSpot native doesn't → copy custom → native
            sync_updates.append({
                "id": c["id"],
                "properties": {"hs_linkedin_url": custom},
            })
            props["hs_linkedin_url"] = custom
            stats.synced_custom_to_hs += 1
        elif hs_url and not custom:
            # HubSpot native has value, custom doesn't → copy native → custom
            sync_updates.append({
                "id": c["id"],
                "properties": {"linkedin___profile": hs_url},
            })
            props["linkedin___profile"] = hs_url
            stats.synced_hs_to_custom += 1

    if sync_updates and not args.dry_run:
        print(f"  Writing {len(sync_updates)} sync updates to HubSpot...")
        batch_update_contacts(hubspot_token, sync_updates)
    elif sync_updates:
        print(f"  [DRY RUN] Would sync {len(sync_updates)} contacts")
    print(f"  Synced hs_linkedin_url → linkedin___profile: {stats.synced_hs_to_custom}")
    print(f"  Synced linkedin___profile → hs_linkedin_url: {stats.synced_custom_to_hs}")

    # Load previously missed contact IDs to skip
    output_path = Path(args.output).expanduser().resolve()
    previous_miss_ids: set[str] = set()
    if output_path.exists():
        try:
            prev = json.loads(output_path.read_text(encoding="utf-8"))
            for m in prev.get("misses", []):
                previous_miss_ids.add(str(m.get("id", "")))
        except Exception:
            pass
    if previous_miss_ids:
        print(f"\n  Loaded {len(previous_miss_ids)} previous misses to skip")

    # Step 3: Filter to those still missing LinkedIn (both fields empty)
    to_enrich = []
    skipped_previous = 0
    for c in contacts:
        custom = (c["properties"].get("linkedin___profile") or "").strip()
        if custom:
            stats.already_have_linkedin += 1
        elif c["id"] in previous_miss_ids:
            skipped_previous += 1
        else:
            to_enrich.append(c)

    stats.need_enrichment = len(to_enrich)
    print(f"\n  {stats.already_have_linkedin} already have LinkedIn URL (after sync)")
    if skipped_previous:
        print(f"  {skipped_previous} skipped (previously missed)")
    print(f"  {stats.need_enrichment} need enrichment")

    if args.max_enrich:
        to_enrich = to_enrich[: args.max_enrich]
        print(f"  Limiting to {args.max_enrich} contacts")

    # Step 4: Enrich via PDL first (then Apollo fallback)
    updates: list[dict[str, Any]] = []
    misses: list[dict[str, str]] = []

    for i, contact in enumerate(to_enrich):
        props = contact["properties"]
        first = props.get("firstname", "")
        last = props.get("lastname", "")
        company = props.get("company", "")
        domain = props.get("domain", "")
        email = props.get("email", "")
        title = props.get("jobtitle", "")

        if not first and not last:
            print(f"  [{i+1}/{len(to_enrich)}] Skipping {contact['id']} — no name")
            continue

        if not company and not domain and not email:
            print(f"  [{i+1}/{len(to_enrich)}] Skipping {first} {last} — no company/domain/email")
            misses.append({"id": contact["id"], "name": f"{first} {last}", "company": company, "title": title, "reason": "no_company"})
            continue

        linkedin_url = None

        # Try PDL first (higher hit rate for this dataset)
        if not args.skip_pdl and pdl_key:
            linkedin_url = pdl_match_linkedin(
                pdl_key, first, last, company, domain=domain, email=email
            )
            if linkedin_url:
                stats.pdl_found += 1
                print(f"  [{i+1}/{len(to_enrich)}] PDL:    {first} {last} @ {company} → {linkedin_url}")
            else:
                stats.pdl_miss += 1

        # Fall back to Apollo
        if not linkedin_url and not args.skip_apollo and apollo_key:
            linkedin_url = apollo_match_linkedin(
                apollo_key, first, last, company, domain=domain, email=email
            )
            if linkedin_url:
                stats.apollo_found += 1
                print(f"  [{i+1}/{len(to_enrich)}] Apollo: {first} {last} @ {company} → {linkedin_url}")
            else:
                stats.apollo_miss += 1

        if linkedin_url:
            updates.append({
                "id": contact["id"],
                "properties": {
                    "linkedin___profile": linkedin_url,
                    "hs_linkedin_url": linkedin_url,
                },
            })
        else:
            print(f"  [{i+1}/{len(to_enrich)}] MISS:   {first} {last} @ {company} ({title})")
            misses.append({"id": contact["id"], "name": f"{first} {last}", "company": company, "title": title, "reason": "not_found"})

        time.sleep(args.sleep)

    # Step 4: Write back to HubSpot
    if updates and not args.dry_run:
        print(f"\nUpdating {len(updates)} contacts in HubSpot...")
        batch_update_contacts(hubspot_token, updates)
        stats.hubspot_updated = len(updates)
    elif updates:
        print(f"\n[DRY RUN] Would update {len(updates)} contacts")
        stats.hubspot_updated = 0
    else:
        print("\nNo updates to write")

    # Step 5: Save results (merge new misses with previous)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    all_misses = []
    seen_miss_ids: set[str] = set()
    # Keep previous misses
    if output_path.exists():
        try:
            prev = json.loads(output_path.read_text(encoding="utf-8"))
            for m in prev.get("misses", []):
                mid = str(m.get("id", ""))
                if mid and mid not in seen_miss_ids:
                    all_misses.append(m)
                    seen_miss_ids.add(mid)
        except Exception:
            pass
    # Add new misses
    for m in misses:
        mid = str(m.get("id", ""))
        if mid and mid not in seen_miss_ids:
            all_misses.append(m)
            seen_miss_ids.add(mid)

    results = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "list_id": args.list_id,
        "stats": {
            "total_in_list": stats.total_in_list,
            "synced_hs_to_custom": stats.synced_hs_to_custom,
            "synced_custom_to_hs": stats.synced_custom_to_hs,
            "already_have_linkedin": stats.already_have_linkedin,
            "need_enrichment": stats.need_enrichment,
            "apollo_found": stats.apollo_found,
            "apollo_miss": stats.apollo_miss,
            "pdl_found": stats.pdl_found,
            "pdl_miss": stats.pdl_miss,
            "hubspot_updated": stats.hubspot_updated,
        },
        "misses": all_misses,
    }
    output_path.write_text(json.dumps(results, indent=2), encoding="utf-8")

    # Summary
    print(f"\n{'='*50}")
    print(f"Total in list:         {stats.total_in_list}")
    print(f"Synced hs → custom:    {stats.synced_hs_to_custom}")
    print(f"Synced custom → hs:    {stats.synced_custom_to_hs}")
    print(f"Already had LinkedIn:  {stats.already_have_linkedin}")
    print(f"Needed enrichment:     {stats.need_enrichment}")
    print(f"Apollo found:          {stats.apollo_found}")
    print(f"Apollo miss:           {stats.apollo_miss}")
    print(f"PDL found:             {stats.pdl_found}")
    print(f"PDL miss:              {stats.pdl_miss}")
    print(f"HubSpot updated:       {stats.hubspot_updated}")
    print(f"Results saved to:      {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
