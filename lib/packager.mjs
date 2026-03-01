/**
 * Invoice packager — creates zip archive with invoices + summary CSV,
 * organized by direction and buyer.
 */

import archiver from 'archiver';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { getDb } from './db.mjs';

const DATA_DIR = process.env.INVOICECLAW_DATA || '/data';
const EXPORTS_DIR = join(DATA_DIR, 'exports');
const OPENCLAW_PREFIX = '/home/node/.openclaw/workspace/finance';

const TYPE_LABELS = {
  rail_ticket: '高铁票', general_invoice: '普通发票', ride_hailing: '网约车',
  taxi_receipt: '出租车票', vat_special: '专用发票', other: '其他'
};
const DIR_LABELS = { inbound: '进项', outbound: '销项' };
const REIMB_LABELS = { unreimbursed: '未报销', submitted: '已提交', reimbursed: '已报销', rejected: '被驳回' };

function sanitizeName(name) {
  if (!name) return '未知';
  return name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '未知';
}

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

export async function packageInvoices(filters = {}) {
  const { startDate, endDate, buyer, direction } = filters;

  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const conditions = ['invoice_date BETWEEN ? AND ?'];
  const params = [startDate, endDate];

  if (buyer) {
    conditions.push('buyer_name = ?');
    params.push(buyer);
  }
  if (direction) {
    conditions.push('direction = ?');
    params.push(direction);
  }

  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM invoices WHERE ${conditions.join(' AND ')} ORDER BY invoice_date, id`
  ).all(...params);

  if (rows.length === 0) {
    throw new Error('No invoices found for the given filters');
  }

  mkdirSync(EXPORTS_DIR, { recursive: true });

  const folderName = `${startDate}~${endDate}-发票导出`;
  const zipFilename = `${folderName}.zip`;
  const zipPath = join(EXPORTS_DIR, zipFilename);

  const csvHeaders = ['序号', '发票号码', '发票代码', '类型', '方向', '开票方', '购买方',
    '金额', '税额', '税率', '日期', '分类', '报销状态', '备注'];
  const csvLines = [csvHeaders.join(',')];

  const fileEntries = [];
  let idx = 0;

  for (const r of rows) {
    idx++;
    const typeLabel = TYPE_LABELS[r.invoice_type] || r.invoice_type;
    const dirLabel = DIR_LABELS[r.direction] || r.direction;
    const reimbLabel = REIMB_LABELS[r.reimbursement_status] || '';

    const vals = [idx, r.invoice_number || '', r.invoice_code || '', typeLabel, dirLabel,
      r.vendor_name || '', r.buyer_name || '', r.amount, r.tax_amount || 0,
      r.tax_rate || '', r.invoice_date || '', r.category || '', reimbLabel, r.notes || ''];
    csvLines.push(vals.map(v => {
      const s = String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));

    const resolvedPath = resolveFilePath(r.file_path);
    if (resolvedPath) {
      const ext = extname(resolvedPath);
      const prefix = String(idx).padStart(3, '0');
      const safeDirLabel = sanitizeName(dirLabel);
      const safeBuyer = sanitizeName(r.buyer_name);
      fileEntries.push({
        source: resolvedPath,
        name: `${folderName}/${safeDirLabel}/${safeBuyer}/${prefix}-${typeLabel}-${r.invoice_number || r.id}${ext}`
      });
    }
  }

  const csvContent = '\uFEFF' + csvLines.join('\n');

  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve({
      path: zipPath,
      filename: zipFilename,
      count: rows.length,
      fileCount: fileEntries.length,
      size: archive.pointer()
    }));

    archive.on('error', reject);
    archive.pipe(output);

    archive.append(csvContent, { name: `${folderName}/summary.csv` });

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
