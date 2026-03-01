#!/usr/bin/env node --experimental-sqlite
/**
 * InvoiceClaw CLI — 发票管理工具
 * Uses Node.js built-in node:sqlite (no npm dependencies).
 *
 * Commands:
 *   init                              Initialize database
 *   add --json '{...}' [--file path]  Add invoice (optionally copy source file)
 *   list [filters]                    List invoices
 *   get <id>                          Get invoice detail
 *   update <id> --json '{...}'        Update invoice
 *   delete <id>                       Delete invoice
 *   reimburse <id>                    Mark as reimbursed
 *   unreimburse <id>                  Revert to unreimbursed
 *   unreimbursed                      List all unreimbursed invoices
 *   stats [filters]                   Statistics
 *   export [--format csv|json]        Export
 *   package --month YYYY-MM           Zip month's invoices + summary
 *   search <keyword>                  Search
 *   categories                        List categories
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const DATA_DIR = process.env.INVOICECLAW_DATA || join(homedir(), '.openclaw', 'workspace', 'finance');
const DB_PATH = join(DATA_DIR, 'invoices.db');
const INVOICES_DIR = join(DATA_DIR, 'invoices');
const EXPORTS_DIR = join(DATA_DIR, 'exports');

function getDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  return new DatabaseSync(DB_PATH);
}

function initDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT,
      invoice_code TEXT,
      invoice_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'telegram',
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
  db.close();
  console.log(`Database initialized at ${DB_PATH}`);
}

const ALLOWED_FIELDS = [
  'invoice_number', 'invoice_code', 'invoice_type', 'direction', 'source',
  'vendor_name', 'vendor_tax_id', 'buyer_name', 'buyer_tax_id',
  'amount', 'tax_amount', 'tax_rate', 'currency', 'invoice_date',
  'status', 'category', 'extra_fields', 'notes', 'file_path',
  'reimbursement_status', 'reimbursed_at'
];

function copyInvoiceFile(sourcePath, invoiceDate) {
  if (!sourcePath || !existsSync(sourcePath)) return null;

  const date = invoiceDate ? new Date(invoiceDate) : new Date();
  const year = date.getFullYear().toString();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const destDir = join(INVOICES_DIR, year, month);
  mkdirSync(destDir, { recursive: true });

  const ext = extname(sourcePath);
  const ts = Date.now();
  const destName = `${ts}${ext}`;
  const destPath = join(destDir, destName);

  copyFileSync(sourcePath, destPath);
  return destPath;
}

const CONSUMED_FILE = join(DATA_DIR, '.consumed-media');

function loadConsumed() {
  if (!existsSync(CONSUMED_FILE)) return new Set();
  return new Set(readFileSync(CONSUMED_FILE, 'utf-8').split('\n').filter(Boolean));
}

function markConsumed(filename) {
  mkdirSync(dirname(CONSUMED_FILE), { recursive: true });
  appendFileSync(CONSUMED_FILE, filename + '\n');
}

function findLatestMedia() {
  const mediaDir = join(homedir(), '.openclaw', 'media', 'inbound');
  if (!existsSync(mediaDir)) return null;
  try {
    const consumed = loadConsumed();
    const files = readdirSync(mediaDir)
      .filter(f => !consumed.has(f) && statSync(join(mediaDir, f)).isFile())
      .map(f => ({ name: f, mtime: statSync(join(mediaDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return join(mediaDir, files[0].name);
  } catch { return null; }
}

function addInvoice(jsonStr, filePath) {
  const data = JSON.parse(jsonStr);
  if (!data.invoice_type) throw new Error('invoice_type is required');
  if (!data.direction) throw new Error('direction is required');
  if (data.amount == null) throw new Error('amount is required');

  const sourceFile = filePath || findLatestMedia();
  if (sourceFile) {
    const savedPath = copyInvoiceFile(sourceFile, data.invoice_date);
    if (savedPath) {
      data.file_path = savedPath;
      markConsumed(basename(sourceFile));
    }
  }

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

  const stmt = db.prepare(
    `INSERT INTO invoices (${cols.join(',')}) VALUES (${placeholders.join(',')})`
  );
  const result = stmt.run(...values);
  const id = Number(result.lastInsertRowid);
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  db.close();

  if (row.extra_fields) {
    try { row.extra_fields = JSON.parse(row.extra_fields); } catch {}
  }
  console.log(JSON.stringify(row, null, 2));
}

function buildWhereClause(args) {
  const conditions = [];
  const params = [];

  const month = getArg(args, '--month');
  if (month) {
    conditions.push("strftime('%Y-%m', invoice_date) = ?");
    params.push(month);
  }

  const quarter = getArg(args, '--quarter');
  if (quarter) {
    const year = getArg(args, '--year') || new Date().getFullYear().toString();
    const qStart = `${year}-${String((parseInt(quarter) - 1) * 3 + 1).padStart(2, '0')}-01`;
    const qEndMonth = parseInt(quarter) * 3;
    const qEnd = `${year}-${String(qEndMonth).padStart(2, '0')}-31`;
    conditions.push('invoice_date >= ? AND invoice_date <= ?');
    params.push(qStart, qEnd);
  }

  const year = getArg(args, '--year');
  if (year && !quarter) {
    conditions.push("strftime('%Y', invoice_date) = ?");
    params.push(year);
  }

  for (const [flag, col] of [
    ['--type', 'invoice_type'], ['--direction', 'direction'],
    ['--category', 'category'], ['--status', 'status'],
    ['--reimbursement', 'reimbursement_status']
  ]) {
    const val = getArg(args, flag);
    if (val) { conditions.push(`${col} = ?`); params.push(val); }
  }

  const vendor = getArg(args, '--vendor');
  if (vendor) { conditions.push('vendor_name LIKE ?'); params.push(`%${vendor}%`); }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}

const TYPE_LABELS = {
  rail_ticket: '高铁票', general_invoice: '普通发票', ride_hailing: '网约车',
  taxi_receipt: '出租车票', vat_special: '专用发票', other: '其他'
};
const DIR_LABELS = { inbound: '进项', outbound: '销项' };
const REIMB_LABELS = { unreimbursed: '未报销', submitted: '已提交', reimbursed: '已报销', rejected: '被驳回' };

function formatInvoiceLine(r) {
  const tl = TYPE_LABELS[r.invoice_type] || r.invoice_type;
  const dl = DIR_LABELS[r.direction] || r.direction;
  const rl = REIMB_LABELS[r.reimbursement_status] || r.reimbursement_status || '未报销';
  return `  #${r.id} | ${tl} | ${dl} | ¥${Number(r.amount).toFixed(2)} | ${r.invoice_date || 'N/A'} | ${r.vendor_name || '-'} | ${r.status} | ${rl}`;
}

function listInvoices(args) {
  const db = getDb();
  const { where, params } = buildWhereClause(args);
  const limit = getArg(args, '--limit') || '50';

  const rows = db.prepare(
    `SELECT * FROM invoices${where} ORDER BY invoice_date DESC, id DESC LIMIT ?`
  ).all(...params, parseInt(limit));
  db.close();

  if (rows.length === 0) { console.log('No invoices found.'); return; }

  console.log(`Invoices (${rows.length}):\n`);
  for (const r of rows) console.log(formatInvoiceLine(r));

  const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const totalTax = rows.reduce((s, r) => s + (r.tax_amount || 0), 0);
  console.log(`\nTotal: ${rows.length} invoices, ¥${totalAmount.toFixed(2)} (tax: ¥${totalTax.toFixed(2)})`);
}

function getInvoice(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(parseInt(id));
  db.close();
  if (!row) { console.log(`Invoice #${id} not found.`); return; }
  if (row.extra_fields) {
    try { row.extra_fields = JSON.parse(row.extra_fields); } catch {}
  }
  console.log(JSON.stringify(row, null, 2));
}

function updateInvoice(id, jsonStr) {
  const data = JSON.parse(jsonStr);
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
  if (sets.length === 0) { console.log('No fields to update.'); return; }

  sets.push("updated_at = datetime('now')");
  values.push(parseInt(id));

  const db = getDb();
  db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  db.close();
  console.log(`Invoice #${id} updated.`);
  getInvoice(id);
}

function deleteInvoice(id) {
  const db = getDb();
  const result = db.prepare('DELETE FROM invoices WHERE id = ?').run(parseInt(id));
  db.close();
  console.log(result.changes > 0 ? `Invoice #${id} deleted.` : `Invoice #${id} not found.`);
}

function reimburseInvoice(id) {
  const db = getDb();
  db.prepare(
    `UPDATE invoices SET reimbursement_status = 'reimbursed', reimbursed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(parseInt(id));
  db.close();
  console.log(`Invoice #${id} marked as reimbursed.`);
  getInvoice(id);
}

function unreimburseInvoice(id) {
  const db = getDb();
  db.prepare(
    `UPDATE invoices SET reimbursement_status = 'unreimbursed', reimbursed_at = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(parseInt(id));
  db.close();
  console.log(`Invoice #${id} reverted to unreimbursed.`);
}

function listUnreimbursed() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM invoices WHERE reimbursement_status = 'unreimbursed' ORDER BY invoice_date DESC, id DESC`
  ).all();
  db.close();

  if (rows.length === 0) { console.log('All invoices are reimbursed.'); return; }

  console.log(`Unreimbursed invoices (${rows.length}):\n`);
  for (const r of rows) console.log(formatInvoiceLine(r));

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  console.log(`\nTotal unreimbursed: ¥${total.toFixed(2)}`);
}

function showStats(args) {
  const db = getDb();
  const { where, params } = buildWhereClause(args);

  const byDir = db.prepare(
    `SELECT direction, COUNT(*) as count, COALESCE(SUM(amount),0) as total_amount,
            COALESCE(SUM(tax_amount),0) as total_tax
     FROM invoices${where} GROUP BY direction`
  ).all(...params);

  const byType = db.prepare(
    `SELECT invoice_type, direction, COUNT(*) as count, COALESCE(SUM(amount),0) as total
     FROM invoices${where} GROUP BY invoice_type, direction ORDER BY total DESC`
  ).all(...params);

  const byCategory = db.prepare(
    `SELECT category, direction, COUNT(*) as count, COALESCE(SUM(amount),0) as total
     FROM invoices${where} GROUP BY category, direction ORDER BY total DESC`
  ).all(...params);

  const byReimb = db.prepare(
    `SELECT reimbursement_status, COUNT(*) as count, COALESCE(SUM(amount),0) as total
     FROM invoices${where} GROUP BY reimbursement_status`
  ).all(...params);

  const byMonth = db.prepare(
    `SELECT strftime('%Y-%m', invoice_date) as month, direction,
            COUNT(*) as count, COALESCE(SUM(amount),0) as total
     FROM invoices${where} GROUP BY month, direction ORDER BY month DESC`
  ).all(...params);

  db.close();

  console.log('=== Invoice Statistics ===\n');

  console.log('By Direction:');
  let grandTotal = 0, grandTax = 0, grandCount = 0;
  for (const s of byDir) {
    console.log(`  ${DIR_LABELS[s.direction] || s.direction}: ${s.count} invoices, ¥${s.total_amount.toFixed(2)} (tax: ¥${s.total_tax.toFixed(2)})`);
    grandTotal += s.total_amount; grandTax += s.total_tax; grandCount += s.count;
  }
  console.log(`  Total: ${grandCount} invoices, ¥${grandTotal.toFixed(2)} (tax: ¥${grandTax.toFixed(2)})\n`);

  if (byType.length) {
    console.log('By Type:');
    for (const t of byType) console.log(`  ${TYPE_LABELS[t.invoice_type] || t.invoice_type} [${DIR_LABELS[t.direction] || t.direction}]: ${t.count}, ¥${t.total.toFixed(2)}`);
    console.log();
  }

  if (byCategory.length) {
    console.log('By Category:');
    for (const c of byCategory) console.log(`  ${c.category || 'uncategorized'} [${DIR_LABELS[c.direction] || c.direction}]: ${c.count}, ¥${c.total.toFixed(2)}`);
    console.log();
  }

  if (byReimb.length) {
    console.log('By Reimbursement:');
    for (const r of byReimb) console.log(`  ${REIMB_LABELS[r.reimbursement_status] || r.reimbursement_status}: ${r.count}, ¥${r.total.toFixed(2)}`);
    console.log();
  }

  if (byMonth.length) {
    console.log('By Month:');
    for (const m of byMonth) console.log(`  ${m.month} [${DIR_LABELS[m.direction] || m.direction}]: ${m.count}, ¥${m.total.toFixed(2)}`);
  }
}

function exportInvoices(args) {
  const format = getArg(args, '--format') || 'csv';
  const db = getDb();
  const { where, params } = buildWhereClause(args);

  const rows = db.prepare(
    `SELECT * FROM invoices${where} ORDER BY invoice_date DESC, id DESC`
  ).all(...params);
  db.close();

  if (rows.length === 0) { console.log('No invoices to export.'); return; }

  if (format === 'json') {
    for (const r of rows) {
      if (r.extra_fields) { try { r.extra_fields = JSON.parse(r.extra_fields); } catch {} }
    }
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const headers = ['id', 'invoice_number', 'invoice_code', 'invoice_type', 'direction',
      'vendor_name', 'buyer_name', 'amount', 'tax_amount', 'tax_rate', 'currency',
      'invoice_date', 'status', 'category', 'reimbursement_status', 'reimbursed_at', 'notes'];
    console.log(headers.join(','));
    for (const r of rows) {
      const vals = headers.map(h => {
        const v = r[h];
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
          ? `"${s.replace(/"/g, '""')}"` : s;
      });
      console.log(vals.join(','));
    }
  }
}

function packageMonth(monthStr) {
  if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
    console.log('Usage: invoice-manager package --month YYYY-MM');
    return;
  }

  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM invoices WHERE strftime('%Y-%m', invoice_date) = ? ORDER BY invoice_date, id`
  ).all(monthStr);
  db.close();

  if (rows.length === 0) { console.log(`No invoices for ${monthStr}.`); return; }

  mkdirSync(EXPORTS_DIR, { recursive: true });

  const tmpDir = join(EXPORTS_DIR, `${monthStr}-发票汇总`);
  const filesDir = join(tmpDir, 'invoices');
  mkdirSync(filesDir, { recursive: true });

  const csvHeaders = ['序号', '发票号码', '发票代码', '类型', '方向', '开票方', '购买方',
    '金额', '税额', '税率', '日期', '分类', '报销状态', '备注'];
  const csvLines = [csvHeaders.join(',')];

  let idx = 0;
  for (const r of rows) {
    idx++;
    const tl = TYPE_LABELS[r.invoice_type] || r.invoice_type;
    const dl = DIR_LABELS[r.direction] || r.direction;
    const rl = REIMB_LABELS[r.reimbursement_status] || r.reimbursement_status || '';

    const vals = [idx, r.invoice_number || '', r.invoice_code || '', tl, dl,
      r.vendor_name || '', r.buyer_name || '', r.amount, r.tax_amount || 0,
      r.tax_rate || '', r.invoice_date || '', r.category || '', rl, r.notes || ''];
    csvLines.push(vals.map(v => {
      const s = String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));

    if (r.file_path && existsSync(r.file_path)) {
      const ext = extname(r.file_path);
      const prefix = String(idx).padStart(3, '0');
      const typeName = TYPE_LABELS[r.invoice_type] || r.invoice_type;
      const destName = `${prefix}-${typeName}-${r.invoice_number || r.id}${ext}`;
      copyFileSync(r.file_path, join(filesDir, destName));
    }
  }

  const csvPath = join(tmpDir, `${monthStr}-summary.csv`);
  writeFileSync(csvPath, '\uFEFF' + csvLines.join('\n'), 'utf-8');

  const zipPath = join(EXPORTS_DIR, `${monthStr}-发票汇总.zip`);
  try {
    execSync(`cd "${EXPORTS_DIR}" && zip -r "${zipPath}" "${monthStr}-发票汇总/"`, { stdio: 'pipe' });
  } catch {
    execSync(`cd "${EXPORTS_DIR}" && tar czf "${monthStr}-发票汇总.tar.gz" "${monthStr}-发票汇总/"`, { stdio: 'pipe' });
    const tgzPath = join(EXPORTS_DIR, `${monthStr}-发票汇总.tar.gz`);
    console.log(`Package created: ${tgzPath}`);
    console.log(`Contains: ${rows.length} invoices, summary CSV, ${idx} files`);
    cleanup(tmpDir);
    return;
  }

  console.log(`Package created: ${zipPath}`);
  console.log(`Contains: ${rows.length} invoices, summary CSV`);
  cleanup(tmpDir);
}

function cleanup(dir) {
  try { execSync(`rm -rf "${dir}"`, { stdio: 'pipe' }); } catch {}
}

function searchInvoices(keyword) {
  if (!keyword) { console.log('Usage: invoice-manager search <keyword>'); return; }
  const db = getDb();
  const p = `%${keyword}%`;
  const rows = db.prepare(
    `SELECT * FROM invoices
     WHERE vendor_name LIKE ? OR buyer_name LIKE ? OR invoice_number LIKE ?
        OR notes LIKE ? OR extra_fields LIKE ?
     ORDER BY invoice_date DESC LIMIT 50`
  ).all(p, p, p, p, p);
  db.close();

  if (rows.length === 0) { console.log(`No invoices matching "${keyword}".`); return; }

  console.log(`Search results for "${keyword}" (${rows.length}):\n`);
  for (const r of rows) console.log(formatInvoiceLine(r));
}

function listCategories() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT category, COUNT(*) as count, SUM(amount) as total FROM invoices GROUP BY category ORDER BY total DESC`
  ).all();
  db.close();

  if (rows.length === 0) { console.log('No categories found.'); return; }
  console.log('Categories:\n');
  for (const r of rows) console.log(`  ${r.category || 'uncategorized'}: ${r.count} invoices, ¥${r.total.toFixed(2)}`);
}

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

function showHelp() {
  console.log(`InvoiceClaw CLI (发票管理)

Commands:
  init                              Initialize database
  add --json '{...}' [--file path]  Add invoice (optionally copy source file)
  list [filters]                    List invoices
  get <id>                          Get invoice detail
  update <id> --json '{...}'        Update invoice fields
  delete <id>                       Delete invoice
  reimburse <id>                    Mark as reimbursed
  unreimburse <id>                  Revert to unreimbursed
  unreimbursed                      List all unreimbursed invoices
  stats [filters]                   Statistics summary
  export [--format csv|json]        Export invoices
  package --month YYYY-MM           Package month's invoices into zip
  search <keyword>                  Search invoices
  categories                        List all categories

Filters:
  --month YYYY-MM      --quarter N          --year YYYY
  --type <type>        --direction <dir>    --category <cat>
  --status <s>         --reimbursement <r>  --vendor <name>
  --limit N

Types: rail_ticket|general_invoice|ride_hailing|taxi_receipt|vat_special|other
Directions: inbound|outbound
Reimbursement: unreimbursed|submitted|reimbursed|rejected
`);
}

const [,, cmd, ...args] = process.argv;

try {
  switch (cmd) {
    case 'init': initDb(); break;
    case 'add': {
      const json = getArg(args, '--json');
      const file = getArg(args, '--file');
      if (!json) { console.log("Usage: add --json '{...}' [--file path]"); process.exit(1); }
      addInvoice(json, file);
      break;
    }
    case 'list': case 'ls': listInvoices(args); break;
    case 'get': {
      if (!args[0]) { console.log('Usage: get <id>'); process.exit(1); }
      getInvoice(args[0]); break;
    }
    case 'update': {
      const id = args[0], json = getArg(args, '--json');
      if (!id || !json) { console.log("Usage: update <id> --json '{...}'"); process.exit(1); }
      updateInvoice(id, json); break;
    }
    case 'delete': case 'rm': {
      if (!args[0]) { console.log('Usage: delete <id>'); process.exit(1); }
      deleteInvoice(args[0]); break;
    }
    case 'reimburse': {
      if (!args[0]) { console.log('Usage: reimburse <id>'); process.exit(1); }
      reimburseInvoice(args[0]); break;
    }
    case 'unreimburse': {
      if (!args[0]) { console.log('Usage: unreimburse <id>'); process.exit(1); }
      unreimburseInvoice(args[0]); break;
    }
    case 'unreimbursed': listUnreimbursed(); break;
    case 'stats': showStats(args); break;
    case 'export': exportInvoices(args); break;
    case 'package': {
      const m = getArg(args, '--month');
      packageMonth(m); break;
    }
    case 'search': case 's': searchInvoices(args.join(' ')); break;
    case 'categories': case 'cats': listCategories(); break;
    default: showHelp();
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
