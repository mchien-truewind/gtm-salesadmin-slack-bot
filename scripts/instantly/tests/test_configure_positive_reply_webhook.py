import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "configure_positive_reply_webhook.py"
SPEC = importlib.util.spec_from_file_location("configure_positive_reply_webhook", MODULE_PATH)
module = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(module)


class ConfigurePositiveReplyWebhookTests(unittest.TestCase):
    def test_build_target_url_from_base(self):
        self.assertEqual(
            module.build_target_url("https://example.com/", ""),
            "https://example.com/webhooks/instantly/positive-reply",
        )

    def test_build_target_url_prefers_explicit_url(self):
        self.assertEqual(
            module.build_target_url("https://example.com", "https://hooks.example.test/instantly"),
            "https://hooks.example.test/instantly",
        )

    def test_build_webhook_body_is_all_campaign_positive_event(self):
        body = module.build_webhook_body(
            target_url="https://example.com/webhooks/instantly/positive-reply",
            name="Slack positive reply alert",
            webhook_secret="secret-value",
        )

        self.assertEqual(body["event_type"], "lead_interested")
        self.assertIsNone(body["campaign"])
        self.assertIsNone(body["custom_interest_value"])
        self.assertEqual(
            body["headers"],
            {"X-INSTANTLY-WEBHOOK-SECRET": "secret-value"},
        )

    def test_find_existing_webhook_by_name_or_target(self):
        by_name = {
            "id": "one",
            "name": "Slack positive reply alert",
            "event_type": "lead_interested",
            "campaign": None,
        }
        by_target = {
            "id": "two",
            "target_hook_url": "https://example.com/hook",
            "event_type": "lead_interested",
            "campaign": None,
        }

        self.assertEqual(
            module.find_existing_webhook([by_name], "Slack positive reply alert", "x"),
            by_name,
        )
        self.assertEqual(
            module.find_existing_webhook([by_target], "Other", "https://example.com/hook"),
            by_target,
        )

    def test_find_existing_webhook_ignores_campaign_specific_same_name(self):
        campaign_specific = {
            "id": "one",
            "name": "Slack positive reply alert",
            "target_hook_url": "https://example.com/old",
            "event_type": "lead_interested",
            "campaign": "campaign-id",
        }
        workspace_wide = {
            "id": "two",
            "name": "Other",
            "target_hook_url": "https://example.com/hook",
            "event_type": "lead_interested",
            "campaign": None,
        }

        self.assertEqual(
            module.find_existing_webhook(
                [campaign_specific, workspace_wide],
                "Slack positive reply alert",
                "https://example.com/hook",
            ),
            workspace_wide,
        )

    def test_find_existing_webhook_returns_none_for_only_campaign_specific_same_name(self):
        campaign_specific = {
            "id": "one",
            "name": "Slack positive reply alert",
            "target_hook_url": "https://example.com/old",
            "event_type": "lead_interested",
            "campaign": "campaign-id",
        }

        self.assertIsNone(
            module.find_existing_webhook(
                [campaign_specific],
                "Slack positive reply alert",
                "https://example.com/hook",
            )
        )


if __name__ == "__main__":
    unittest.main()
