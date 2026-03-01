/**
 * Monthly invoice packager — creates zip archive with invoices + summary CSV.
 */

import archiver from 'archiver';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const OPENCLAW_PREFIX = '/home/node/.openclaw/workspace/finance';

function resolveFilePath(dbPath) {
  if (!dbPath) return null;
  if (existsSync(dbPath)) return dbPath;
  if (dbPath.startsWith(OPENCLAW_PREFIX)) {
    const relative = dbPath.slice(OPENCLAW_PREFIX.length).replace(/^\//, '');
    const resolved = join(DATA_DIR, relative);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}
import { getDb, buildWhereClause } from './db.mjs';

const DATA_DIR = process.env.INVOICECLAW_DATA || '/data';
const EXPORTS_DIR = join(DATA_DIR, 'exports');

const TYPE_LABELS = {
  rail_ticket: '高铁票', general_invoice: '普通发票', ride_hailing: '网约车',
  taxi_receipt: '出租车票', vat_special: '专用发票', other: '其他'
};
const DIR_LABELS = { inbound: '进项', outbound: '销项' };
const REIMB_LABELS = { unreimbursed: '未报销', submitted: '已提交', reimbursed: '已报销', rejected: '被驳回' };

export async function packageMonth(monthStr) {
  if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
    throw new Error('Invalid month format, expected YYYY-MM');
  }

  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM invoices WHERE strftime('%Y-%m', invoice_date) = ? ORDER BY invoice_date, id`
  ).all(monthStr);

  if (rows.length === 0) throw new Error(`No invoices for ${monthStr}`);

  mkdirSync(EXPORTS_DIR, { recursive: true });
  const zipPath = join(EXPORTS_DIR, `${monthStr}-发票汇总.zip`);
  const folderName = `${monthStr}-发票汇总`;

  const csvHeaders = ['序号', '发票号码', '发票代码', '类型', '方向', '开票方', '购买方',
    '金额', '税额', '税率', '日期', '分类', '报销状态', '备注'];
  const csvLines = [csvHeaders.join(',')];

  const fileEntries = [];
  let idx = 0;
  for (const r of rows) {
    idx++;
    const tl = TYPE_LABELS[r.invoice_type] || r.invoice_type;
    const dl = DIR_LABELS[r.direction] || r.direction;
    const rl = REIMB_LABELS[r.reimbursement_status] || '';

    const vals = [idx, r.invoice_number || '', r.invoice_code || '', tl, dl,
      r.vendor_name || '', r.buyer_name || '', r.amount, r.tax_amount || 0,
      r.tax_rate || '', r.invoice_date || '', r.category || '', rl, r.notes || ''];
    csvLines.push(vals.map(v => {
      const s = String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));

    const resolvedPath = resolveFilePath(r.file_path);
    if (resolvedPath) {
      const ext = extname(resolvedPath);
      const prefix = String(idx).padStart(3, '0');
      fileEntries.push({
        source: resolvedPath,
        name: `${folderName}/invoices/${prefix}-${tl}-${r.invoice_number || r.id}${ext}`
      });
    }
  }

  const csvContent = '\uFEFF' + csvLines.join('\n');

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve({
      path: zipPath,
      filename: `${monthStr}-发票汇总.zip`,
      count: rows.length,
      fileCount: fileEntries.length,
      size: archive.pointer()
    }));

    archive.on('error', reject);
    archive.pipe(output);

    archive.append(csvContent, { name: `${folderName}/${monthStr}-summary.csv` });

    for (const entry of fileEntries) {
      archive.file(entry.source, { name: entry.name });
    }

    archive.finalize();
  });
}

export function listExports() {
  mkdirSync(EXPORTS_DIR, { recursive: true });
  const files = readdirSync(EXPORTS_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const st = statSync(join(EXPORTS_DIR, f));
      return { filename: f, size: st.size, created: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
  return files;
}
