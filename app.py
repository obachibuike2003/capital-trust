"""Capital Trust Bank - Flask backend in a single file.

A Python port of the API in server.js, plus Flask-Mail emails:
  * welcome message when a customer registers
  * credit alert when money arrives (approved deposit, transfer received)
  * debit alert when money leaves (approved withdrawal or transfer, card fee)

It uses the same SQLite schema, password hashing and session cookies as
server.js, so either server can open the same database.

This file is not wired to the website yet: it serves the API only, not the
pages in public/. Run it with:

    .venv/Scripts/python app.py

Mail settings come from environment variables (see MAIL_* below). Without
MAIL_SERVER, emails are rendered and logged but not sent. With
EMAIL_PREVIEW=1, /dev/emails/<welcome|credit|debit> shows each design in the
browser.
"""

import base64
import hashlib
import hmac
import html
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import date, datetime, timezone

from flask import Flask, g, jsonify, request
from flask_mail import Mail, Message
from werkzeug.exceptions import HTTPException

# --------------------------------------------------------------------------- config

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(BASE_DIR, 'data'))
DB_PATH = os.path.join(DATA_DIR, os.environ.get('DB_FILE', 'bank.db'))
LOGO_PATH = os.path.join(BASE_DIR, 'public', 'img', 'logo-mark-clear.png')

ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', 'admin@capitaltrust.local').lower()
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'Admin@12345')
# Where links in emails point, e.g. https://capital-trust.onrender.com
PUBLIC_BASE_URL = os.environ.get('PUBLIC_BASE_URL', 'http://localhost:3000').rstrip('/')

SESSION_COOKIE = 'ctb_session'
ADMIN_COOKIE = 'ctb_admin'
VISITOR_COOKIE = 'ctb_visitor'
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
VISITOR_TTL_SECONDS = 30 * 24 * 60 * 60
MAX_AMOUNT_CENTS = 1_000_000_00
MAX_VISITOR_MESSAGES = 200

CARD_PRICE_CENTS = 95000
CARD_LIST_PRICE_CENTS = 110000
CARD_TIERS = {'classic': CARD_PRICE_CENTS, 'gold': CARD_PRICE_CENTS, 'platinum': CARD_PRICE_CENTS}
CARD_PRICE = {'priceCents': CARD_PRICE_CENTS, 'listPriceCents': CARD_LIST_PRICE_CENTS}

ACCOUNT_TYPES = {
    'savings': 'Savings account',
    'current': 'Current account',
    'business': 'Business account',
    'joint': 'Joint account',
}
TX_TYPES = {'deposit', 'withdrawal'}

EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
PHONE_RE = re.compile(r'^\+?[0-9][0-9\s()-]{6,19}$')


def env_flag(name, default=False):
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in ('1', 'true', 'yes', 'on')


app = Flask(__name__)
app.config.update(
    MAIL_SERVER=os.environ.get('MAIL_SERVER', 'localhost'),
    MAIL_PORT=int(os.environ.get('MAIL_PORT', '587')),
    MAIL_USE_TLS=env_flag('MAIL_USE_TLS', True),
    MAIL_USE_SSL=env_flag('MAIL_USE_SSL', False),
    MAIL_USERNAME=os.environ.get('MAIL_USERNAME'),
    MAIL_PASSWORD=os.environ.get('MAIL_PASSWORD'),
    MAIL_DEFAULT_SENDER=('Capital Trust Bank', os.environ.get('MAIL_DEFAULT_SENDER', 'no-reply@capitaltrust.local')),
    # Nothing leaves the machine until a mail server is configured.
    MAIL_SUPPRESS_SEND=env_flag('MAIL_SUPPRESS_SEND', 'MAIL_SERVER' not in os.environ),
    # Send in a background thread so requests never wait on SMTP.
    MAIL_ASYNC=env_flag('MAIL_ASYNC', True),
    EMAIL_PREVIEW=env_flag('EMAIL_PREVIEW', False),
)
mail = Mail(app)
log = logging.getLogger('capital-trust')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')


# --------------------------------------------------------------------------- errors

