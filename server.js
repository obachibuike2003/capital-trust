'use strict';

// Capital Trust Bank - demo banking server.
// No dependencies: Node's built-in http, crypto and sqlite modules only.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@capitaltrust.local').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';

// Customers and the administrator use separate cookies, so one browser can
// be signed in to both at once without one login replacing the other.
const SESSION_COOKIE = 'ctb_session';
const ADMIN_COOKIE = 'ctb_admin';
const cookieFor = (role) => (role === 'admin' ? ADMIN_COOKIE : SESSION_COOKIE);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 10 * 1024;
const MAX_AMOUNT_CENTS = 1_000_000_00;

// ---------------------------------------------------------------- database

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'bank.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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

  -- One support thread per customer. "seen" means read by the other side.
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender     TEXT NOT NULL,
    body       TEXT NOT NULL,
    seen       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);

  -- People chatting from the public pages before they have an account.
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

  CREATE INDEX IF NOT EXISTS idx_visitor_messages ON visitor_messages(visitor_id);
  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
`);

// Profile columns added after the first release; add them to older databases.
{
  const existing = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  const added = {
    phone: 'TEXT',
    country: 'TEXT',
    date_of_birth: 'TEXT',
    account_type: "TEXT NOT NULL DEFAULT 'savings'",
  };
  for (const [name, definition] of Object.entries(added)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
}

// Cards issued before security codes existed get one now.
if (!db.prepare('PRAGMA table_info(cards)').all().some((column) => column.name === 'cvv')) {
  db.exec('ALTER TABLE cards ADD COLUMN cvv TEXT');
}
for (const row of db.prepare('SELECT id FROM cards WHERE cvv IS NULL').all()) {
  db.prepare('UPDATE cards SET cvv = ? WHERE id = ?').run(String(crypto.randomInt(0, 1000)).padStart(3, '0'), row.id);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, user) {
  const candidate = crypto.scryptSync(password, user.salt, 64);
  const stored = Buffer.from(user.password_hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function newAccountNumber() {
  const exists = db.prepare('SELECT 1 FROM users WHERE account_number = ?');
  for (;;) {
    const number = String(crypto.randomInt(1_000_000_000, 10_000_000_000));
    if (!exists.get(number)) return number;
  }
}

function createUser({ fullName, email, password, role = 'customer', phone = null, country = null, dateOfBirth = null, accountType = 'savings' }) {
  const { hash, salt } = hashPassword(password);
  const result = db
    .prepare(
      `INSERT INTO users
         (full_name, email, password_hash, salt, role, account_number, created_at, phone, country, date_of_birth, account_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(fullName, email, hash, salt, role, newAccountNumber(), new Date().toISOString(), phone, country, dateOfBirth, accountType);
  return Number(result.lastInsertRowid);
}

if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  createUser({ fullName: 'Bank Administrator', email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: 'admin' });
  console.log(`Admin account created: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
}

// ---------------------------------------------------------------- helpers

class HttpError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(new HttpError(415, 'Requests must be sent as JSON.'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sessionCookie(token, maxAgeSeconds, name = SESSION_COOKIE) {
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function startSession(userId, role = 'customer') {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    Date.now() + SESSION_TTL_MS
  );
  return sessionCookie(token, SESSION_TTL_MS / 1000, cookieFor(role));
}

// scope is 'customer' or 'admin'; each reads its own cookie and only
// accepts a session that belongs to that kind of account.
function currentUser(req, scope = 'customer') {
  const token = parseCookies(req)[scope === 'admin' ? ADMIN_COOKIE : SESSION_COOKIE];
  if (!token) return null;
  const user = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .get(sha256(token), Date.now());
  if (!user || (user.role === 'admin') !== (scope === 'admin')) return null;
  return user;
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Please log in to continue.');
  return user;
}

function requireAdmin(req) {
  const admin = currentUser(req, 'admin');
  if (admin) return admin;
  if (currentUser(req)) throw new HttpError(403, 'Administrator access is required.');
  throw new HttpError(401, 'Please log in to continue.');
}

// Outgoing requests still awaiting review are held against the balance.
function pendingOutgoingCents(userId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions
       WHERE user_id = ? AND status = 'pending' AND type IN ('withdrawal', 'transfer')`
    )
    .get(userId).total;
}

