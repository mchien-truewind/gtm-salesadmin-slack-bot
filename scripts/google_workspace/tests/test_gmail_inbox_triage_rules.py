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


class _Execute:
    def __init__(self, value: dict) -> None:
        self.value = value

    def execute(self) -> dict:
        return self.value


class _FakeThreads:
    def __init__(self, thread: dict) -> None:
        self.thread = thread
        self.modifications: list[dict] = []

    def get(self, **_kwargs) -> _Execute:
        return _Execute(self.thread)

    def modify(self, **kwargs) -> _Execute:
        self.modifications.append(kwargs)
        return _Execute({})


class _FakeUsers:
    def __init__(self, thread: dict) -> None:
        self.fake_threads = _FakeThreads(thread)

    def getProfile(self, **_kwargs) -> _Execute:
        return _Execute({"emailAddress": "mercedes@trytruewind.com"})

    def threads(self) -> _FakeThreads:
        return self.fake_threads


class _FakeGmail:
    def __init__(self, thread: dict) -> None:
        self.fake_users = _FakeUsers(thread)

    def users(self) -> _FakeUsers:
        return self.fake_users


def _config(**overrides) -> triage.TriageConfig:
    values = {
        "credentials_file": Path("credentials.json"),
        "token_file": Path("token.json"),
        "state_file": Path("state.json"),
        "style_file": Path("style.json"),
        "max_threads": 1,
        "query": "-in:chats",
        "marketing_label": "gen-marketing",
        "auto_label": "gen-auto",
        "conference_label": "gen-conference",
        "review_label": "gen-needs-review",
        "style_sample_size": 40,
        "style_cache_ttl_hours": 24,
        "refresh_style_profile": False,
        "min_draft_confidence": 2,
        "refresh_existing_drafts": False,
        "dry_run": False,
        "route_only": False,
        "slack_token": "xoxb-test",
        "slack_channel": "U123",
        "slack_mention_user_id": "U123",
        "slack_notifications": True,
    }
    values.update(overrides)
    return triage.TriageConfig(**values)


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

    def test_positive_reply_notification_detects_instantly_sender(self) -> None:
        msg = _message(
            sender="Instantly <notifications@nt1.instantly.ai>",
            subject="edgar.ejercito@primer.ai may have sent a positive reply",
            body="Open the campaign to review the reply.",
            extra_headers={"Auto-Submitted": "auto-generated"},
        )
        reason = triage.positive_reply_notification_reason(msg, my_email="mercedes@trytruewind.com")
        self.assertEqual(reason, "positive-reply-notification:instantly")

    def test_positive_reply_notification_detects_lemlist_sender(self) -> None:
        msg = _message(
            sender="lemlist <notifications@lemlist.com>",
            subject="Positive reply from prospect@example.com",
            body="The lead replied positively.",
            extra_headers={"Auto-Submitted": "auto-generated"},
        )
        reason = triage.positive_reply_notification_reason(msg, my_email="mercedes@trytruewind.com")
        self.assertEqual(reason, "positive-reply-notification:lemlist")

    def test_slack_response_alert_posts_once_per_message(self) -> None:
        msg = _message(
            sender="Instantly <notifications@nt1.instantly.ai>",
            subject="franks@merricorp.com may have sent a positive reply",
            body="Review the reply.",
        )
        msg["id"] = "msg-123"
        config = _config(slack_channel="slack-testing")
        posts: list[dict[str, str]] = []
        original_post = triage.post_slack_message

        def fake_post_slack_message(*, token: str, channel: str, text: str) -> dict:
            posts.append({"token": token, "channel": channel, "text": text})
            return {"ok": True, "ts": "1.2"}

        triage.post_slack_message = fake_post_slack_message
        try:
            record: dict = {}
            status = triage.maybe_notify_slack(
                config=config,
                thread_record=record,
                thread_id="thread-1",
                message=msg,
                alert_kind="positive_reply_notification",
                title="Response needed: positive reply notification",
                reason="positive-reply-notification:instantly",
            )
            duplicate = triage.maybe_notify_slack(
                config=config,
                thread_record=record,
                thread_id="thread-1",
                message=msg,
                alert_kind="positive_reply_notification",
                title="Response needed: positive reply notification",
                reason="positive-reply-notification:instantly",
            )
        finally:
            triage.post_slack_message = original_post

        self.assertEqual(status, "posted")
        self.assertEqual(duplicate, "duplicate")
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["channel"], "slack-testing")
        self.assertIn("<@U123> *Response needed: positive reply notification*", posts[0]["text"])
        self.assertIn("franks@merricorp.com", posts[0]["text"])

    def test_post_slack_message_opens_dm_for_user_id_channel(self) -> None:
        calls: list[tuple[str, dict[str, str]]] = []
        original_api = triage.slack_api

        def fake_slack_api(method: str, *, token: str, params: dict[str, str]) -> dict:
            calls.append((method, params))
            if method == "conversations.open":
                return {"ok": True, "channel": {"id": "D123"}}
            return {"ok": True, "ts": "1.2"}

        triage.slack_api = fake_slack_api
        try:
            triage.post_slack_message(token="xoxb-test", channel="U123", text="hello")
        finally:
            triage.slack_api = original_api

        self.assertEqual(calls[0], ("conversations.open", {"users": "U123"}))
        self.assertEqual(calls[1], ("chat.postMessage", {"channel": "D123", "text": "hello"}))

    def test_slack_notification_config_requires_channel_or_user(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Missing Slack channel"):
            triage.validate_slack_notification_config(_config(slack_channel="", slack_mention_user_id=""))

    def test_slack_notification_config_rejects_channel_without_mention(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Missing Slack mention user ID"):
            triage.validate_slack_notification_config(_config(slack_channel="hiring-review", slack_mention_user_id=""))

    def test_slack_notification_config_allows_dry_run_without_slack(self) -> None:
        triage.validate_slack_notification_config(
            _config(dry_run=True, slack_token="", slack_channel="", slack_mention_user_id="")
        )

    def test_run_triage_posts_positive_reply_notification_before_auto_route(self) -> None:
        msg = _message(
            sender="Instantly <notifications@nt1.instantly.ai>",
            subject="franks@merricorp.com may have sent a positive reply",
            body="Review the reply.",
            extra_headers={"Auto-Submitted": "auto-generated"},
        )
        msg["id"] = "msg-123"
        msg["threadId"] = "thread-1"
        msg["internalDate"] = "1000"
        msg["labelIds"] = ["INBOX"]
        thread = _thread([msg])
        fake_gmail = _FakeGmail(thread)
        posts: list[dict[str, str]] = []
        written_states: list[dict] = []

        originals = {
            "ensure_gmail_service": triage.ensure_gmail_service,
            "read_json": triage.read_json,
            "write_json": triage.write_json,
            "style_profile_is_fresh": triage.style_profile_is_fresh,
            "ensure_label": triage.ensure_label,
            "list_inbox_thread_ids": triage.list_inbox_thread_ids,
            "post_slack_message": triage.post_slack_message,
        }

        triage.ensure_gmail_service = lambda *_args, **_kwargs: fake_gmail
        triage.read_json = lambda path, default: {"threads": {}} if str(path) == "state.json" else {"sampled_at": "ok"}
        triage.write_json = lambda _path, data: written_states.append(data.copy())
        triage.style_profile_is_fresh = lambda *_args, **_kwargs: True
        triage.ensure_label = lambda _service, name, dry_run=False: name
        triage.list_inbox_thread_ids = lambda *_args, **_kwargs: ["thread-1"]

        def fake_post_slack_message(*, token: str, channel: str, text: str) -> dict:
            posts.append({"token": token, "channel": channel, "text": text})
            return {"ok": True, "ts": "1.2"}

        triage.post_slack_message = fake_post_slack_message
        try:
            result = triage.run_triage(_config(state_file=Path("state.json"), style_file=Path("style.json")))
        finally:
            for name, original in originals.items():
                setattr(triage, name, original)

        self.assertEqual(result, 0)
        self.assertEqual(len(posts), 1)
        self.assertIn("positive reply notification", posts[0]["text"])
        self.assertIn("franks@merricorp.com", posts[0]["text"])
        self.assertGreaterEqual(len(written_states), 2)
        self.assertIn("last_slack_alert_key", written_states[0]["threads"]["thread-1"])
        self.assertEqual(len(fake_gmail.fake_users.fake_threads.modifications), 1)

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