class HttpError(Exception):
    def __init__(self, status, message, field=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.field = field


@app.errorhandler(HttpError)
def handle_http_error(error):
    body = {'error': error.message}
    if error.field:
        body['field'] = error.field
    return jsonify(body), error.status


@app.errorhandler(404)
def handle_not_found(_error):
    return jsonify({'error': 'Not found.'}), 404


@app.errorhandler(405)
def handle_bad_method(_error):
    return jsonify({'error': 'Method not allowed.'}), 405


@app.errorhandler(Exception)
def handle_unexpected(error):
    if isinstance(error, HTTPException):
        return jsonify({'error': error.description}), error.code
    log.exception('Unhandled error: %s', error)
    return jsonify({'error': 'Something went wrong. Please try again.'}), 500


@app.after_request
def security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'same-origin'
    if request.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


# --------------------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  salt           TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'customer',
  account_number TEXT NOT NULL UNIQUE,
  balance_cents  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT NOT NULL UNIQUE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  recipient_account TEXT,
  recipient_name    TEXT,
  recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  admin_note        TEXT,
  created_at        TEXT NOT NULL,
  reviewed_at       TEXT,
  reviewed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS beneficiaries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  account_number TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (user_id, account_number)
);
CREATE TABLE IF NOT EXISTS cards (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  tier      TEXT NOT NULL,
  number    TEXT NOT NULL,
  expiry    TEXT NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  issued_at TEXT NOT NULL,
  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL,
  body       TEXT NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visitors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  email      TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visitor_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL,
  body       TEXT NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_visitor_messages ON visitor_messages(visitor_id);
"""

# Columns added after the first release of the schema.
ADDED_COLUMNS = {
    'users': {
        'phone': 'TEXT',
        'country': 'TEXT',
        'date_of_birth': 'TEXT',
        'account_type': "TEXT NOT NULL DEFAULT 'savings'",
    },
    'cards': {'cvv': 'TEXT'},
}


def connect():
    # Autocommit mode; money movements open their own BEGIN IMMEDIATE.
    conn = sqlite3.connect(DB_PATH, isolation_level=None, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def db():
    if 'db' not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_error):
    conn = g.pop('db', None)
    if conn is not None:
        conn.close()


class transaction:
    """`with transaction(conn):` wraps a block in BEGIN IMMEDIATE ... COMMIT."""

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        self.conn.execute('BEGIN IMMEDIATE')
        return self.conn

    def __exit__(self, exc_type, _exc, _tb):
        self.conn.execute('ROLLBACK' if exc_type else 'COMMIT')
        return False


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = connect()
    try:
        conn.execute('PRAGMA journal_mode = WAL')
        conn.executescript(SCHEMA)
        for table, columns in ADDED_COLUMNS.items():
            existing = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})')}
            for name, definition in columns.items():
                if name not in existing:
                    conn.execute(f'ALTER TABLE {table} ADD COLUMN {name} {definition}')
        for row in conn.execute('SELECT id FROM cards WHERE cvv IS NULL').fetchall():
            conn.execute('UPDATE cards SET cvv = ? WHERE id = ?', (f'{secrets.randbelow(1000):03d}', row['id']))
        if not conn.execute("SELECT 1 FROM users WHERE role = 'admin'").fetchone():
            create_user(conn, 'Bank Administrator', ADMIN_EMAIL, ADMIN_PASSWORD, role='admin')
            log.info('Admin account created: %s / %s', ADMIN_EMAIL, ADMIN_PASSWORD)
    finally:
        conn.close()


# --------------------------------------------------------------------------- helpers

def text(value, limit):
    return value.strip()[:limit] if isinstance(value, str) else ''


def body_json():
    # Requiring JSON blocks plain cross-site form posts.
    if not request.is_json:
        raise HttpError(415, 'Requests must be sent as JSON.')
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise HttpError(400, 'Request body is not valid JSON.')
    return data


def sha256(value):
    return hashlib.sha256(value.encode()).hexdigest()


def money(cents):
    sign = '-' if cents < 0 else ''
    return f'{sign}${abs(cents) / 100:,.2f}'


def reference():
    return 'CTB' + secrets.token_hex(5).upper()


# Same scrypt parameters as Node's crypto.scryptSync defaults, so hashes match.
def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    return digest.hex(), salt


def verify_password(password, user):
    candidate, _ = hash_password(password, user['salt'])
    return hmac.compare_digest(candidate, user['password_hash'])


def new_account_number(conn):
    while True:
        number = str(1_000_000_000 + secrets.randbelow(9_000_000_000))
        if not conn.execute('SELECT 1 FROM users WHERE account_number = ?', (number,)).fetchone():
            return number


def create_user(conn, full_name, email, password, role='customer', phone=None, country=None,
                date_of_birth=None, account_type='savings'):
    password_hash, salt = hash_password(password)
    cursor = conn.execute(
        """INSERT INTO users (full_name, email, password_hash, salt, role, account_number, created_at,
                              phone, country, date_of_birth, account_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (full_name, email, password_hash, salt, role, new_account_number(conn), now_iso(),
         phone, country, date_of_birth, account_type),
    )
    return cursor.lastrowid


def user_by_id(user_id):
    return db().execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()


# Small in-memory limiter for login, registration and chat sign-ups.
_attempts = {}
_attempts_lock = threading.Lock()


def rate_limit(limit=30, window=10 * 60):
    key = request.remote_addr or 'unknown'
    now = time.time()
    with _attempts_lock:
        count, reset_at = _attempts.get(key, (0, now + window))
        if reset_at < now:
            count, reset_at = 0, now + window
        count += 1
        _attempts[key] = (count, reset_at)
    if count > limit:
        raise HttpError(429, 'Too many attempts. Please wait a few minutes and try again.')


# --------------------------------------------------------------------------- sessions

def cookie_for(role):
    return ADMIN_COOKIE if role == 'admin' else SESSION_COOKIE


def start_session(response, user_id, role):
    token = secrets.token_hex(32)
    conn = db()
    conn.execute('DELETE FROM sessions WHERE expires_at < ?', (int(time.time() * 1000),))
    conn.execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
                 (sha256(token), user_id, int((time.time() + SESSION_TTL_SECONDS) * 1000)))
    response.set_cookie(cookie_for(role), token, max_age=SESSION_TTL_SECONDS, httponly=True, samesite='Strict', path='/')


def current_user(scope='customer'):
    """Customers and the admin use separate cookies; each only accepts its own kind of account."""
    token = request.cookies.get(ADMIN_COOKIE if scope == 'admin' else SESSION_COOKIE)
    if not token:
        return None
    user = db().execute(
        """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?""",
        (sha256(token), int(time.time() * 1000)),
    ).fetchone()
    if not user or (user['role'] == 'admin') != (scope == 'admin'):
        return None
    return user


def require_user():
    user = current_user()
    if not user:
        raise HttpError(401, 'Please log in to continue.')
    return user


def require_admin():
    admin = current_user('admin')
    if admin:
        return admin
    if current_user():
        raise HttpError(403, 'Administrator access is required.')
    raise HttpError(401, 'Please log in to continue.')


# --------------------------------------------------------------------------- shapes

def pending_outgoing_cents(user_id):
    row = db().execute(
        """SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions
           WHERE user_id = ? AND status = 'pending' AND type IN ('withdrawal', 'transfer')""",
        (user_id,),
    ).fetchone()
    return row['total']


def public_user(user):
    pending = pending_outgoing_cents(user['id'])
    return {
        'id': user['id'],
        'fullName': user['full_name'],
        'email': user['email'],
        'role': user['role'],
        'accountNumber': user['account_number'],
        'accountType': user['account_type'],
        'phone': user['phone'],
        'country': user['country'],
        'dateOfBirth': user['date_of_birth'],
        'balanceCents': user['balance_cents'],
        'pendingOutgoingCents': pending,
        'availableCents': user['balance_cents'] - pending,
        'createdAt': user['created_at'],
    }