function publicUser(user) {
  const pending = pendingOutgoingCents(user.id);
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    role: user.role,
    accountNumber: user.account_number,
    accountType: user.account_type,
    phone: user.phone,
    country: user.country,
    dateOfBirth: user.date_of_birth,
    balanceCents: user.balance_cents,
    pendingOutgoingCents: pending,
    availableCents: user.balance_cents - pending,
    createdAt: user.created_at,
  };
}

function publicTransaction(row, viewerId) {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    amountCents: row.amount_cents,
    // "in" adds to the viewer's balance, "out" takes from it.
    direction: row.type === 'deposit' || (viewerId && row.user_id !== viewerId) ? 'in' : 'out',
    recipientAccount: row.recipient_account,
    recipientName: row.recipient_name,
    description: row.description,
    status: row.status,
    adminNote: row.admin_note,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerAccount: row.customer_account,
    customerBalanceCents: row.customer_balance_cents,
  };
}

// One price for every card; the tiers are only different designs.
// The list price is shown crossed out next to the current price.
const CARD_PRICE_CENTS = 95000;
const CARD_LIST_PRICE_CENTS = 110000;
const CARD_TIERS = { classic: CARD_PRICE_CENTS, gold: CARD_PRICE_CENTS, platinum: CARD_PRICE_CENTS };
const CARD_PRICE = { priceCents: CARD_PRICE_CENTS, listPriceCents: CARD_LIST_PRICE_CENTS };

function cardFor(userId) {
  const row = db.prepare('SELECT * FROM cards WHERE user_id = ?').get(userId);
  if (!row) return null;
  return { tier: row.tier, number: row.number, expiry: row.expiry, cvv: row.cvv, feeCents: row.fee_cents, issuedAt: row.issued_at };
}

function addMessage(userId, sender, body) {
  db.prepare('INSERT INTO messages (user_id, sender, body, created_at) VALUES (?, ?, ?, ?)').run(
    userId,
    sender,
    body,
    new Date().toISOString()
  );
}

// Returns a thread and marks the other side's messages as seen by `reader`.
function readThread(userId, reader) {
  const rows = db.prepare('SELECT id, sender, body, created_at FROM messages WHERE user_id = ? ORDER BY id').all(userId);
  db.prepare('UPDATE messages SET seen = 1 WHERE user_id = ? AND sender != ?').run(userId, reader);
  return rows.map((row) => ({ id: row.id, sender: row.sender, body: row.body, createdAt: row.created_at }));
}

function messageBody(body) {
  const value = text(body.body, 1000);
  if (!value) throw new HttpError(400, 'Type a message first.', 'body');
  return value;
}

const VISITOR_COOKIE = 'ctb_visitor';
const VISITOR_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_VISITOR_MESSAGES = 200;

function currentVisitor(req) {
  const token = parseCookies(req)[VISITOR_COOKIE];
  if (!token) return null;
  return db.prepare('SELECT * FROM visitors WHERE token_hash = ?').get(sha256(token)) || null;
}

function addVisitorMessage(visitorId, sender, body) {
  db.prepare('INSERT INTO visitor_messages (visitor_id, sender, body, created_at) VALUES (?, ?, ?, ?)').run(
    visitorId,
    sender,
    body,
    new Date().toISOString()
  );
}

function readVisitorThread(visitorId, reader) {
  const rows = db
    .prepare('SELECT id, sender, body, created_at FROM visitor_messages WHERE visitor_id = ? ORDER BY id')
    .all(visitorId);
  db.prepare('UPDATE visitor_messages SET seen = 1 WHERE visitor_id = ? AND sender != ?').run(visitorId, reader);
  return rows.map((row) => ({ id: row.id, sender: row.sender, body: row.body, createdAt: row.created_at }));
}

function customerById(id) {
  const customer = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'customer'").get(id);
  if (!customer) throw new HttpError(404, 'Customer not found.');
  return customer;
}

// Small in-memory limiter for the login and register endpoints.
const attempts = new Map();
function rateLimit(req, limit = 30, windowMs = 10 * 60 * 1000) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (++entry.count > limit) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

// ---------------------------------------------------------------- API routes

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s()-]{6,19}$/;
const TX_TYPES = new Set(['deposit', 'withdrawal']);
const ACCOUNT_TYPES = new Set(['savings', 'current', 'business', 'joint']);

