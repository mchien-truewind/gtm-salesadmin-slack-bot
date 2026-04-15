from __future__ import annotations

from typing import Mapping


HUBSPOT_ACTIVITY_PROPERTIES = [
    "notes_last_contacted",
    "num_contacted_notes",
    "hs_last_sales_activity_timestamp",
    "hs_last_sales_activity_type",
    "hs_latest_sequence_enrolled_date",
    "hs_sequences_enrolled_count",
    "hs_sequences_is_enrolled",
]

NEW_STATUS = "No one has contacted them"
WORKING_STATUS = "Has contacted but no response"


def _truthy(value: object) -> bool:
    return str(value or "").strip().lower() in {"true", "1", "yes"}


def _positive_int(value: object) -> bool:
    try:
        return int(str(value or "").strip()) > 0
    except ValueError:
        return False


def has_prior_contact_activity(properties: Mapping[str, object]) -> bool:
    """Return true when HubSpot shows sales/contact activity on an existing contact."""
    if str(properties.get("notes_last_contacted") or "").strip():
        return True
    if _positive_int(properties.get("num_contacted_notes")):
        return True
    if str(properties.get("hs_last_sales_activity_timestamp") or "").strip():
        return True
    if str(properties.get("hs_last_sales_activity_type") or "").strip():
        return True
    if str(properties.get("hs_latest_sequence_enrolled_date") or "").strip():
        return True
    if _positive_int(properties.get("hs_sequences_enrolled_count")):
        return True
    if _truthy(properties.get("hs_sequences_is_enrolled")):
        return True
    return False


def lead_status_for_existing_contact(properties: Mapping[str, object]) -> str:
    """Choose New vs Working for existing lead contacts based on real activity."""
    return WORKING_STATUS if has_prior_contact_activity(properties) else NEW_STATUS
