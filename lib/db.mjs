/**
 * Database helpers for InvoiceClaw web service — Multi-User.
 * Uses better-sqlite3 (npm) for the web service.
 * Uses Node.js built-in crypto for password hashing (no bcrypt dependency).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const DATA_DIR = process.env.INVOICECLAW_DATA || '/data';
const DB_PATH = `${DATA_DIR}/invoices.db`;

let _db;

export function getDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  return _db;
}

export function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_hash TEXT,
      feishu_open_id TEXT UNIQUE,
      feishu_user_id TEXT,
      email TEXT,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT,
      invoice_code TEXT,
      invoice_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      vendor_name TEXT,
      vendor_tax_id TEXT,
      buyer_name TEXT,
      buyer_tax_id TEXT,
      amount REAL NOT NULL,
      tax_amount REAL DEFAULT 0,
      tax_rate REAL,
      currency TEXT DEFAULT 'CNY',
      invoice_date TEXT,
      status TEXT DEFAULT 'pending',
      category TEXT,
      extra_fields TEXT,
      notes TEXT,
      file_path TEXT,
      reimbursement_status TEXT DEFAULT 'unreimbursed',
      reimbursed_at TEXT,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const cols = db.prepare('PRAGMA table_info(invoices)').all();
  if (!cols.some(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE invoices ADD COLUMN user_id INTEGER REFERENCES users(id)');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_date ON invoices(invoice_date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_type ON invoices(invoice_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_direction ON invoices(direction)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_status ON invoices(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_category ON invoices(category)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reimbursement ON invoices(reimbursement_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_user_id ON invoices(user_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'general',
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      github_issue_number INTEGER,
      github_issue_url TEXT,
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      match_type TEXT NOT NULL,
      match_pattern TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const orphanCount = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE user_id IS NULL').get().c;
  if (orphanCount > 0) {
    let admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (!admin) {
      db.prepare(
        "INSERT OR IGNORE INTO users (username, display_name, role) VALUES ('legacy-admin', 'Legacy Admin', 'admin')"
      ).run();
      admin = db.prepare("SELECT id FROM users WHERE username = 'legacy-admin'").get();
    }
    if (admin) {
      db.prepare('UPDATE invoices SET user_id = ? WHERE user_id IS NULL').run(admin.id);
      console.log(`[db] Migrated ${orphanCount} orphaned invoices to user #${admin.id}`);
    }
  }

  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, zero extra dependencies)
// ---------------------------------------------------------------------------

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const hashToVerify = scryptSync(password, salt, 64);
  return timingSafeEqual(Buffer.from(hash, 'hex'), hashToVerify);
}

// ---------------------------------------------------------------------------
// User CRUD
// ---------------------------------------------------------------------------

export function getUserCount() {
  return getDb().prepare('SELECT COUNT(*) as c FROM users').get().c;
}

export function hasWebUsers() {
  return getDb().prepare("SELECT COUNT(*) as c FROM users WHERE password_hash IS NOT NULL AND password_hash != ''").get().c > 0;
}

export function createUser({ username, password, displayName, feishuOpenId, email, role }) {
  const db = getDb();
  const isFirst = db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0;
  const actualRole = role || (isFirst ? 'admin' : 'user');
  const passwordHash = password ? hashPassword(password) : null;

  const result = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, feishu_open_id, email, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, displayName || username, passwordHash, feishuOpenId || null, email || null, actualRole);

  return db.prepare('SELECT id, username, display_name, feishu_open_id, email, role, created_at FROM users WHERE id = ?')
    .get(result.lastInsertRowid);
}

export function getUser(id) {
  return getDb().prepare(
    'SELECT id, username, display_name, feishu_open_id, email, role, created_at, updated_at FROM users WHERE id = ?'
  ).get(id);
}

export function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function listUsers() {
  return getDb().prepare(
    `SELECT u.id, u.username, u.display_name, u.feishu_open_id, u.email, u.role, u.created_at,
            (SELECT COUNT(*) FROM invoices WHERE user_id = u.id) as invoice_count
     FROM users u ORDER BY u.id`
  ).all();
}

export function updateUser(id, data) {
  const allowed = ['username', 'display_name', 'feishu_open_id', 'feishu_user_id', 'email', 'role'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (data[key] !== undefined) { sets.push(`${key} = ?`); values.push(data[key]); }
  }
  if (data.password) {
    sets.push('password_hash = ?');
    values.push(hashPassword(data.password));
  }
  if (sets.length === 0) return null;
  sets.push("updated_at = datetime('now')");
  values.push(id);

  const db = getDb();
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getUser(id);
}

export function deleteUser(id) {
  const db = getDb();
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND id != ? ORDER BY id LIMIT 1").get(id);
  if (admin) {
    db.prepare('UPDATE invoices SET user_id = ? WHERE user_id = ?').run(admin.id, id);
  }
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  getDb().prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
  ).run(token, userId);
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const session = getDb().prepare(
    "SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(token);
  if (!session) return null;
  return getUser(session.user_id);
}

export function deleteSession(token) {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ---------------------------------------------------------------------------
// Invoice CRUD (user-scoped)
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS = [
  'invoice_number', 'invoice_code', 'invoice_type', 'direction', 'source',
  'vendor_name', 'vendor_tax_id', 'buyer_name', 'buyer_tax_id',
  'amount', 'tax_amount', 'tax_rate', 'currency', 'invoice_date',
  'status', 'category', 'extra_fields', 'notes', 'file_path',
  'reimbursement_status', 'reimbursed_at'
];

export function buildWhereClause(query, userId) {
  const conditions = [];
  const params = [];

  if (userId != null) {
    conditions.push('user_id = ?');
    params.push(userId);
  }

  if (query.month) {
    conditions.push("strftime('%Y-%m', invoice_date) = ?");
    params.push(query.month);
  }
  if (query.quarter) {
    const year = query.year || new Date().getFullYear().toString();
    const qStart = `${year}-${String((parseInt(query.quarter) - 1) * 3 + 1).padStart(2, '0')}-01`;
    const qEnd = `${year}-${String(parseInt(query.quarter) * 3).padStart(2, '0')}-31`;
    conditions.push('invoice_date >= ? AND invoice_date <= ?');
    params.push(qStart, qEnd);
  }
  if (query.year && !query.quarter) {
    conditions.push("strftime('%Y', invoice_date) = ?");
    params.push(query.year);
  }
  for (const [key, col] of [
    ['type', 'invoice_type'], ['direction', 'direction'],
    ['category', 'category'], ['status', 'status'],
    ['reimbursement', 'reimbursement_status']
  ]) {
    if (query[key]) { conditions.push(`${col} = ?`); params.push(query[key]); }
  }
  if (query.reimbursement_not) {
    conditions.push('reimbursement_status != ?');
    params.push(query.reimbursement_not);
  }
  if (query.vendor) { conditions.push('vendor_name LIKE ?'); params.push(`%${query.vendor}%`); }
  if (query.search) {
    const p = `%${query.search}%`;
    conditions.push('(vendor_name LIKE ? OR buyer_name LIKE ? OR invoice_number LIKE ? OR notes LIKE ?)');
    params.push(p, p, p, p);
  }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}

export function listInvoices(query = {}, userId) {
  const db = getDb();
  const { where, params } = buildWhereClause(query, userId);
  const page = parseInt(query.page) || 1;
  const limit = Math.min(parseInt(query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM invoices${where}`).get(...params);
  const rows = db.prepare(
    `SELECT * FROM invoices${where} ORDER BY invoice_date DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  for (const r of rows) {
    if (r.extra_fields) { try { r.extra_fields = JSON.parse(r.extra_fields); } catch {} }
  }

  return { invoices: rows, total: countRow.total, page, limit };
}

export function getInvoice(id, userId) {
  const db = getDb();
  let row;
  if (userId != null) {
    row = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(id, userId);
  } else {
    row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  }
  if (row && row.extra_fields) {
    try { row.extra_fields = JSON.parse(row.extra_fields); } catch {}
  }
  return row;
}

export function createInvoice(data, userId) {
  if (data.extra_fields && typeof data.extra_fields === 'object') {
    data.extra_fields = JSON.stringify(data.extra_fields);
  }

  const db = getDb();
  const cols = [];
  const placeholders = [];
  const values = [];

  if (userId != null) {
    cols.push('user_id');
    placeholders.push('?');
    values.push(userId);
  }

  for (const key of ALLOWED_FIELDS) {
    if (data[key] !== undefined) {
      cols.push(key);
      placeholders.push('?');
      values.push(data[key]);
    }
  }

  const result = db.prepare(
    `INSERT INTO invoices (${cols.join(',')}) VALUES (${placeholders.join(',')})`
  ).run(...values);

  return getInvoice(result.lastInsertRowid);
}

export function updateInvoice(id, data, userId) {
  if (data.extra_fields && typeof data.extra_fields === 'object') {
    data.extra_fields = JSON.stringify(data.extra_fields);
  }

  const sets = [];
  const values = [];
  for (const key of ALLOWED_FIELDS) {
    if (data[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(data[key]);
    }
  }
  if (sets.length === 0) return null;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const db = getDb();
  if (userId != null) {
    const owner = db.prepare('SELECT user_id FROM invoices WHERE id = ?').get(id);
    if (!owner || owner.user_id !== userId) return null;
  }
  db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getInvoice(id);
}

export function deleteInvoice(id, userId) {
  const db = getDb();
  if (userId != null) {
    return db.prepare('DELETE FROM invoices WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }
  return db.prepare('DELETE FROM invoices WHERE id = ?').run(id).changes > 0;
}

export function getStats(query = {}, userId) {
  const db = getDb();
  const { where, params } = buildWhereClause(query, userId);

  const byDirection = db.prepare(
    `SELECT direction, COUNT(*) as count, COALESCE(SUM(amount),0) as total_amount,
            COALESCE(SUM(tax_amount),0) as total_tax
     FROM invoices${where} GROUP BY direction`
  ).all(...params);

  const byType = db.prepare(
    `SELECT invoice_type, direction, COUNT(*) as count, COALESCE(SUM(amount),0) as total
     FROM invoices${where} GROUP BY invoice_type, direction ORDER BY total DESC`
  ).all(...params);

  const byCategory = db.prepare(
    `SELECT category, COUNT(*) as count, COALESCE(SUM(amount),0) as total
     FROM invoices${where} GROUP BY category ORDER BY total DESC`
  ).all(...params);

  const byReimbursement = db.prepare(
    `SELECT reimbursement_status, COUNT(*) as count, COALESCE(SUM(amount),0) as total
     FROM invoices${where} GROUP BY reimbursement_status`
  ).all(...params);

  const byMonth = db.prepare(
    `SELECT strftime('%Y-%m', invoice_date) as month, direction,
            COUNT(*) as count, COALESCE(SUM(amount),0) as total
     FROM invoices${where} GROUP BY month, direction ORDER BY month DESC`
  ).all(...params);

  const buyerCondition = where
    ? `${where} AND buyer_name IS NOT NULL AND buyer_name != ''`
    : ` WHERE buyer_name IS NOT NULL AND buyer_name != ''`;
  const byBuyer = db.prepare(
    `SELECT buyer_name, COUNT(*) as count, COALESCE(SUM(amount),0) as total
     FROM invoices${buyerCondition} GROUP BY buyer_name ORDER BY total DESC`
  ).all(...params);

  return { byDirection, byType, byCategory, byReimbursement, byMonth, byBuyer };
}

export function batchUpdateReimbursement(ids, status, userId) {
  if (!ids?.length) return 0;
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const reimbursedAt = status === 'reimbursed' ? new Date().toISOString() : null;
  let sql = `UPDATE invoices SET reimbursement_status = ?, reimbursed_at = ?, updated_at = datetime('now')
     WHERE id IN (${placeholders})`;
  const params = [status, reimbursedAt, ...ids];
  if (userId != null) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  return db.prepare(sql).run(...params).changes;
}

// ---------------------------------------------------------------------------
// Feedback (unchanged, global — not user-scoped)
// ---------------------------------------------------------------------------

export function listFeedback() {
  return getDb().prepare('SELECT * FROM feedback ORDER BY created_at DESC').all();
}

export function createFeedback({ category, message, github_issue_number, github_issue_url }) {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO feedback (category, message, github_issue_number, github_issue_url)
     VALUES (?, ?, ?, ?)`
  ).run(category || 'general', message, github_issue_number || null, github_issue_url || null);
  return db.prepare('SELECT * FROM feedback WHERE id = ?').get(result.lastInsertRowid);
}

export function resolveFeedback(id) {
  const db = getDb();
  db.prepare(
    `UPDATE feedback SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?`
  ).run(id);
  return db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
}

export function reopenFeedback(id) {
  const db = getDb();
  db.prepare(
    `UPDATE feedback SET status = 'open', resolved_at = NULL WHERE id = ?`
  ).run(id);
  return db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
}

export function feedbackCount() {
  return getDb().prepare('SELECT COUNT(*) as total FROM feedback').get().total;
}

// ---------------------------------------------------------------------------
// Email routing rules
// ---------------------------------------------------------------------------

export function listRoutingRules(userId) {
  const db = getDb();
  if (userId != null) {
    return db.prepare('SELECT * FROM email_routing_rules WHERE user_id = ? ORDER BY priority DESC').all(userId);
  }
  return db.prepare('SELECT * FROM email_routing_rules ORDER BY priority DESC').all();
}

export function createRoutingRule({ userId, matchType, matchPattern, priority }) {
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO email_routing_rules (user_id, match_type, match_pattern, priority) VALUES (?, ?, ?, ?)'
  ).run(userId, matchType, matchPattern, priority || 0);
  return db.prepare('SELECT * FROM email_routing_rules WHERE id = ?').get(result.lastInsertRowid);
}

export function deleteRoutingRule(id) {
  return getDb().prepare('DELETE FROM email_routing_rules WHERE id = ?').run(id).changes > 0;
}

export function matchRoutingRules(fromAddr, subject) {
  const rules = getDb().prepare('SELECT * FROM email_routing_rules ORDER BY priority DESC').all();
  for (const rule of rules) {
    const pattern = rule.match_pattern.toLowerCase();
    const target = rule.match_type === 'from' ? (fromAddr || '').toLowerCase()
      : rule.match_type === 'subject' ? (subject || '').toLowerCase()
      : '';
    if (target.includes(pattern)) return rule.user_id;
  }
  return null;
}