def public_transaction(row, viewer_id=None):
    keys = row.keys()
    incoming = row['type'] == 'deposit' or (viewer_id is not None and row['user_id'] != viewer_id)
    return {
        'id': row['id'],
        'reference': row['reference'],
        'type': row['type'],
        'amountCents': row['amount_cents'],
        'direction': 'in' if incoming else 'out',
        'recipientAccount': row['recipient_account'],
        'recipientName': row['recipient_name'],
        'description': row['description'],
        'status': row['status'],
        'adminNote': row['admin_note'],
        'createdAt': row['created_at'],
        'reviewedAt': row['reviewed_at'],
        'customerName': row['customer_name'] if 'customer_name' in keys else None,
        'customerEmail': row['customer_email'] if 'customer_email' in keys else None,
        'customerAccount': row['customer_account'] if 'customer_account' in keys else None,
        'customerBalanceCents': row['customer_balance_cents'] if 'customer_balance_cents' in keys else None,
    }


def card_for(user_id):
    row = db().execute('SELECT * FROM cards WHERE user_id = ?', (user_id,)).fetchone()
    if not row:
        return None
    return {'tier': row['tier'], 'number': row['number'], 'expiry': row['expiry'], 'cvv': row['cvv'],
            'feeCents': row['fee_cents'], 'issuedAt': row['issued_at']}


# --------------------------------------------------------------------------- validation

def valid_name(value):
    name = text(value, 80)
    if len(name) < 2:
        raise HttpError(400, 'Enter your full name.', 'fullName')
    return name


def valid_phone(value):
    phone = text(value, 24)
    if not PHONE_RE.match(phone):
        raise HttpError(400, 'Enter a phone number with its country code, for example +1 555 123 4567.', 'phone')
    return phone


def valid_country(value):
    country = text(value, 2).upper()
    if not re.fullmatch(r'[A-Z]{2}', country):
        raise HttpError(400, 'Choose your country.', 'country')
    return country


def valid_password(value, field='password'):
    password = value if isinstance(value, str) else ''
    if not 8 <= len(password) <= 200:
        raise HttpError(400, 'Password must be at least 8 characters.', field)
    return password


def valid_date_of_birth(value):
    raw = text(value, 10)
    try:
        born = date.fromisoformat(raw)
    except ValueError:
        raise HttpError(400, 'Enter your date of birth.', 'dateOfBirth') from None
    today = date.today()
    age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
    if age < 18:
        raise HttpError(400, 'You must be at least 18 to open an account.', 'dateOfBirth')
    if born.year < 1900:
        raise HttpError(400, 'Check the year of your date of birth.', 'dateOfBirth')
    return raw


def message_body(data):
    value = text(data.get('body'), 1000)
    if not value:
        raise HttpError(400, 'Type a message first.', 'body')
    return value


# --------------------------------------------------------------------------- email design

# Colours mirror the website's tokens (styles.css).
C = {
    'green900': '#053b2a', 'green800': '#0a4d36', 'green700': '#0b6b47', 'green600': '#0e8a5a',
    'green100': '#ddf3e8', 'green50': '#f1faf5', 'lime': '#a8eb7a', 'ink': '#0e1f18',
    'muted': '#53655c', 'border': '#dce7e1', 'red': '#b42318', 'redBg': '#fee4e2',
}
FONT = "'Plus Jakarta Sans','IBM Plex Sans','Segoe UI',Arial,Helvetica,sans-serif"
LOGO_CID = 'ctb-logo'


def esc(value):
    return html.escape(str(value if value is not None else ''), quote=True)


def first_name(full_name):
    return (full_name or 'there').split()[0]


def format_when(iso_value):
    try:
        when = datetime.fromisoformat(iso_value.replace('Z', '+00:00'))
    except (AttributeError, ValueError):
        when = datetime.now(timezone.utc)
    return when.strftime('%d %b %Y, %H:%M UTC')


def email_button(label, url, background=None, color='#ffffff'):
    background = background or C['green700']
    return f"""
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0">
        <tr><td align="center" bgcolor="{background}" style="border-radius:999px">
          <a href="{esc(url)}" target="_blank"
             style="display:inline-block;padding:14px 30px;font-family:{FONT};font-size:15px;font-weight:700;
                    color:{color};text-decoration:none;border-radius:999px">{esc(label)}</a>
        </td></tr>
      </table>"""


def detail_rows(rows):
    """A two-column table of label/value pairs, like the dashboard's details panels."""
    cells = []
    for i, (label, value) in enumerate(rows):
        border = '' if i == 0 else f'border-top:1px solid {C["border"]};'
        cells.append(f"""
          <tr>
            <td style="{border}padding:12px 0;font-family:{FONT};font-size:14px;color:{C['muted']}">{esc(label)}</td>
            <td align="right" style="{border}padding:12px 0;font-family:{FONT};font-size:14px;font-weight:700;color:{C['ink']}">{esc(value)}</td>
          </tr>""")
    return f"""
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:{C['green50']};border:1px solid {C['border']};border-radius:14px">
        <tr><td style="padding:6px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{''.join(cells)}</table>
        </td></tr>
      </table>"""