function validName(value) {
  const fullName = text(value, 80);
  if (fullName.length < 2) throw new HttpError(400, 'Enter your full name.', 'fullName');
  return fullName;
}

function validPhone(value) {
  const phone = text(value, 24);
  if (!PHONE_RE.test(phone)) {
    throw new HttpError(400, 'Enter a phone number with its country code, for example +1 555 123 4567.', 'phone');
  }
  return phone;
}

function validCountry(value) {
  const country = text(value, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new HttpError(400, 'Choose your country.', 'country');
  return country;
}

function validPassword(value, field = 'password') {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'Password must be at least 8 characters.', field);
  }
  return password;
}

function validDateOfBirth(value) {
  const dateOfBirth = text(value, 10);
  const born = new Date(`${dateOfBirth}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) || Number.isNaN(born.getTime())) {
    throw new HttpError(400, 'Enter your date of birth.', 'dateOfBirth');
  }
  const eighteenth = new Date(born);
  eighteenth.setUTCFullYear(born.getUTCFullYear() + 18);
  if (eighteenth > new Date()) throw new HttpError(400, 'You must be at least 18 to open an account.', 'dateOfBirth');
  if (born.getUTCFullYear() < 1900) throw new HttpError(400, 'Check the year of your date of birth.', 'dateOfBirth');
  return dateOfBirth;
}

const routes = {
  'POST /api/register': async (req, res) => {
    rateLimit(req);
    const body = await readJson(req);
    const fullName = validName(body.fullName);
    const email = text(body.email, 120).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'email');
    const phone = validPhone(body.phone);
    const dateOfBirth = validDateOfBirth(body.dateOfBirth);
    const country = validCountry(body.country);
    const accountType = text(body.accountType, 20);
    if (!ACCOUNT_TYPES.has(accountType)) throw new HttpError(400, 'Choose an account type.', 'accountType');
    const password = validPassword(body.password);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with this email already exists. Try logging in.', 'email');
    }

    const id = createUser({ fullName, email, password, phone, country, dateOfBirth, accountType });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    sendJson(res, 201, { user: publicUser(user) }, { 'Set-Cookie': startSession(id) });
  },

  'POST /api/login': async (req, res) => {
    rateLimit(req);
    const body = await readJson(req);
    const email = text(body.email, 120).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user)) {
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': startSession(user.id, user.role) });
  },

  'POST /api/logout': async (req, res) => {
    // Logging out of the admin console leaves a customer login in the same browser alone.
    const body = await readJson(req).catch(() => ({}));
    const name = body.scope === 'admin' ? ADMIN_COOKIE : SESSION_COOKIE;
    const token = parseCookies(req)[name];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, name) });
  },

  'GET /api/me': async (req, res) => {
    sendJson(res, 200, { user: publicUser(requireUser(req)) });
  },

  'PATCH /api/me': async (req, res) => {
    const user = requireUser(req);
    const body = await readJson(req);
    db.prepare('UPDATE users SET full_name = ?, phone = ?, country = ? WHERE id = ?').run(
      validName(body.fullName),
      validPhone(body.phone),
      validCountry(body.country),
      user.id
    );
    sendJson(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
  },

  'POST /api/me/password': async (req, res) => {
    rateLimit(req);
    const user = requireUser(req);
    const body = await readJson(req);
    if (typeof body.currentPassword !== 'string' || !verifyPassword(body.currentPassword, user)) {
      throw new HttpError(400, 'Your current password is incorrect.', 'currentPassword');
    }
    const { hash, salt } = hashPassword(validPassword(body.newPassword, 'newPassword'));
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, user.id);
    // Sign out every other device; keep this one.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(
      user.id,
      sha256(parseCookies(req)[SESSION_COOKIE])
    );
    sendJson(res, 200, { ok: true });
  },

  'GET /api/beneficiaries': async (req, res) => {
    const user = requireUser(req);
    const rows = db
      .prepare('SELECT id, name, account_number FROM beneficiaries WHERE user_id = ? ORDER BY name')
      .all(user.id);
    sendJson(res, 200, {
      beneficiaries: rows.map((row) => ({ id: row.id, name: row.name, accountNumber: row.account_number })),
    });
  },

  'GET /api/transactions': async (req, res) => {
    const user = requireUser(req);
    const rows = db
      .prepare(
        `SELECT * FROM transactions
         WHERE user_id = ? OR (recipient_user_id = ? AND status = 'approved')
         ORDER BY id DESC`
      )
      .all(user.id, user.id);
    sendJson(res, 200, { transactions: rows.map((row) => publicTransaction(row, user.id)) });
  },

  'POST /api/transactions': async (req, res) => {
    const user = requireUser(req);
    if (user.role === 'admin') throw new HttpError(403, 'Administrator accounts cannot create transactions.');
    const body = await readJson(req);

    const type = text(body.type, 20);
    if (!TX_TYPES.has(type)) throw new HttpError(400, 'Choose a transaction type.', 'type');

    const amountCents = Math.round(Number(body.amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new HttpError(400, 'Enter an amount greater than zero.', 'amount');
    }
    if (amountCents > MAX_AMOUNT_CENTS) {
      throw new HttpError(400, 'The maximum for a single transaction is $1,000,000.', 'amount');
    }

    // Withdrawing means sending money to an account, so it needs a card and recipient details.
    let recipientAccount = null;
    let recipientName = null;
    let recipientUserId = null;
    if (type === 'withdrawal') {
      if (!db.prepare('SELECT 1 FROM cards WHERE user_id = ?').get(user.id)) {
        throw new HttpError(403, 'You need a card to withdraw. Order one from the Card page first.');
      }
      recipientAccount = text(body.recipientAccount, 34).replace(/\s+/g, '');
      recipientName = text(body.recipientName, 80);
      if (!/^[A-Za-z0-9]{6,34}$/.test(recipientAccount)) {
        throw new HttpError(400, 'Enter the account number to send to (6 to 34 letters or digits).', 'recipientAccount');
      }
      if (recipientAccount === user.account_number) {
        throw new HttpError(400, 'You cannot withdraw to your own account.', 'recipientAccount');
      }
      if (recipientName.length < 2) throw new HttpError(400, 'Enter the name on the account.', 'recipientName');
      const recipient = db.prepare('SELECT id FROM users WHERE account_number = ?').get(recipientAccount);
      if (recipient) recipientUserId = recipient.id;
    }

    if (type !== 'deposit') {
      const available = user.balance_cents - pendingOutgoingCents(user.id);
      if (amountCents > available) {
        throw new HttpError(400, 'This is more than your available balance.', 'amount');
      }
    }

    const reference = 'CTB' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const result = db
      .prepare(
        `INSERT INTO transactions
           (reference, user_id, type, amount_cents, recipient_account, recipient_name, recipient_user_id, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        reference,
        user.id,
        type,
        amountCents,
        recipientAccount,
        recipientName,
        recipientUserId,
        text(body.description, 140) || null,
        new Date().toISOString()
      );
    if (type === 'withdrawal' && body.saveRecipient) {
      db.prepare(
        'INSERT OR IGNORE INTO beneficiaries (user_id, name, account_number, created_at) VALUES (?, ?, ?, ?)'
      ).run(user.id, recipientName, recipientAccount, new Date().toISOString());
    }
    const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(result.lastInsertRowid));
    sendJson(res, 201, { transaction: publicTransaction(row, user.id), user: publicUser(user) });
  },

  'GET /api/card': async (req, res) => {
    const user = requireUser(req);
    sendJson(res, 200, { card: cardFor(user.id), tiers: CARD_TIERS, price: CARD_PRICE });
  },

  'GET /api/support': async (req, res, url) => {
    const user = requireUser(req);
    // ?peek=1 only counts unread replies, so the badge can poll without marking them read.
    if (url.searchParams.get('peek')) {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND sender = 'admin' AND seen = 0")
        .get(user.id);
      return sendJson(res, 200, { unread: row.n });
    }
    sendJson(res, 200, { messages: readThread(user.id, 'customer') });
  },

  'POST /api/support': async (req, res) => {
    const user = requireUser(req);
    if (user.role === 'admin') throw new HttpError(403, 'Use the admin support inbox to reply.');
    addMessage(user.id, 'customer', messageBody(await readJson(req)));
    sendJson(res, 201, { messages: readThread(user.id, 'customer') });
  },

  'GET /api/visitor-support': async (req, res, url) => {
    const visitor = currentVisitor(req);
    if (!visitor) return sendJson(res, 200, { started: false, unread: 0, messages: [] });
    if (url.searchParams.get('peek')) {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM visitor_messages WHERE visitor_id = ? AND sender = 'admin' AND seen = 0")
        .get(visitor.id);
      return sendJson(res, 200, { started: true, unread: row.n });
    }
    sendJson(res, 200, { started: true, name: visitor.name, messages: readVisitorThread(visitor.id, 'visitor') });
  },

  'POST /api/visitor-support': async (req, res) => {
    const body = await readJson(req);
    const message = messageBody(body);
    let visitor = currentVisitor(req);
    const headers = {};

    if (!visitor) {
      rateLimit(req);
      const name = text(body.name, 60);
      const email = text(body.email, 120).toLowerCase();
      if (name.length < 2) throw new HttpError(400, 'Enter your name so we know who we are talking to.', 'name');
      if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address, or leave it empty.', 'email');
      const token = crypto.randomBytes(32).toString('hex');
      const result = db
        .prepare('INSERT INTO visitors (token_hash, name, email, created_at) VALUES (?, ?, ?, ?)')
        .run(sha256(token), name, email || null, new Date().toISOString());
      visitor = { id: Number(result.lastInsertRowid), name };
      headers['Set-Cookie'] = `${VISITOR_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${VISITOR_TTL_SECONDS}`;
    }

    const sent = db
      .prepare("SELECT COUNT(*) AS n FROM visitor_messages WHERE visitor_id = ? AND sender = 'visitor'")
      .get(visitor.id);
    if (sent.n >= MAX_VISITOR_MESSAGES) {
      throw new HttpError(429, 'This chat has reached its limit. Open an account to keep talking to us.');
    }
    addVisitorMessage(visitor.id, 'visitor', message);
    sendJson(res, 201, { started: true, name: visitor.name, messages: readVisitorThread(visitor.id, 'visitor') }, headers);
  },

  'GET /api/admin/support': async (req, res) => {
    requireAdmin(req);
    const visitorRows = db
      .prepare(
        `SELECT v.id, v.name, v.email,
                (SELECT body FROM visitor_messages m WHERE m.visitor_id = v.id ORDER BY m.id DESC LIMIT 1) AS last_body,
                (SELECT created_at FROM visitor_messages m WHERE m.visitor_id = v.id ORDER BY m.id DESC LIMIT 1) AS last_at,
                (SELECT COUNT(*) FROM visitor_messages m WHERE m.visitor_id = v.id AND m.sender = 'visitor' AND m.seen = 0) AS unread
         FROM visitors v`
      )
      .all();
    const rows = db
      .prepare(
        `SELECT u.id, u.full_name, u.email, u.account_number,
                (SELECT body FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_body,
                (SELECT created_at FROM messages m WHERE m.user_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_at,
                (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id AND m.sender = 'customer' AND m.seen = 0) AS unread
         FROM users u
         WHERE EXISTS (SELECT 1 FROM messages m WHERE m.user_id = u.id)
         ORDER BY last_at DESC`
      )
      .all();
    const threads = [
      ...rows.map((row) => ({
        kind: 'customer',
        id: row.id,
        userId: row.id,
        fullName: row.full_name,
        email: row.email,
        accountNumber: row.account_number,
        lastBody: row.last_body,
        lastAt: row.last_at,
        unread: row.unread,
      })),
      ...visitorRows.map((row) => ({
        kind: 'visitor',
        id: row.id,
        fullName: row.name,
        email: row.email,
        lastBody: row.last_body,
        lastAt: row.last_at,
        unread: row.unread,
      })),
    ].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    sendJson(res, 200, { threads });
  },

  'GET /api/admin/stats': async (req, res) => {
    requireAdmin(req);
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM transactions GROUP BY status').all()) {
      counts[row.status] = row.n;
    }
    const customers = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(balance_cents), 0) AS total FROM users WHERE role = 'customer'")
      .get();
    const support = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM messages WHERE sender = 'customer' AND seen = 0) +
                (SELECT COUNT(*) FROM visitor_messages WHERE sender = 'visitor' AND seen = 0) AS n`
      )
      .get();
    sendJson(res, 200, {
      ...counts,
      customers: customers.n,
      totalBalanceCents: customers.total,
      unreadSupport: support.n,
    });
  },

  'GET /api/admin/transactions': async (req, res, url) => {
    requireAdmin(req);
    const status = url.searchParams.get('status');
    const filter = ['pending', 'approved', 'rejected'].includes(status) ? status : null;
    const rows = db
      .prepare(
        `SELECT t.*, u.full_name AS customer_name, u.email AS customer_email,
                u.account_number AS customer_account, u.balance_cents AS customer_balance_cents
         FROM transactions t JOIN users u ON u.id = t.user_id
         ${filter ? 'WHERE t.status = ?' : ''}
         ORDER BY t.id DESC LIMIT 500`
      )
      .all(...(filter ? [filter] : []));
    sendJson(res, 200, { transactions: rows.map((row) => publicTransaction(row)) });
  },

  'GET /api/admin/users': async (req, res) => {
    requireAdmin(req);
    const rows = db.prepare("SELECT * FROM users WHERE role = 'customer' ORDER BY id DESC").all();
    sendJson(res, 200, { users: rows.map((row) => ({ ...publicUser(row), card: cardFor(row.id) })), tiers: CARD_TIERS, price: CARD_PRICE });
  },
};

// POST /api/admin/transactions/:id/(approve|reject)
async function reviewTransaction(req, res, id, action) {
  const admin = requireAdmin(req);
  const body = await readJson(req);
  const note = text(body.note, 200) || null;

  db.exec('BEGIN IMMEDIATE');
  try {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    if (!tx) throw new HttpError(404, 'Transaction not found.');
    if (tx.status !== 'pending') throw new HttpError(409, 'This transaction has already been reviewed.');

    if (action === 'approve') {
      const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(tx.user_id);
      const adjust = db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?');
      if (tx.type === 'deposit') {
        adjust.run(tx.amount_cents, owner.id);
      } else {
        if (owner.balance_cents < tx.amount_cents) {
          throw new HttpError(409, 'The customer does not have enough funds. Reject this request instead.');
        }
        adjust.run(-tx.amount_cents, owner.id);
        // A withdrawal sent to another Capital Trust account credits that account.
        if (tx.recipient_user_id) adjust.run(tx.amount_cents, tx.recipient_user_id);
      }
    }

    db.prepare('UPDATE transactions SET status = ?, admin_note = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?').run(
      action === 'approve' ? 'approved' : 'rejected',
      note,
      new Date().toISOString(),
      admin.id,
      id
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  sendJson(res, 200, { ok: true });
}

// GET/POST /api/admin/support/:userId
async function adminThread(req, res, userId) {
  requireAdmin(req);
  const customer = customerById(userId);
  if (req.method === 'POST') addMessage(customer.id, 'admin', messageBody(await readJson(req)));
  sendJson(res, 200, {
    customer: { ...publicUser(customer), card: cardFor(customer.id) },
    messages: readThread(customer.id, 'admin'),
  });
}

// GET/POST /api/admin/visitor-support/:visitorId
async function adminVisitorThread(req, res, visitorId) {
  requireAdmin(req);
  const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(visitorId);
  if (!visitor) throw new HttpError(404, 'Conversation not found.');
  if (req.method === 'POST') addVisitorMessage(visitor.id, 'admin', messageBody(await readJson(req)));
  sendJson(res, 200, {
    visitor: { id: visitor.id, fullName: visitor.name, email: visitor.email, createdAt: visitor.created_at },
    messages: readVisitorThread(visitor.id, 'admin'),
  });
}

// POST issues a card to the customer, DELETE takes it away.
async function adminCard(req, res, userId) {
  const admin = requireAdmin(req);
  const customer = customerById(userId);

  if (req.method === 'DELETE') {
    db.prepare('DELETE FROM cards WHERE user_id = ?').run(customer.id);
    return sendJson(res, 200, { ok: true });
  }

  const body = await readJson(req);
  const tier = text(body.tier, 20);
  if (!(tier in CARD_TIERS)) throw new HttpError(400, 'Choose a card type.', 'tier');
  const feeCents = body.fee === undefined || body.fee === '' ? CARD_TIERS[tier] : Math.round(Number(body.fee) * 100);
  if (!Number.isFinite(feeCents) || feeCents < 0 || feeCents > MAX_AMOUNT_CENTS) {
    throw new HttpError(400, 'Enter a fee of zero or more.', 'fee');
  }
  if (cardFor(customer.id)) throw new HttpError(409, 'This customer already has a card.');
  if (customer.balance_cents - pendingOutgoingCents(customer.id) < feeCents) {
    throw new HttpError(409, 'The customer does not have enough available balance to cover the fee.', 'fee');
  }

  const now = new Date();
  const expiry = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getFullYear() + 4).slice(2)}`;
  let number = '5399';
  while (number.length < 16) number += crypto.randomInt(0, 10);
  const cvv = String(crypto.randomInt(0, 1000)).padStart(3, '0');
  const tierName = tier[0].toUpperCase() + tier.slice(1);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO cards (user_id, tier, number, expiry, cvv, fee_cents, issued_at, issued_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      customer.id,
      tier,
      number,
      expiry,
      cvv,
      feeCents,
      now.toISOString(),
      admin.id
    );
    if (feeCents > 0) {
      db.prepare('UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?').run(feeCents, customer.id);
      db.prepare(
        `INSERT INTO transactions (reference, user_id, type, amount_cents, description, status, created_at, reviewed_at, reviewed_by)
         VALUES (?, ?, 'fee', ?, ?, 'approved', ?, ?, ?)`
      ).run(
        'CTB' + crypto.randomBytes(5).toString('hex').toUpperCase(),
        customer.id,
        feeCents,
        `${tierName} card`,
        now.toISOString(),
        now.toISOString(),
        admin.id
      );
    }
    addMessage(customer.id, 'admin', `Your ${tierName} card has been issued. You can see it on the Card page.`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  sendJson(res, 201, { card: cardFor(customer.id) });
}

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
  '/register': 'register.html',
  '/dashboard': 'dashboard.html',
  '/admin': 'admin.html',
};

