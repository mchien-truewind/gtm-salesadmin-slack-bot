from __future__ import annotations

from typing import Mapping


NON_ICP_TITLES_EXACT = {
    "associate project executive",
    "attorney",
    "business manager",
    "bussiness manager",
    "corporate senior vice president engineering & vdc, esg, supply chain, org development and marketing",
    "cybersecurity advocate",
    "devops engineer",
    "engineering manager",
    "medical technologist",
    "podcast host",
    "recruitment partner",
    "safety superintendent",
    "supervisory acquisition program manager - operating senior functional",
}


def normalize_title(title: object) -> str:
    return " ".join(str(title or "").strip().lower().split())


def title_is_non_icp(title: object) -> bool:
    return normalize_title(title) in NON_ICP_TITLES_EXACT


def row_has_non_icp_title(row: Mapping[str, object], title_fields: tuple[str, ...]) -> bool:
    return any(title_is_non_icp(row.get(field)) for field in title_fields)
