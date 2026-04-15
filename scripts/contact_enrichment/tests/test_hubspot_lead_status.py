from __future__ import annotations

import unittest

from scripts.contact_enrichment.hubspot_lead_status import (
    NEW_STATUS,
    WORKING_STATUS,
    has_prior_contact_activity,
    lead_status_for_existing_contact,
)


class HubSpotLeadStatusTest(unittest.TestCase):
    def test_no_activity_is_new(self) -> None:
        props = {
            "notes_last_contacted": None,
            "num_contacted_notes": "0",
            "hs_last_sales_activity_timestamp": None,
            "hs_latest_sequence_enrolled_date": "",
            "hs_sequences_enrolled_count": "0",
            "hs_sequences_is_enrolled": "false",
        }

        self.assertFalse(has_prior_contact_activity(props))
        self.assertEqual(lead_status_for_existing_contact(props), NEW_STATUS)

    def test_notes_last_contacted_is_working(self) -> None:
        props = {"notes_last_contacted": "2026-03-04T16:37:08.669Z"}

        self.assertTrue(has_prior_contact_activity(props))
        self.assertEqual(lead_status_for_existing_contact(props), WORKING_STATUS)

    def test_contacted_notes_count_is_working(self) -> None:
        props = {"num_contacted_notes": "2"}

        self.assertTrue(has_prior_contact_activity(props))
        self.assertEqual(lead_status_for_existing_contact(props), WORKING_STATUS)

    def test_sequence_enrollment_is_working(self) -> None:
        props = {
            "hs_sequences_enrolled_count": "1",
            "hs_sequences_is_enrolled": "true",
        }

        self.assertTrue(has_prior_contact_activity(props))
        self.assertEqual(lead_status_for_existing_contact(props), WORKING_STATUS)

    def test_sales_activity_is_working(self) -> None:
        props = {
            "hs_last_sales_activity_timestamp": "2026-01-13T23:41:10.859Z",
            "hs_last_sales_activity_type": "EMAIL_OPEN",
        }

        self.assertTrue(has_prior_contact_activity(props))
        self.assertEqual(lead_status_for_existing_contact(props), WORKING_STATUS)


if __name__ == "__main__":
    unittest.main()
