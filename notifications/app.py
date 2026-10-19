"""Private Flask-Mail service for Capital Trust Bank notifications."""

from __future__ import annotations

import hmac
import os
import re
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_mail import Mail, Message

load_dotenv(Path(__file__).with_name(".env"), override=False)

mail = Mail()
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

EVENTS = {
    "account_created": ("Welcome to Capital Trust Bank", "Your account is ready."),
    "withdrawal_submitted": (
        "Withdrawal request received",
        "We received your withdrawal request and it is awaiting review.",
    ),
    "transaction_reviewed": (
        "Transaction update",
        "Our team has reviewed your transaction.",
    ),
    "support_reply": (
        "New reply from Capital Trust Bank support",
        "Our support team replied to your conversation. Sign in to view the message.",
    ),
}


def create_app(config: dict[str, Any] | None = None) -> Flask:
    app = Flask(__name__)
    app.config.update(
        MAIL_SERVER=os.getenv("MAIL_SERVER", "smtp.gmail.com"),
        MAIL_PORT=int(os.getenv("MAIL_PORT", "587")),
        MAIL_USE_TLS=os.getenv("MAIL_USE_TLS", "true").lower() == "true",
        MAIL_USE_SSL=os.getenv("MAIL_USE_SSL", "false").lower() == "true",
        MAIL_USERNAME=os.getenv("MAIL_USERNAME") or None,
        MAIL_PASSWORD=os.getenv("MAIL_PASSWORD") or None,
        MAIL_DEFAULT_SENDER=os.getenv("MAIL_DEFAULT_SENDER", os.getenv("MAIL_USERNAME", "")),
        MAIL_SUPPRESS_SEND=os.getenv("MAIL_SUPPRESS_SEND", "false").lower() == "true",
        NOTIFICATION_SERVICE_TOKEN=os.getenv("NOTIFICATION_SERVICE_TOKEN", ""),
        MAX_CONTENT_LENGTH=16 * 1024,
    )
    if config:
        app.config.update(config)
    if app.config["MAIL_SUPPRESS_SEND"] and not app.config["MAIL_DEFAULT_SENDER"]:
        app.config["MAIL_DEFAULT_SENDER"] = "Capital Trust Bank <no-reply@example.invalid>"
    mail.init_app(app)

    @app.get("/health")
    def health():
        return jsonify(status="ok")

    @app.post("/internal/notifications")
    def notify():
        configured_token = app.config["NOTIFICATION_SERVICE_TOKEN"]
        supplied_token = request.headers.get("Authorization", "")
        expected_header = f"Bearer {configured_token}"
        if not configured_token:
            return jsonify(error="Notification service is not configured."), 503
        if not hmac.compare_digest(supplied_token, expected_header):
            return jsonify(error="Unauthorized."), 401
        required_mail_settings = ("MAIL_SERVER", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_DEFAULT_SENDER")
        if not app.config["MAIL_SUPPRESS_SEND"] and any(
            not str(app.config[key] or "").strip() for key in required_mail_settings
        ):
            return jsonify(error="Email delivery is not configured."), 503

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(error="A JSON object is required."), 400

        event = payload.get("event")
        if event not in EVENTS:
            return jsonify(error="Unsupported notification event."), 400

        recipient = payload.get("email")
        if not isinstance(recipient, str) or not EMAIL_RE.fullmatch(recipient):
            return jsonify(error="A valid recipient email is required."), 400

        name = payload.get("name", "Customer")
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            return jsonify(error="A valid recipient name is required."), 400

        subject, intro = EVENTS[event]
        details = []
        if event in {"withdrawal_submitted", "transaction_reviewed"}:
            amount_cents = payload.get("amountCents")
            reference = payload.get("reference")
            if isinstance(amount_cents, bool) or not isinstance(amount_cents, int) or amount_cents < 0:
                return jsonify(error="A valid transaction amount is required."), 400
            if not isinstance(reference, str) or not reference or len(reference) > 40:
                return jsonify(error="A valid transaction reference is required."), 400
            details.extend(
                [
                    {"label": "Amount", "value": f"${amount_cents / 100:,.2f}"},
                    {"label": "Reference", "value": reference},
                ]
            )
            fee_cents = payload.get("exchangeFeeCents", 0)
            if isinstance(fee_cents, bool) or not isinstance(fee_cents, int) or fee_cents < 0:
                return jsonify(error="A valid exchange fee is required."), 400
            if fee_cents:
                fee_label = "Exchange fee (handled offline by the bank)"
                if event == "transaction_reviewed" and payload.get("status") == "approved":
                    if payload.get("feeCollectedOffline") is not True:
                        return jsonify(error="Offline fee confirmation is required."), 400
                    fee_label = "Exchange fee collected offline"
                details.append({"label": fee_label, "value": f"${fee_cents / 100:,.2f}"})

        if event == "withdrawal_submitted":
            bank = payload.get("recipientBank")
            if isinstance(bank, str) and bank.strip() and len(bank) <= 80:
                details.append({"label": "Recipient bank", "value": bank.strip()})
        elif event == "transaction_reviewed":
            status = payload.get("status")
            if status not in {"approved", "rejected"}:
                return jsonify(error="A valid transaction status is required."), 400
            details.insert(0, {"label": "Status", "value": status.title()})
            intro = (
                "Your transaction was approved. Sign in to review your account."
                if status == "approved"
                else "Your transaction was not approved. Sign in or contact support for details."
            )

        message = Message(subject=subject, recipients=[recipient.strip()])
        message.body = _text_message(name.strip(), intro, details)
        message.html = _html_message(app, name.strip(), intro, details)
        mail.send(message)
        return jsonify(accepted=True), 202

    return app


def _html_message(app: Flask, name: str, intro: str, details: list[dict[str, str]]) -> str:
    return app.jinja_env.get_or_select_template("notification.html").render(
        name=name,
        intro=intro,
        details=details,
    )


def _text_message(name: str, intro: str, details: list[dict[str, str]]) -> str:
    lines = [f"Hello {name},", "", intro]
    lines.extend(f"{item['label']}: {item['value']}" for item in details)
    lines.extend(
        [
            "",
            "Capital Trust Bank",
            "This is an automated account notification.",
            "We will never ask you to email your password or card security code.",
        ]
    )
    return "\n".join(lines)


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")))