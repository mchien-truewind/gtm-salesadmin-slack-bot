from __future__ import annotations

import unittest

from scripts.contact_enrichment.final_summary_sheet import build_final_summary_rows
from scripts.contact_enrichment.icp_title_filters import title_is_non_icp


class FinalSummarySheetTest(unittest.TestCase):
    def test_title_filter_normalizes_case_and_whitespace(self) -> None:
        self.assertTrue(title_is_non_icp("  DevOps   Engineer "))
        self.assertTrue(title_is_non_icp("ATTORNEY"))
        self.assertTrue(title_is_non_icp("Business Manager"))
        self.assertFalse(title_is_non_icp("Chief Financial Officer"))

    def test_build_rows_excludes_blocked_enriched_titles(self) -> None:
        rows, summary = build_final_summary_rows(
            [
                {
                    "source_row_number": "10",
                    "first_name": "Ada",
                    "last_name": "Lovelace",
                    "title": "CFO",
                    "company": "Example Co",
                    "apollo_title": "Engineering Manager",
                    "apollo_email": "ada@example.com",
                    "apollo_match_status": "accepted",
                },
                {
                    "source_row_number": "11",
                    "first_name": "Grace",
                    "last_name": "Hopper",
                    "title": "Chief Financial Officer",
                    "company": "Another Co",
                    "apollo_email": "grace@example.com",
                    "icp_tier_final": "Tier 1",
                },
            ],
            "AICPA CFO Attendees",
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], "grace@example.com")
        self.assertEqual(summary["skipped"]["non_icp_title"], 1)
        self.assertEqual(
            summary["excluded_non_icp_titles"][0]["apollo_title"],
            "Engineering Manager",
        )

    def test_build_rows_skips_missing_and_duplicate_email(self) -> None:
        rows, summary = build_final_summary_rows(
            [
                {"first_name": "No", "last_name": "Email", "title": "CFO"},
                {
                    "first_name": "One",
                    "last_name": "Email",
                    "title": "CFO",
                    "apollo_email": "one@example.com",
                },
                {
                    "first_name": "Dupe",
                    "last_name": "Email",
                    "title": "CFO",
                    "fallback_email": "ONE@example.com",
                },
            ],
            "AICPA CFO Attendees",
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(summary["skipped"]["no_email"], 1)
        self.assertEqual(summary["skipped"]["duplicate_email"], 1)


if __name__ == "__main__":
    unittest.main()
