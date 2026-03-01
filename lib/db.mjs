/**
 * Database helpers for InvoiceClaw web service.
 * Uses better-sqlite3 (npm) for the web service.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_date ON invoices(invoice_date);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_type ON invoices(invoice_type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_direction ON invoices(direction);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_status ON invoices(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_category ON invoices(category);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reimbursement ON invoices(reimbursement_status);`);
}

const ALLOWED_FIELDS = [
  'invoice_number', 'invoice_code', 'invoice_type', 'direction', 'source',
  'vendor_name', 'vendor_tax_id', 'buyer_name', 'buyer_tax_id',
  'amount', 'tax_amount', 'tax_rate', 'currency', 'invoice_date',
  'status', 'category', 'extra_fields', 'notes', 'file_path',
  'reimbursement_status', 'reimbursed_at'
];

export function buildWhereClause(query) {
  const conditions = [];
  const params = [];

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
  if (query.vendor) { conditions.push('vendor_name LIKE ?'); params.push(`%${query.vendor}%`); }
  if (query.search) {
    const p = `%${query.search}%`;
    conditions.push('(vendor_name LIKE ? OR buyer_name LIKE ? OR invoice_number LIKE ? OR notes LIKE ?)');
    params.push(p, p, p, p);
  }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}

export function listInvoices(query = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(query);
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

export function getInvoice(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (row && row.extra_fields) {
    try { row.extra_fields = JSON.parse(row.extra_fields); } catch {}
  }
  return row;
}

export function createInvoice(data) {
  if (data.extra_fields && typeof data.extra_fields === 'object') {
    data.extra_fields = JSON.stringify(data.extra_fields);
  }

  const db = getDb();
  const cols = [];
  const placeholders = [];
  const values = [];

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

export function updateInvoice(id, data) {
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
  db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getInvoice(id);
}

export function deleteInvoice(id) {
  const db = getDb();
  const result = db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getStats(query = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(query);

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

  return { byDirection, byType, byCategory, byReimbursement, byMonth };
}
