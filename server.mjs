/**
 * InvoiceClaw Web Service
 * Express API + static frontend + email poller
 */

import express from 'express';
import multer from 'multer';
import { join, extname } from 'node:path';
import { existsSync, mkdirSync, unlinkSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  initDb, listInvoices, getInvoice, createInvoice, updateInvoice, deleteInvoice,
  getStats, getDb, batchUpdateReimbursement
} from './lib/db.mjs';
import {
  startPoller, getPollerStatus, loadEmailConfig, saveEmailConfig, testEmailConnection, pollOnce
} from './lib/email-poller.mjs';
import { packageInvoices, listExports } from './lib/packager.mjs';
import pdf from 'pdf-parse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.INVOICECLAW_DATA || '/data';
const INVOICES_DIR = join(DATA_DIR, 'invoices');
const EXPORTS_DIR = join(DATA_DIR, 'exports');
const PORT = parseInt(process.env.PORT) || 3000;

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception (kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection (kept alive):', reason);
});

initDb();

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const now = new Date();
      const dir = join(INVOICES_DIR, now.getFullYear().toString(),
        String(now.getMonth() + 1).padStart(2, '0'));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = extname(file.originalname);
      cb(null, `${Date.now()}-${file.originalname}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.bmp'];
    const ext = extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// --- Invoice CRUD ---

app.get('/api/invoices', (req, res) => {
  try {
    const result = listInvoices(req.query);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/buyers', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT DISTINCT buyer_name FROM invoices WHERE buyer_name IS NOT NULL AND buyer_name != '' ORDER BY buyer_name`
    ).all();
    res.json(rows.map(r => r.buyer_name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invoices/batch-reimburse', (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    const validStatuses = ['unreimbursed', 'submitted', 'reimbursed', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }
    const intIds = ids.map(id => parseInt(id)).filter(id => Number.isFinite(id));
    const changed = batchUpdateReimbursement(intIds, status);
    res.json({ changed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/pending', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, invoice_type, source, file_path, vendor_name, notes, created_at
       FROM invoices
       WHERE (amount = 0 OR amount IS NULL) AND status = 'pending'
       ORDER BY created_at DESC LIMIT 50`
    ).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/:id', (req, res) => {
  const inv = getInvoice(parseInt(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

app.post('/api/invoices', upload.single('file'), (req, res) => {
  try {
    const data = req.body;
    if (typeof data.extra_fields === 'string') {
      try { data.extra_fields = JSON.parse(data.extra_fields); } catch {}
    }
    if (typeof data.amount === 'string') data.amount = parseFloat(data.amount);
    if (typeof data.tax_amount === 'string') data.tax_amount = parseFloat(data.tax_amount);
    if (typeof data.tax_rate === 'string') data.tax_rate = parseFloat(data.tax_rate);

    if (req.file) data.file_path = req.file.path;
    if (!data.source) data.source = 'web';

    const inv = createInvoice(data);
    res.status(201).json(inv);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/invoices/:id', (req, res) => {
  try {
    const data = req.body;
    if (typeof data.amount === 'string') data.amount = parseFloat(data.amount);
    if (typeof data.tax_amount === 'string') data.tax_amount = parseFloat(data.tax_amount);
    if (typeof data.tax_rate === 'string') data.tax_rate = parseFloat(data.tax_rate);

    const inv = updateInvoice(parseInt(req.params.id), data);
    if (!inv) return res.status(404).json({ error: 'Not found or no changes' });
    res.json(inv);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/invoices/:id', (req, res) => {
  const inv = getInvoice(parseInt(req.params.id));
  if (inv && inv.file_path) {
    const resolved = resolveFilePath(inv.file_path);
    if (resolved) { try { unlinkSync(resolved); } catch {} }
  }
  const ok = deleteInvoice(parseInt(req.params.id));
  res.json({ deleted: ok });
});

// --- File attachment (for existing invoices) ---

app.post('/api/invoices/:id/attach', upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id);
  const inv = getInvoice(id);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  if (inv.file_path) {
    const old = resolveFilePath(inv.file_path);
    if (old) { try { unlinkSync(old); } catch {} }
  }

  const updated = updateInvoice(id, { file_path: req.file.path });
  res.json(updated);
});

// --- Reimbursement ---

app.post('/api/invoices/:id/reimburse', (req, res) => {
  const inv = updateInvoice(parseInt(req.params.id), {
    reimbursement_status: 'reimbursed',
    reimbursed_at: new Date().toISOString()
  });
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

app.post('/api/invoices/:id/unreimburse', (req, res) => {
  const inv = updateInvoice(parseInt(req.params.id), {
    reimbursement_status: 'unreimbursed',
    reimbursed_at: null
  });
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

// --- File serving ---

function resolveFilePath(dbPath) {
  if (!dbPath) return null;
  if (existsSync(dbPath)) return dbPath;
  const knownPrefixes = [
    '/home/node/.openclaw/workspace/finance',
    '/home/node/.openclaw/workspace/finance/',
  ];
  for (const prefix of knownPrefixes) {
    if (dbPath.startsWith(prefix)) {
      const relative = dbPath.slice(prefix.length).replace(/^\//, '');
      const resolved = join(DATA_DIR, relative);
      if (existsSync(resolved)) return resolved;
    }
  }
  const basename = dbPath.split('/').pop();
  return null;
}

app.get('/api/invoices/:id/file', (req, res) => {
  const inv = getInvoice(parseInt(req.params.id));
  if (!inv || !inv.file_path) return res.status(404).json({ error: 'No file' });
  const resolved = resolveFilePath(inv.file_path);
  if (!resolved) return res.status(404).json({ error: 'File missing' });
  const origName = inv.file_path.split('/').pop().replace(/^\d+-/, '');
  const ext = extname(origName).toLowerCase();
  const displayName = origName || `invoice-${inv.id}${ext || '.pdf'}`;
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  res.sendFile(resolved);
});

app.get('/api/invoices/:id/text', async (req, res) => {
  try {
    const inv = getInvoice(parseInt(req.params.id));
    if (!inv || !inv.file_path) return res.status(404).json({ error: 'No file' });
    const resolved = resolveFilePath(inv.file_path);
    if (!resolved) return res.status(404).json({ error: 'File missing' });

    const ext = extname(resolved).toLowerCase();
    if (ext === '.pdf') {
      const buffer = readFileSync(resolved);
      const data = await pdf(buffer);
      res.json({
        id: inv.id,
        pages: data.numpages,
        text: data.text,
        metadata: data.info || {},
        source_file: inv.file_path.split('/').pop().replace(/^\d+-/, ''),
      });
    } else {
      res.json({
        id: inv.id,
        type: 'image',
        message: 'This is an image file. Use vision model to analyze it.',
        source_file: inv.file_path.split('/').pop().replace(/^\d+-/, ''),
        file_url: `/api/invoices/${inv.id}/file`,
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Stats ---

app.get('/api/stats', (req, res) => {
  try {
    res.json(getStats(req.query));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Export ---

app.get('/api/export', (req, res) => {
  try {
    const result = listInvoices({ ...req.query, limit: '10000' });
    const format = req.query.format || 'json';

    if (format === 'json') {
      res.json(result.invoices);
    } else {
      const headers = ['id', 'invoice_number', 'invoice_code', 'invoice_type', 'direction',
        'vendor_name', 'buyer_name', 'amount', 'tax_amount', 'tax_rate', 'currency',
        'invoice_date', 'status', 'category', 'reimbursement_status', 'reimbursed_at', 'notes'];
      const lines = [headers.join(',')];
      for (const r of result.invoices) {
        lines.push(headers.map(h => {
          const v = r[h];
          if (v == null) return '';
          const s = String(v);
          return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=invoices.csv');
      res.send('\uFEFF' + lines.join('\n'));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Package ---

app.post('/api/package', async (req, res) => {
  try {
    const result = await packageInvoices(req.body);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/exports', (req, res) => {
  try {
    res.json(listExports());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/exports/:filename', (req, res) => {
  const filePath = join(EXPORTS_DIR, req.params.filename);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  if (!req.params.filename.endsWith('.zip')) return res.status(400).json({ error: 'Invalid file' });
  res.download(filePath);
});

// --- Settings ---
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

function loadSettings() {
  try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')); }
  catch { return { language: 'zh', invoiceStorePath: '' }; }
}

function saveSettings(s) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
  try {
    const current = loadSettings();
    const updated = { ...current, ...req.body };
    saveSettings(updated);
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Email config ---

app.get('/api/email/config', (req, res) => {
  const config = loadEmailConfig();
  if (!config) return res.json({ configured: false });
  res.json({
    configured: true,
    host: config.host,
    port: config.port,
    user: config.user,
    pass: '••••••••',
    secure: config.secure,
    folder: config.folder,
    pollInterval: config.pollInterval,
    enabled: config.enabled,
    markRead: config.markRead
  });
});

app.post('/api/email/config', (req, res) => {
  try {
    const existing = loadEmailConfig();
    const config = {
      host: req.body.host,
      port: req.body.port || 993,
      user: req.body.user,
      pass: req.body.pass === '••••••••' ? existing?.pass : req.body.pass,
      secure: req.body.secure !== false,
      folder: req.body.folder || 'INBOX',
      pollInterval: req.body.pollInterval || 15,
      enabled: req.body.enabled !== false,
      markRead: req.body.markRead !== false
    };
    saveEmailConfig(config);
    res.json({ saved: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/email/test', async (req, res) => {
  try {
    const config = req.body.host ? req.body : loadEmailConfig();
    if (!config) return res.status(400).json({ error: 'No email config' });
    const result = await testEmailConnection(config);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/email/status', (req, res) => {
  res.json(getPollerStatus());
});

app.post('/api/email/poll', async (req, res) => {
  try {
    const config = loadEmailConfig();
    if (!config || !config.host) return res.status(400).json({ error: 'Email not configured' });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Poll timed out (30s)')), 30000));
    await Promise.race([pollOnce(), timeout]);
    res.json({ success: true, status: getPollerStatus() });
  } catch (e) {
    const status = getPollerStatus();
    if (e.message.includes('timed out')) {
      res.json({ success: false, timedOut: true, error: e.message, status });
    } else {
      res.status(500).json({ error: e.message, status });
    }
  }
});

// --- GitHub config ---
const GITHUB_CONFIG_PATH = join(DATA_DIR, 'github-config.json');
const GITHUB_REPO = 'peterpanstechland/invoiceclaw';
const GITHUB_LABEL_MAP = {
  feature: 'feature request',
  feature_request: 'feature request',
  bug: 'bug',
  improvement: 'enhancement',
  other: 'feedback',
};

function loadGithubConfig() {
  if (!existsSync(GITHUB_CONFIG_PATH)) return null;
  try { return JSON.parse(readFileSync(GITHUB_CONFIG_PATH, 'utf-8')); }
  catch { return null; }
}

function saveGithubConfig(config) {
  writeFileSync(GITHUB_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

app.get('/api/github/config', (req, res) => {
  const config = loadGithubConfig();
  if (!config) return res.json({ configured: false });
  res.json({
    configured: true,
    token: config.token ? '••••••••' + config.token.slice(-4) : '',
    repo: config.repo || GITHUB_REPO,
    enabled: config.enabled !== false,
  });
});

app.post('/api/github/config', (req, res) => {
  try {
    const existing = loadGithubConfig();
    const config = {
      token: (req.body.token && !req.body.token.startsWith('••••')) ? req.body.token : existing?.token,
      repo: req.body.repo || existing?.repo || GITHUB_REPO,
      enabled: req.body.enabled !== false,
    };
    saveGithubConfig(config);
    res.json({ saved: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

async function createGithubIssue(category, message) {
  const config = loadGithubConfig();
  if (!config?.token || !config.enabled) return null;

  const repo = config.repo || GITHUB_REPO;
  const label = GITHUB_LABEL_MAP[category] || 'feedback';
  const title = message.trim().split('\n')[0].substring(0, 100);
  const body = `**Category:** ${label}\n**Submitted from:** InvoiceClaw Web UI\n**Time:** ${new Date().toISOString()}\n\n---\n\n${message.trim()}`;

  const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels: [label] }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API ${resp.status}`);
  }

  const issue = await resp.json();
  return { number: issue.number, url: issue.html_url };
}

// --- Feedback ---
const FEEDBACK_PATH = join(DATA_DIR, 'feedback.md');

app.get('/api/feedback', (req, res) => {
  try {
    if (!existsSync(FEEDBACK_PATH)) return res.json({ content: '' });
    const content = readFileSync(FEEDBACK_PATH, 'utf-8');
    res.json({ content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/feedback', async (req, res) => {
  try {
    const { category, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
    const cat = category || 'general';
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);

    let ghIssue = null;
    try {
      ghIssue = await createGithubIssue(cat, message);
    } catch (e) {
      console.error('[feedback] GitHub issue creation failed:', e.message);
    }

    const ghNote = ghIssue ? ` → GitHub Issue #${ghIssue.number}` : '';
    const entry = `\n## ${ts} | ${cat}${ghNote}\n\n${message.trim()}\n\n---\n`;
    appendFileSync(FEEDBACK_PATH, entry);
    res.json({ saved: true, github: ghIssue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SPA fallback ---

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`InvoiceClaw running on http://0.0.0.0:${PORT}`);
  startPoller();
});
