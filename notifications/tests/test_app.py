import unittest
from unittest.mock import patch

from app import create_app, mail


class NotificationTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app(
            {
                "TESTING": True,
                "MAIL_SUPPRESS_SEND": True,
                "MAIL_SERVER": "smtp.example.test",
                "MAIL_DEFAULT_SENDER": "Capital Trust Bank <notices@example.test>",
                "NOTIFICATION_SERVICE_TOKEN": "test-notification-token",
            }
        )
        self.client = self.app.test_client()

    def test_gmail_defaults_read_credentials_from_environment(self):
        with patch.dict(
            "os.environ",
            {"MAIL_USERNAME": "bank@example.test", "MAIL_PASSWORD": "test-secret"},
            clear=True,
        ):
            app = create_app({"TESTING": True, "MAIL_SUPPRESS_SEND": True})

        self.assertEqual(app.config["MAIL_SERVER"], "smtp.gmail.com")
        self.assertEqual(app.config["MAIL_PORT"], 587)
        self.assertTrue(app.config["MAIL_USE_TLS"])
        self.assertFalse(app.config["MAIL_USE_SSL"])
        self.assertEqual(app.config["MAIL_USERNAME"], "bank@example.test")
        self.assertEqual(app.config["MAIL_PASSWORD"], "test-secret")
        self.assertEqual(app.config["MAIL_DEFAULT_SENDER"], "bank@example.test")

    def test_requires_internal_token(self):
        response = self.client.post(
            "/internal/notifications",
            json={"event": "account_created", "email": "customer@example.test", "name": "Customer"},
        )

        self.assertEqual(response.status_code, 401)

    def test_sends_branded_account_email(self):
        with mail.record_messages() as outbox:
            response = self.client.post(
                "/internal/notifications",
                headers={"Authorization": "Bearer test-notification-token"},
                json={"event": "account_created", "email": "customer@example.test", "name": "Ada Customer"},
            )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(len(outbox), 1)
        self.assertEqual(outbox[0].recipients, ["customer@example.test"])
        self.assertIn("Welcome to Capital Trust Bank", outbox[0].subject)
        self.assertIn("#0a4d36", outbox[0].html)
        self.assertIn("Ada Customer", outbox[0].html)
        self.assertIn("password", outbox[0].body.lower())

    def test_rejects_bad_transaction_event(self):
        response = self.client.post(
            "/internal/notifications",
            headers={"Authorization": "Bearer test-notification-token"},
            json={
                "event": "withdrawal_submitted",
                "email": "customer@example.test",
                "name": "Customer",
                "amountCents": "1000",
                "reference": "CTB123",
            },
        )

        self.assertEqual(response.status_code, 400)

    def test_withdrawal_email_includes_reference_and_bank(self):
        with mail.record_messages() as outbox:
            response = self.client.post(
                "/internal/notifications",
                headers={"Authorization": "Bearer test-notification-token"},
                json={
                    "event": "withdrawal_submitted",
                    "email": "customer@example.test",
                    "name": "Customer",
                    "amountCents": 2500,
                    "exchangeFeeCents": 50,
                    "reference": "CTB123",
                    "recipientBank": "Example Bank",
                },
            )

        self.assertEqual(response.status_code, 202)
        self.assertIn("Example Bank", outbox[0].html)
        self.assertIn("CTB123", outbox[0].body)
        self.assertIn("$25.00", outbox[0].body)
        self.assertIn("Exchange fee (handled offline by the bank): $0.50", outbox[0].body)

    def test_review_email_includes_status(self):
        with mail.record_messages() as outbox:
            response = self.client.post(
                "/internal/notifications",
                headers={"Authorization": "Bearer test-notification-token"},
                json={
                    "event": "transaction_reviewed",
                    "email": "customer@example.test",
                    "name": "Customer",
                    "amountCents": 2500,
                    "exchangeFeeCents": 50,
                    "feeCollectedOffline": True,
                    "reference": "CTB123",
                    "status": "approved",
                },
            )

        self.assertEqual(response.status_code, 202)
        self.assertIn("Approved", outbox[0].html)
        self.assertIn("Exchange fee collected offline", outbox[0].html)

    def test_support_email_does_not_include_message_content(self):
        with mail.record_messages() as outbox:
            response = self.client.post(
                "/internal/notifications",
                headers={"Authorization": "Bearer test-notification-token"},
                json={
                    "event": "support_reply",
                    "email": "customer@example.test",
                    "name": "Customer",
                    "message": "Private support conversation text",
                },
            )

        self.assertEqual(response.status_code, 202)
        self.assertNotIn("Private support conversation text", outbox[0].body)
        self.assertIn("Sign in to view the message", outbox[0].body)

    def test_requires_smtp_for_real_delivery(self):
        app = create_app(
            {
                "TESTING": True,
                "MAIL_SUPPRESS_SEND": False,
                "MAIL_SERVER": "",
                "MAIL_DEFAULT_SENDER": "",
                "NOTIFICATION_SERVICE_TOKEN": "test-notification-token",
            }
        )
        response = app.test_client().post(
            "/internal/notifications",
            headers={"Authorization": "Bearer test-notification-token"},
            json={"event": "account_created", "email": "customer@example.test", "name": "Customer"},
        )

        self.assertEqual(response.status_code, 503)


if __name__ == "__main__":
    unittest.main()