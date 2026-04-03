from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import gmail_inbox_triage as triage


def _message(*, sender: str, subject: str = "", body: str = "", extra_headers: dict[str, str] | None = None) -> dict:
    headers = [
        {"name": "From", "value": sender},
        {"name": "Subject", "value": subject},
    ]
    if extra_headers:
        for key, value in extra_headers.items():
            headers.append({"name": key, "value": value})
    return {
        "payload": {"headers": headers},
        "snippet": body,
    }


def _thread(messages: list[dict]) -> dict:
    return {"messages": messages}


class InboxTriageRulesTest(unittest.TestCase):
    def test_no_reply_exact_sender_is_blocked(self) -> None:
        msg = _message(sender="invite@emails.magicpatterns.com", subject="Invite", body="Automated invite")
        reason = triage.no_reply_notification_reason(msg, my_email="mercedes@trytruewind.com")
        self.assertIsNotNone(reason)
        assert reason is not None
        self.assertIn("invite@emails.magicpatterns.com", reason)

    def test_always_reply_sender_not_blocked(self) -> None:
        msg = _message(
            sender="mbaske@linkedin.com",
            subject="Need to coordinate",
            body="Can you send two times that work?",
        )
        reason = triage.no_reply_notification_reason(msg, my_email="mercedes@trytruewind.com")
        self.assertIsNone(reason)

    def test_promotional_automated_sender_skips_draft(self) -> None:
        msg = _message(
            sender="invite@emails.magicpatterns.com",
            subject="Magic Patterns Event Invite",
            body="Have questions from the session? Reply here and I'll get you an answer.",
        )
        decision, reason, _score = triage.evaluate_draft_decision(
            inbound=msg,
            latest_inbound_text=msg["snippet"],
            previous_outbound_text="",
            classification_info={"auto_score": 1, "marketing_score": 2},
            my_email="mercedes@trytruewind.com",
            min_draft_confidence=2,
        )
        self.assertEqual(decision, "skip")
        self.assertIn("automated-sender", reason)

    def test_human_direct_request_drafts(self) -> None:
        msg = _message(
            sender="mbaske@linkedin.com",
            subject="Coordinate time",
            body="Can you share two times that work for you tomorrow?",
        )
        decision, reason, _score = triage.evaluate_draft_decision(
            inbound=msg,
            latest_inbound_text=msg["snippet"],
            previous_outbound_text="",
            classification_info={"auto_score": 0, "marketing_score": 0},
            my_email="mercedes@trytruewind.com",
            min_draft_confidence=2,
        )
        self.assertEqual(decision, "draft")
        self.assertIn("draftable", reason)

    def test_non_actionable_update_skips_draft(self) -> None:
        msg = _message(
            sender="gabriel.enciso@vercel.com",
            subject="Thanks for joining us",
            body="Great to have you in the room. No action needed.",
        )
        decision, reason, _score = triage.evaluate_draft_decision(
            inbound=msg,
            latest_inbound_text=msg["snippet"],
            previous_outbound_text="",
            classification_info={"auto_score": 0, "marketing_score": 1},
            my_email="mercedes@trytruewind.com",
            min_draft_confidence=2,
        )
        self.assertEqual(decision, "skip")
        self.assertIn("automated-sender", reason)

    def test_question_template_never_uses_parrot_line(self) -> None:
        body = triage.generate_reply_body(
            subject="Re: moody office pic",
            latest_inbound_text="Are you able to provide any more info, Mercedes?",
            previous_outbound_text="",
            from_header="Adam <adam@nicolasboucher.online>",
            style_profile={"greeting_template": "Hi {name},", "signoff": "Thanks,", "signature": "Mercedes"},
            thread_had_rejection=False,
            candidate_submission_text="",
        )
        lowered = body.lower()
        self.assertNotIn("i saw your point on:", lowered)
        self.assertNotIn("i need to verify one detail before i answer fully.", lowered)
        self.assertIn("which part should i prioritize", lowered)

    def test_draft_quality_flags_parroted_question(self) -> None:
        reason = triage.draft_quality_reason(
            intent="question",
            latest_inbound_text="Are you able to provide any more info, Mercedes?",
            draft_body=(
                "Hi Adam,\n\n"
                "I saw your point on: Are you able to provide any more info, Mercedes?\n"
                "Thanks,\nMercedes\n"
            ),
        )
        self.assertIsNotNone(reason)

    def test_scheduling_closeout_is_detected(self) -> None:
        self.assertTrue(
            triage.is_scheduling_closeout(
                latest_inbound_text="Perfect, we already booked the call. See you then.",
                previous_outbound_text="I can do 11:30am or 1pm ET. Let me know what works.",
            )
        )

    def test_named_google_sender_blocked(self) -> None:
        msg = _message(sender="nishadwivedi@google.com", subject="Solicitor outreach", body="Let's connect")
        reason = triage.no_reply_notification_reason(msg, my_email="mercedes@trytruewind.com")
        self.assertIsNotNone(reason)

    def test_notion_team_sender_blocked(self) -> None:
        msg = _message(
            sender="team@mail.notion.so",
            subject="A page mentioned you",
            body="Automated Notion notification",
        )
        reason = triage.no_reply_notification_reason(msg, my_email="mercedes@trytruewind.com")
        self.assertIsNotNone(reason)
        assert reason is not None
        self.assertIn("team@mail.notion.so", reason)

    def test_auto_submitted_header_blocked(self) -> None:
        msg = _message(
            sender="updates@example.com",
            subject="System update",
            body="This is an automated update.",
            extra_headers={"Auto-Submitted": "auto-generated"},
        )
        reason = triage.no_reply_notification_reason(msg, my_email="mercedes@trytruewind.com")
        self.assertIsNotNone(reason)
        assert reason is not None
        self.assertIn("auto-submitted-header", reason)

    def test_list_unsubscribe_sender_skips_draft(self) -> None:
        msg = _message(
            sender="team@example.com",
            subject="Newsletter question",
            body="Would you like to attend our webinar?",
            extra_headers={"List-Unsubscribe": "<mailto:unsubscribe@example.com>"},
        )
        decision, reason, _score = triage.evaluate_draft_decision(
            inbound=msg,
            latest_inbound_text=msg["snippet"],
            previous_outbound_text="",
            classification_info={"auto_score": 0, "marketing_score": 2},
            my_email="mercedes@trytruewind.com",
            min_draft_confidence=2,
        )
        self.assertEqual(decision, "skip")
        self.assertIn("automated-sender", reason)

    def test_unsolicited_solicitation_archives(self) -> None:
        thread = _thread(
            [
                {
                    "internalDate": "1000",
                    "payload": {
                        "headers": [
                            {"name": "From", "value": "Amarpreet Kalsi <amarpreetkalsi@google.com>"},
                            {"name": "Subject", "value": "Google Ads consultation"},
                        ]
                    },
                    "snippet": "Would you be open to a quick call to discuss your paid media pipeline? I can share a growth plan.",
                    "labelIds": ["INBOX"],
                }
            ]
        )
        reason = triage.solicitation_outreach_reason(thread, "mercedes@trytruewind.com")
        self.assertIsNotNone(reason)

    def test_existing_conversation_not_marked_unsolicited(self) -> None:
        thread = _thread(
            [
                {
                    "internalDate": "900",
                    "payload": {
                        "headers": [
                            {"name": "From", "value": "Mercedes Chien <mercedes@trytruewind.com>"},
                            {"name": "Subject", "value": "Re: Google Ads consultation"},
                        ]
                    },
                    "snippet": "Can you send details first?",
                    "labelIds": ["SENT"],
                },
                {
                    "internalDate": "1000",
                    "payload": {
                        "headers": [
                            {"name": "From", "value": "Amarpreet Kalsi <amarpreetkalsi@google.com>"},
                            {"name": "Subject", "value": "Re: Google Ads consultation"},
                        ]
                    },
                    "snippet": "Would you be open to a quick call?",
                    "labelIds": ["INBOX"],
                },
            ]
        )
        reason = triage.solicitation_outreach_reason(thread, "mercedes@trytruewind.com")
        self.assertIsNone(reason)


if __name__ == "__main__":
    unittest.main()