def email_layout(*, preheader, eyebrow, title, body, logo_src):
    """Shared frame: dark green header with the logo, white card, green footer."""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>{esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:{C['green50']};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">{esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{C['green50']}">
    <tr><td align="center" style="padding:32px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">

        <!-- Header -->
        <tr><td bgcolor="{C['green900']}" style="background:{C['green900']};border-radius:20px 20px 0 0;padding:26px 32px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="middle" width="52"><img src="{logo_src}" width="44" height="44" alt="Capital Trust Bank"
                 style="display:block;border:0;width:44px;height:44px"></td>
            <td valign="middle" style="padding-left:12px;font-family:{FONT};font-size:19px;font-weight:800;color:#ffffff;letter-spacing:-0.2px">
              Capital Trust Bank</td>
            <td valign="middle" align="right" style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:1.6px;
                 text-transform:uppercase;color:{C['lime']}">{esc(eyebrow)}</td>
          </tr></table>
        </td></tr>
        <tr><td height="4" bgcolor="{C['lime']}" style="background:{C['lime']};font-size:0;line-height:0">&nbsp;</td></tr>

        <!-- Body -->
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:36px 32px 32px;border-left:1px solid {C['border']};border-right:1px solid {C['border']}">
          {body}
        </td></tr>

        <!-- Footer -->
        <tr><td bgcolor="{C['green900']}" style="background:{C['green900']};border-radius:0 0 20px 20px;padding:24px 32px">
          <p style="margin:0 0 6px;font-family:{FONT};font-size:13px;line-height:1.6;color:#c9e2d5">
            Need help? Open <a href="{esc(PUBLIC_BASE_URL)}/dashboard" style="color:{C['lime']};text-decoration:underline">live support</a>
            from your dashboard. We will never ask for your password by email.</p>
          <p style="margin:0;font-family:{FONT};font-size:12px;line-height:1.6;color:#8fb9a5">
            &copy; {date.today().year} Capital Trust Bank &middot; All rights reserved.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>"""


def heading(title, intro):
    return f"""
      <h1 style="margin:0 0 12px;font-family:{FONT};font-size:26px;line-height:1.2;font-weight:800;color:{C['green900']};letter-spacing:-0.5px">{esc(title)}</h1>
      <p style="margin:0 0 24px;font-family:{FONT};font-size:15px;line-height:1.65;color:{C['muted']}">{intro}</p>"""


def welcome_email(user, logo_src):
    name = esc(first_name(user['full_name']))
    account_type = ACCOUNT_TYPES.get(user['account_type'], 'Account')
    steps = [
        ('1', 'Add money', 'Make your first deposit from the Payments page.'),
        ('2', 'Order your card', 'Chat with our team in live support and choose Classic, Gold or Platinum.'),
        ('3', 'Withdraw', 'Withdraw to any account and save the people you pay most.'),
    ]
    step_rows = ''.join(f"""
          <tr>
            <td valign="top" width="40" style="padding:0 0 14px">
              <div style="width:28px;height:28px;border-radius:50%;background:{C['lime']};text-align:center;line-height:28px;
                          font-family:{FONT};font-size:13px;font-weight:800;color:{C['green900']}">{n}</div></td>
            <td valign="top" style="padding:3px 0 14px;font-family:{FONT};font-size:14px;line-height:1.55;color:{C['muted']}">
              <strong style="color:{C['ink']}">{esc(title)}</strong><br>{esc(text_)}</td>
          </tr>""" for n, title, text_ in steps)
    body = f"""
      {heading(f'Welcome to Capital Trust Bank, {first_name(user["full_name"])}', f'Hello {name}, your account is open and ready to use. Here are the details you will need.')}
      {detail_rows([
          ('Account holder', user['full_name']),
          ('Account number', ' '.join(re.findall('.{1,4}', user['account_number']))),
          ('Account type', account_type),
          ('Currency', 'USD'),
      ])}
      <h2 style="margin:30px 0 14px;font-family:{FONT};font-size:17px;font-weight:800;color:{C['green900']}">Get started in three steps</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{step_rows}</table>
      {email_button('Go to my dashboard', PUBLIC_BASE_URL + '/dashboard')}"""
    subject = 'Welcome to Capital Trust Bank'
    html_body = email_layout(preheader=f'Your {account_type.lower()} is open. Account number {user["account_number"]}.',
                             eyebrow='Welcome', title=subject, body=body, logo_src=logo_src)
    plain = (f'Welcome to Capital Trust Bank, {first_name(user["full_name"])}.\n\n'
             f'Your account is open.\nAccount number: {user["account_number"]}\nAccount type: {account_type}\n\n'
             f'Go to your dashboard: {PUBLIC_BASE_URL}/dashboard\n\n'
             'We will never ask for your password by email.')
    return subject, html_body, plain


def alert_email(kind, user, amount_cents, description, ref, when_iso, balance_cents, logo_src):
    """kind is 'credit' or 'debit'."""
    credit = kind == 'credit'
    sign = '+' if credit else '-'
    accent = C['green700'] if credit else C['ink']
    badge_bg, badge_fg = (C['green100'], '#075235') if credit else (C['redBg'], C['red'])
    label = 'Credit alert' if credit else 'Debit alert'
    masked = '•••• ' + user['account_number'][-4:]
    amount_block = f"""
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="border:1px solid {C['border']};border-radius:16px;margin:0 0 20px">
        <tr><td align="center" style="padding:26px 20px">
          <span style="display:inline-block;padding:5px 14px;border-radius:999px;background:{badge_bg};font-family:{FONT};
                       font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:{badge_fg}">{label}</span>
          <p style="margin:14px 0 4px;font-family:{FONT};font-size:38px;line-height:1.1;font-weight:800;color:{accent};letter-spacing:-1px">
            {sign}{esc(money(amount_cents))}</p>
          <p style="margin:0;font-family:{FONT};font-size:14px;color:{C['muted']}">{esc(description)}</p>
        </td></tr>
      </table>"""
    intro = (f'Hello {esc(first_name(user["full_name"]))}, money has arrived in your account.' if credit
             else f'Hello {esc(first_name(user["full_name"]))}, money has left your account.')
    body = f"""
      {heading(label, intro)}
      {amount_block}
      {detail_rows([
          ('Account', masked),
          ('Description', description),
          ('Reference', ref),
          ('Date', format_when(when_iso)),
          ('Available balance', money(balance_cents)),
      ])}
      <p style="margin:22px 0 4px;font-family:{FONT};font-size:13px;line-height:1.6;color:{C['muted']}">
        {'' if credit else 'Did not make this payment? Contact us through live support straight away.'}</p>
      {email_button('View transaction history', PUBLIC_BASE_URL + '/dashboard#history')}"""
    subject = f'{label}: {sign}{money(amount_cents)} on account {masked}'
    html_body = email_layout(preheader=f'{label} of {money(amount_cents)}. Available balance {money(balance_cents)}.',
                             eyebrow=label, title=subject, body=body, logo_src=logo_src)
    plain = (f'{label}\n\n{sign}{money(amount_cents)} - {description}\nAccount: {masked}\nReference: {ref}\n'
             f'Date: {format_when(when_iso)}\nAvailable balance: {money(balance_cents)}\n\n'
             f'View your history: {PUBLIC_BASE_URL}/dashboard#history\n\n'
             'We will never ask for your password by email.')
    return subject, html_body, plain


# --------------------------------------------------------------------------- email sending

def _logo_bytes():
    try:
        with open(LOGO_PATH, 'rb') as handle:
            return handle.read()
    except OSError:
        log.warning('Logo not found at %s; emails will show alt text instead', LOGO_PATH)
        return None


def _deliver(message):
    with app.app_context():
        try:
            mail.send(message)
            if app.config['MAIL_SUPPRESS_SEND']:
                log.info('Email not sent (no mail server configured): "%s" to %s', message.subject, message.recipients)
            else:
                log.info('Email sent: "%s" to %s', message.subject, message.recipients)
        except Exception:  # A mail outage must never break banking requests.
            log.exception('Email failed: "%s" to %s', message.subject, message.recipients)


def send_email(to, rendered):
    subject, html_body, plain = rendered
    message = Message(subject=subject, recipients=[to], body=plain, html=html_body)
    logo = _logo_bytes()
    if logo:
        # Embedded so the logo shows even when the client blocks remote images.
        message.attach('logo.png', 'image/png', logo, 'inline', headers={'Content-ID': f'<{LOGO_CID}>'})
    if app.config['MAIL_ASYNC']:
        threading.Thread(target=_deliver, args=(message,), daemon=True).start()
    else:
        _deliver(message)


def send_welcome(user):
    send_email(user['email'], welcome_email(user, f'cid:{LOGO_CID}'))


def send_alert(kind, user_id, amount_cents, description, ref, when_iso):
    user = user_by_id(user_id)  # read after the change so the balance is current
    if not user or user['role'] == 'admin':
        return
    available = user['balance_cents'] - pending_outgoing_cents(user_id)
    send_email(user['email'], alert_email(kind, user, amount_cents, description, ref, when_iso, available, f'cid:{LOGO_CID}'))


# --------------------------------------------------------------------------- auth routes

@app.get('/')
def index():
    return jsonify({'name': 'Capital Trust Bank API', 'status': 'ok'})


@app.post('/api/register')
def register():
    rate_limit()
    data = body_json()
    full_name = valid_name(data.get('fullName'))
    email = text(data.get('email'), 120).lower()
    if not EMAIL_RE.match(email):
        raise HttpError(400, 'Enter a valid email address.', 'email')
    phone = valid_phone(data.get('phone'))
    date_of_birth = valid_date_of_birth(data.get('dateOfBirth'))
    country = valid_country(data.get('country'))
    account_type = text(data.get('accountType'), 20)
    if account_type not in ACCOUNT_TYPES:
        raise HttpError(400, 'Choose an account type.', 'accountType')
    password = valid_password(data.get('password'))
    conn = db()
    if conn.execute('SELECT 1 FROM users WHERE email = ?', (email,)).fetchone():
        raise HttpError(409, 'An account with this email already exists. Try logging in.', 'email')

    user_id = create_user(conn, full_name, email, password, phone=phone, country=country,
                          date_of_birth=date_of_birth, account_type=account_type)
    user = user_by_id(user_id)
    send_welcome(user)
    response = jsonify({'user': public_user(user)})
    response.status_code = 201
    start_session(response, user_id, 'customer')
    return response


@app.post('/api/login')
def login():
    rate_limit()
    data = body_json()
    email = text(data.get('email'), 120).lower()
    password = data.get('password') if isinstance(data.get('password'), str) else ''
    user = db().execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
    if not user or not verify_password(password, user):
        raise HttpError(401, 'Email or password is incorrect.')
    response = jsonify({'user': public_user(user)})
    start_session(response, user['id'], user['role'])
    return response


@app.post('/api/logout')
def logout():
    data = request.get_json(silent=True) or {}
    name = ADMIN_COOKIE if data.get('scope') == 'admin' else SESSION_COOKIE
    token = request.cookies.get(name)
    if token:
        db().execute('DELETE FROM sessions WHERE token_hash = ?', (sha256(token),))
    response = jsonify({'ok': True})
    response.set_cookie(name, '', max_age=0, httponly=True, samesite='Strict', path='/')
    return response


@app.get('/api/me')
def me():
    return jsonify({'user': public_user(require_user())})


@app.patch('/api/me')
def update_me():
    user = require_user()
    data = body_json()
    db().execute('UPDATE users SET full_name = ?, phone = ?, country = ? WHERE id = ?',
                 (valid_name(data.get('fullName')), valid_phone(data.get('phone')), valid_country(data.get('country')), user['id']))
    return jsonify({'user': public_user(user_by_id(user['id']))})


@app.post('/api/me/password')
def change_password():
    rate_limit()
    user = require_user()
    data = body_json()
    current = data.get('currentPassword')
    if not isinstance(current, str) or not verify_password(current, user):
        raise HttpError(400, 'Your current password is incorrect.', 'currentPassword')
    password_hash, salt = hash_password(valid_password(data.get('newPassword'), 'newPassword'))
    conn = db()
    conn.execute('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', (password_hash, salt, user['id']))
    # Sign out every other device; keep this one.
    conn.execute('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?',
                 (user['id'], sha256(request.cookies.get(SESSION_COOKIE, ''))))
    return jsonify({'ok': True})


# --------------------------------------------------------------------------- customer banking

@app.get('/api/beneficiaries')
def list_beneficiaries():
    user = require_user()
    rows = db().execute('SELECT id, name, account_number FROM beneficiaries WHERE user_id = ? ORDER BY name', (user['id'],)).fetchall()
    return jsonify({'beneficiaries': [{'id': r['id'], 'name': r['name'], 'accountNumber': r['account_number']} for r in rows]})


@app.delete('/api/beneficiaries/<int:beneficiary_id>')
def delete_beneficiary(beneficiary_id):
    user = require_user()
    db().execute('DELETE FROM beneficiaries WHERE id = ? AND user_id = ?', (beneficiary_id, user['id']))
    return jsonify({'ok': True})


@app.get('/api/transactions')
def list_transactions():
    user = require_user()
    rows = db().execute(
        """SELECT * FROM transactions
           WHERE user_id = ? OR (recipient_user_id = ? AND status = 'approved')
           ORDER BY id DESC""",
        (user['id'], user['id']),
    ).fetchall()
    return jsonify({'transactions': [public_transaction(row, user['id']) for row in rows]})


@app.post('/api/transactions')
def create_transaction():
    user = require_user()
    data = body_json()
    tx_type = text(data.get('type'), 20)
    if tx_type not in TX_TYPES:
        raise HttpError(400, 'Choose a transaction type.', 'type')
    try:
        amount_cents = round(float(data.get('amount')) * 100)
    except (TypeError, ValueError):
        amount_cents = 0
    if amount_cents <= 0:
        raise HttpError(400, 'Enter an amount greater than zero.', 'amount')
    if amount_cents > MAX_AMOUNT_CENTS:
        raise HttpError(400, 'The maximum for a single transaction is $1,000,000.', 'amount')

    conn = db()
    # Withdrawing means sending money to an account, so it needs a card and recipient details.
    recipient_account = recipient_name = recipient_user_id = None
    if tx_type == 'withdrawal':
        if not conn.execute('SELECT 1 FROM cards WHERE user_id = ?', (user['id'],)).fetchone():
            raise HttpError(403, 'You need a card to withdraw. Order one from the Card page first.')
        recipient_account = re.sub(r'\s+', '', text(data.get('recipientAccount'), 40))
        recipient_name = text(data.get('recipientName'), 80)
        if not re.fullmatch(r'[A-Za-z0-9]{6,34}', recipient_account):
            raise HttpError(400, 'Enter the account number to send to (6 to 34 letters or digits).', 'recipientAccount')
        if recipient_account == user['account_number']:
            raise HttpError(400, 'You cannot withdraw to your own account.', 'recipientAccount')
        if len(recipient_name) < 2:
            raise HttpError(400, 'Enter the name on the account.', 'recipientName')
        recipient = conn.execute('SELECT id FROM users WHERE account_number = ?', (recipient_account,)).fetchone()
        recipient_user_id = recipient['id'] if recipient else None

    if tx_type != 'deposit' and amount_cents > user['balance_cents'] - pending_outgoing_cents(user['id']):
        raise HttpError(400, 'This is more than your available balance.', 'amount')

    cursor = conn.execute(
        """INSERT INTO transactions (reference, user_id, type, amount_cents, recipient_account, recipient_name,
                                     recipient_user_id, description, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (reference(), user['id'], tx_type, amount_cents, recipient_account, recipient_name, recipient_user_id,
         text(data.get('description'), 140) or None, now_iso()),
    )
    if tx_type == 'withdrawal' and data.get('saveRecipient'):
        conn.execute('INSERT OR IGNORE INTO beneficiaries (user_id, name, account_number, created_at) VALUES (?, ?, ?, ?)',
                     (user['id'], recipient_name, recipient_account, now_iso()))
    row = conn.execute('SELECT * FROM transactions WHERE id = ?', (cursor.lastrowid,)).fetchone()
    response = jsonify({'transaction': public_transaction(row, user['id']), 'user': public_user(user)})
    response.status_code = 201
    return response


@app.get('/api/card')
def my_card():
    user = require_user()
    return jsonify({'card': card_for(user['id']), 'tiers': CARD_TIERS, 'price': CARD_PRICE})


# --------------------------------------------------------------------------- live support

def add_message(table, owner_column, owner_id, sender, body):
    db().execute(f'INSERT INTO {table} ({owner_column}, sender, body, created_at) VALUES (?, ?, ?, ?)',
                 (owner_id, sender, body, now_iso()))


def read_thread(table, owner_column, owner_id, reader):
    """Returns a thread and marks the other side's messages as seen."""
    conn = db()
    rows = conn.execute(f'SELECT id, sender, body, created_at FROM {table} WHERE {owner_column} = ? ORDER BY id', (owner_id,)).fetchall()
    conn.execute(f'UPDATE {table} SET seen = 1 WHERE {owner_column} = ? AND sender != ?', (owner_id, reader))
    return [{'id': r['id'], 'sender': r['sender'], 'body': r['body'], 'createdAt': r['created_at']} for r in rows]


@app.get('/api/support')
def customer_support():
    user = require_user()
    if request.args.get('peek'):
        row = db().execute("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND sender = 'admin' AND seen = 0", (user['id'],)).fetchone()
        return jsonify({'unread': row['n']})
    return jsonify({'messages': read_thread('messages', 'user_id', user['id'], 'customer')})


@app.post('/api/support')
def customer_support_send():
    user = require_user()
    add_message('messages', 'user_id', user['id'], 'customer', message_body(body_json()))
    response = jsonify({'messages': read_thread('messages', 'user_id', user['id'], 'customer')})
    response.status_code = 201
    return response


def current_visitor():
    token = request.cookies.get(VISITOR_COOKIE)
    if not token:
        return None
    return db().execute('SELECT * FROM visitors WHERE token_hash = ?', (sha256(token),)).fetchone()


@app.get('/api/visitor-support')
def visitor_support():
    visitor = current_visitor()
    if not visitor:
        return jsonify({'started': False, 'unread': 0, 'messages': []})
    if request.args.get('peek'):
        row = db().execute("SELECT COUNT(*) AS n FROM visitor_messages WHERE visitor_id = ? AND sender = 'admin' AND seen = 0", (visitor['id'],)).fetchone()
        return jsonify({'started': True, 'unread': row['n']})
    return jsonify({'started': True, 'name': visitor['name'], 'messages': read_thread('visitor_messages', 'visitor_id', visitor['id'], 'visitor')})


@app.post('/api/visitor-support')
def visitor_support_send():
    data = body_json()
    body = message_body(data)
    conn = db()
    visitor = current_visitor()
    new_token = None
    if not visitor:
        rate_limit()
        name = text(data.get('name'), 60)
        email = text(data.get('email'), 120).lower()
        if len(name) < 2:
            raise HttpError(400, 'Enter your name so we know who we are talking to.', 'name')
        if email and not EMAIL_RE.match(email):
            raise HttpError(400, 'Enter a valid email address, or leave it empty.', 'email')
        new_token = secrets.token_hex(32)
        cursor = conn.execute('INSERT INTO visitors (token_hash, name, email, created_at) VALUES (?, ?, ?, ?)',
                              (sha256(new_token), name, email or None, now_iso()))
        visitor = conn.execute('SELECT * FROM visitors WHERE id = ?', (cursor.lastrowid,)).fetchone()

    sent = conn.execute("SELECT COUNT(*) AS n FROM visitor_messages WHERE visitor_id = ? AND sender = 'visitor'", (visitor['id'],)).fetchone()
    if sent['n'] >= MAX_VISITOR_MESSAGES:
        raise HttpError(429, 'This chat has reached its limit. Open an account to keep talking to us.')
    add_message('visitor_messages', 'visitor_id', visitor['id'], 'visitor', body)
    response = jsonify({'started': True, 'name': visitor['name'],
                        'messages': read_thread('visitor_messages', 'visitor_id', visitor['id'], 'visitor')})
    response.status_code = 201
    if new_token:
        response.set_cookie(VISITOR_COOKIE, new_token, max_age=VISITOR_TTL_SECONDS, httponly=True, samesite='Strict', path='/')
    return response


# --------------------------------------------------------------------------- admin

def customer_by_id(user_id):
    customer = db().execute("SELECT * FROM users WHERE id = ? AND role = 'customer'", (user_id,)).fetchone()
    if not customer:
        raise HttpError(404, 'Customer not found.')
    return customer


@app.get('/api/admin/stats')
def admin_stats():
    require_admin()
    conn = db()
    counts = {'pending': 0, 'approved': 0, 'rejected': 0}
    for row in conn.execute('SELECT status, COUNT(*) AS n FROM transactions GROUP BY status'):
        counts[row['status']] = row['n']
    customers = conn.execute("SELECT COUNT(*) AS n, COALESCE(SUM(balance_cents), 0) AS total FROM users WHERE role = 'customer'").fetchone()
    unread = conn.execute(
        """SELECT (SELECT COUNT(*) FROM messages WHERE sender = 'customer' AND seen = 0) +
                  (SELECT COUNT(*) FROM visitor_messages WHERE sender = 'visitor' AND seen = 0) AS n"""
    ).fetchone()
    return jsonify({**counts, 'customers': customers['n'], 'totalBalanceCents': customers['total'], 'unreadSupport': unread['n']})


@app.get('/api/admin/transactions')
def admin_transactions():
    require_admin()
    status = request.args.get('status')
    where, params = ('WHERE t.status = ?', (status,)) if status in ('pending', 'approved', 'rejected') else ('', ())
    rows = db().execute(
        f"""SELECT t.*, u.full_name AS customer_name, u.email AS customer_email,
                   u.account_number AS customer_account, u.balance_cents AS customer_balance_cents
            FROM transactions t JOIN users u ON u.id = t.user_id
            {where} ORDER BY t.id DESC LIMIT 500""",
        params,
    ).fetchall()
    return jsonify({'transactions': [public_transaction(row) for row in rows]})


@app.post('/api/admin/transactions/<int:tx_id>/<action>')
def review_transaction(tx_id, action):
    if action not in ('approve', 'reject'):
        raise HttpError(404, 'Not found.')
    admin = require_admin()
    note = text(body_json().get('note'), 200) or None
    conn = db()
    alerts = []  # sent after commit, so a rolled-back approval never emails anyone

    with transaction(conn):
        tx = conn.execute('SELECT * FROM transactions WHERE id = ?', (tx_id,)).fetchone()
        if not tx:
            raise HttpError(404, 'Transaction not found.')
        if tx['status'] != 'pending':
            raise HttpError(409, 'This transaction has already been reviewed.')
        reviewed_at = now_iso()

        if action == 'approve':
            owner = conn.execute('SELECT * FROM users WHERE id = ?', (tx['user_id'],)).fetchone()
            adjust = 'UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?'
            if tx['type'] == 'deposit':
                conn.execute(adjust, (tx['amount_cents'], owner['id']))
                alerts.append(('credit', owner['id'], tx['description'] or 'Deposit'))
            else:
                if owner['balance_cents'] < tx['amount_cents']:
                    raise HttpError(409, 'The customer does not have enough funds. Reject this request instead.')
                conn.execute(adjust, (-tx['amount_cents'], owner['id']))
                # A withdrawal sends money to an account: debit the sender, and
                # credit the recipient when they are a Capital Trust customer.
                description = f'Withdrawal to {tx["recipient_name"]}' if tx['recipient_name'] else 'Withdrawal'
                alerts.append(('debit', owner['id'], description))
                if tx['recipient_user_id']:
                    conn.execute(adjust, (tx['amount_cents'], tx['recipient_user_id']))
                    alerts.append(('credit', tx['recipient_user_id'], f'Payment from {owner["full_name"]}'))

        conn.execute('UPDATE transactions SET status = ?, admin_note = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?',
                     ('approved' if action == 'approve' else 'rejected', note, reviewed_at, admin['id'], tx_id))

    for kind, user_id, description in alerts:
        send_alert(kind, user_id, tx['amount_cents'], description, tx['reference'], reviewed_at)
    return jsonify({'ok': True})


@app.get('/api/admin/users')
def admin_users():
    require_admin()
    rows = db().execute("SELECT * FROM users WHERE role = 'customer' ORDER BY id DESC").fetchall()
    return jsonify({'users': [{**public_user(row), 'card': card_for(row['id'])} for row in rows],
                    'tiers': CARD_TIERS, 'price': CARD_PRICE})


@app.route('/api/admin/users/<int:user_id>/card', methods=['POST', 'DELETE'])
def admin_card(user_id):
    admin = require_admin()
    customer = customer_by_id(user_id)
    conn = db()
    if request.method == 'DELETE':
        conn.execute('DELETE FROM cards WHERE user_id = ?', (customer['id'],))
        return jsonify({'ok': True})

    data = body_json()
    tier = text(data.get('tier'), 20)
    if tier not in CARD_TIERS:
        raise HttpError(400, 'Choose a card type.', 'tier')
    fee_value = data.get('fee')
    try:
        fee_cents = CARD_TIERS[tier] if fee_value in (None, '') else round(float(fee_value) * 100)
    except (TypeError, ValueError):
        fee_cents = -1
    if not 0 <= fee_cents <= MAX_AMOUNT_CENTS:
        raise HttpError(400, 'Enter a fee of zero or more.', 'fee')
    if card_for(customer['id']):
        raise HttpError(409, 'This customer already has a card.')
    if customer['balance_cents'] - pending_outgoing_cents(customer['id']) < fee_cents:
        raise HttpError(409, 'The customer does not have enough available balance to cover the fee.', 'fee')

    today = date.today()
    expiry = f'{today.month:02d}/{(today.year + 4) % 100:02d}'
    number = '5399' + ''.join(str(secrets.randbelow(10)) for _ in range(12))
    cvv = f'{secrets.randbelow(1000):03d}'
    tier_name = tier.capitalize()
    issued_at = now_iso()
    ref = reference()

    with transaction(conn):
        conn.execute('INSERT INTO cards (user_id, tier, number, expiry, cvv, fee_cents, issued_at, issued_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                     (customer['id'], tier, number, expiry, cvv, fee_cents, issued_at, admin['id']))
        if fee_cents > 0:
            conn.execute('UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?', (fee_cents, customer['id']))
            conn.execute(
                """INSERT INTO transactions (reference, user_id, type, amount_cents, description, status, created_at, reviewed_at, reviewed_by)
                   VALUES (?, ?, 'fee', ?, ?, 'approved', ?, ?, ?)""",
                (ref, customer['id'], fee_cents, f'{tier_name} card', issued_at, issued_at, admin['id']))
        add_message('messages', 'user_id', customer['id'], 'admin',
                    f'Your {tier_name} card has been issued. You can see it on the Card page.')

    if fee_cents > 0:
        send_alert('debit', customer['id'], fee_cents, f'{tier_name} card fee', ref, issued_at)
    response = jsonify({'card': card_for(customer['id'])})
    response.status_code = 201
    return response


@app.get('/api/admin/support')
def admin_inbox():
    require_admin()
    conn = db()
    customers = conn.execute(
        """SELECT u.id, u.full_name, u.email, u.account_number,
                  (SELECT body FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_body,
                  (SELECT created_at FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_at,
                  (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.sender = 'customer' AND m.seen = 0) AS unread
           FROM users u WHERE EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id)"""
    ).fetchall()
    visitors = conn.execute(
        """SELECT v.id, v.name, v.email,
                  (SELECT body FROM visitor_messages m WHERE m.visitor_id = v.id ORDER BY m.id DESC LIMIT 1) AS last_body,
                  (SELECT created_at FROM visitor_messages m WHERE m.visitor_id = v.id ORDER BY m.id DESC LIMIT 1) AS last_at,
                  (SELECT COUNT(*) FROM visitor_messages m WHERE m.visitor_id = v.id AND m.sender = 'visitor' AND m.seen = 0) AS unread
           FROM visitors v"""
    ).fetchall()
    threads = [
        {'kind': 'customer', 'id': r['id'], 'userId': r['id'], 'fullName': r['full_name'], 'email': r['email'],
         'accountNumber': r['account_number'], 'lastBody': r['last_body'], 'lastAt': r['last_at'], 'unread': r['unread']}
        for r in customers
    ] + [
        {'kind': 'visitor', 'id': r['id'], 'fullName': r['name'], 'email': r['email'],
         'lastBody': r['last_body'], 'lastAt': r['last_at'], 'unread': r['unread']}
        for r in visitors if r['last_at']
    ]
    threads.sort(key=lambda t: t['lastAt'] or '', reverse=True)
    return jsonify({'threads': threads})


@app.route('/api/admin/support/<int:user_id>', methods=['GET', 'POST'])
def admin_customer_thread(user_id):
    require_admin()
    customer = customer_by_id(user_id)
    if request.method == 'POST':
        add_message('messages', 'user_id', customer['id'], 'admin', message_body(body_json()))
    return jsonify({'customer': {**public_user(customer), 'card': card_for(customer['id'])},
                    'messages': read_thread('messages', 'user_id', customer['id'], 'admin')})


@app.route('/api/admin/visitor-support/<int:visitor_id>', methods=['GET', 'POST'])
def admin_visitor_thread(visitor_id):
    require_admin()
    visitor = db().execute('SELECT * FROM visitors WHERE id = ?', (visitor_id,)).fetchone()
    if not visitor:
        raise HttpError(404, 'Conversation not found.')
    if request.method == 'POST':
        add_message('visitor_messages', 'visitor_id', visitor['id'], 'admin', message_body(body_json()))
    return jsonify({'visitor': {'id': visitor['id'], 'fullName': visitor['name'], 'email': visitor['email'], 'createdAt': visitor['created_at']},
                    'messages': read_thread('visitor_messages', 'visitor_id', visitor['id'], 'admin')})


# --------------------------------------------------------------------------- email previews

@app.get('/dev/emails/<kind>')
def preview_email(kind):
    """Shows an email design with sample data. Only available with EMAIL_PREVIEW=1."""
    if not app.config['EMAIL_PREVIEW']:
        raise HttpError(404, 'Not found.')
    logo = _logo_bytes()
    logo_src = 'data:image/png;base64,' + base64.b64encode(logo).decode() if logo else ''
    sample = {'full_name': 'Sofia Martinez', 'email': 'sofia@example.com', 'account_number': '6671268751', 'account_type': 'current'}
    when = now_iso()
    if kind == 'welcome':
        _, page, _ = welcome_email(sample, logo_src)
    elif kind == 'credit':
        _, page, _ = alert_email('credit', sample, 250000, 'Payment from Carlos Rivera', 'CTB4F2A91C0DE', when, 1474000, logo_src)
    elif kind == 'debit':
        _, page, _ = alert_email('debit', sample, 95000, 'Gold card fee', 'CTB7B31E9A2F4', when, 1224000, logo_src)
    else:
        raise HttpError(404, 'Choose welcome, credit or debit.')
    return page, 200, {'Content-Type': 'text/html; charset=utf-8'}


# --------------------------------------------------------------------------- start

init_db()

if __name__ == '__main__':
    app.run(host=os.environ.get('HOST', '127.0.0.1'), port=int(os.environ.get('PORT', '5000')),
            debug=env_flag('FLASK_DEBUG', False))