function serveStatic(req, res, pathname) {
  if (pathname === '/dashboard' && !currentUser(req)) {
    return redirect(res, currentUser(req, 'admin') ? '/admin' : '/login');
  }
  // Someone opening /admin without an admin login is asked to log in as admin,
  // even if a customer is signed in on the same browser.
  if (pathname === '/admin' && !currentUser(req, 'admin')) return redirect(res, '/login');

  const relative = PAGES[pathname] || pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1><p>Page not found. <a href="/">Back to Capital Trust Bank</a></p>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname.startsWith('/api/')) {
      const review = pathname.match(/^\/api\/admin\/transactions\/(\d+)\/(approve|reject)$/);
      if (review && req.method === 'POST') return await reviewTransaction(req, res, Number(review[1]), review[2]);

      const thread = pathname.match(/^\/api\/admin\/support\/(\d+)$/);
      if (thread && (req.method === 'GET' || req.method === 'POST')) return await adminThread(req, res, Number(thread[1]));

      const visitorThread = pathname.match(/^\/api\/admin\/visitor-support\/(\d+)$/);
      if (visitorThread && (req.method === 'GET' || req.method === 'POST')) {
        return await adminVisitorThread(req, res, Number(visitorThread[1]));
      }

      const card = pathname.match(/^\/api\/admin\/users\/(\d+)\/card$/);
      if (card && (req.method === 'POST' || req.method === 'DELETE')) return await adminCard(req, res, Number(card[1]));

      const saved = pathname.match(/^\/api\/beneficiaries\/(\d+)$/);
      if (saved && req.method === 'DELETE') {
        const user = requireUser(req);
        db.prepare('DELETE FROM beneficiaries WHERE id = ? AND user_id = ?').run(Number(saved[1]), user.id);
        return sendJson(res, 200, { ok: true });
      }

      const handler = routes[`${req.method} ${pathname}`];
      if (!handler) throw new HttpError(404, 'Not found.');
      return await handler(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    serveStatic(req, res, pathname);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    if (res.headersSent) return res.end();
    sendJson(res, error.status || 500, {
      error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.',
      field: error.field,
    });
  }
});

server.listen(PORT, () => {
  console.log(`Capital Trust Bank is running at http://localhost:${PORT}`);
});
