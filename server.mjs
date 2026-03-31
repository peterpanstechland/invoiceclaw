/**
 * InvoiceClaw Web Service — Multi-User
 * Express API + static frontend + email poller + auth
 */

import express from 'express';
import multer from 'multer';
import { join, extname } from 'node:path';
import { existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  initDb, listInvoices, getInvoice, createInvoice, updateInvoice, deleteInvoice,
  getStats, getDb, batchUpdateReimbursement,
  listFeedback, createFeedback, resolveFeedback, reopenFeedback, feedbackCount,
  getUserCount, hasWebUsers, createUser, getUser, getUserByUsername, listUsers, updateUser, deleteUser,
  verifyPassword, createSession, getSessionUser, deleteSession,
  listRoutingRules, createRoutingRule, deleteRoutingRule
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
const COOKIE_NAME = 'invoiceclaw_session';
const COOKIE_SECRET = process.env.INVOICECLAW_SESSION_SECRET || randomBytes(32).toString('hex');

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

// ---------------------------------------------------------------------------
// Auth middleware — cookie-based sessions stored in SQLite
// ---------------------------------------------------------------------------

function extractSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  return match ? match.split('=')[1] : null;
}

function authMiddleware(req, res, next) {
  const token = extractSessionToken(req);
  const user = getSessionUser(token);
  req.user = user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

app.use(authMiddleware);

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password too short (min 4)' });

    const webUsersExist = hasWebUsers();
    if (webUsersExist && (!req.user || req.user.role !== 'admin')) {
      return res.status(403).json({ error: 'Registration closed. Ask an admin to create your account.' });
    }

    const role = webUsersExist ? undefined : 'admin';
    const user = createUser({ username, password, displayName, role });
    const token = createSession(user.id);
    setSessionCookie(res, token);
    res.status(201).json({ user, firstUser: !webUsersExist });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    const user = getUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createSession(user.id);
    setSessionCookie(res, token);
    res.json({
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractSessionToken(req);
  if (token) deleteSession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.json({ authenticated: false, needsSetup: !hasWebUsers() });
  res.json({
    authenticated: true,
    user: {
      id: req.user.id, username: req.user.username, display_name: req.user.display_name,
      role: req.user.role, feishu_open_id: req.user.feishu_open_id || '', email: req.user.email || ''
    }
  });
});

app.put('/api/auth/profile', requireAuth, (req, res) => {
  try {
    const { display_name, feishu_open_id, email } = req.body;
    const data = {};
    if (display_name !== undefined) data.display_name = display_name;
    if (feishu_open_id !== undefined) data.feishu_open_id = feishu_open_id || null;
    if (email !== undefined) data.email = email || null;
    const user = updateUser(req.user.id, data);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, display_name: user.display_name,
      role: user.role, feishu_open_id: user.feishu_open_id || '', email: user.email || '' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'This Feishu ID is already bound to another account' });
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// User management (admin only)
// ---------------------------------------------------------------------------

app.get('/api/users', requireAdmin, (req, res) => {
  try { res.json(listUsers()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireAdmin, (req, res) => {
  try {
    const { username, password, displayName, email, role } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const user = createUser({ username, password, displayName, email, role });
    res.status(201).json(user);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  try {
    const user = updateUser(parseInt(req.params.id), req.body);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(user);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const ok = deleteUser(parseInt(req.params.id));
  res.json({ deleted: ok });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUserId(req) {
  if (!req.user) return null;
  if (req.query.all === 'true' && req.user.role === 'admin') return undefined;
  return req.user.id;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const now = new Date();
      const userId = req.user?.id;
      const base = userId ? join(INVOICES_DIR, String(userId)) : INVOICES_DIR;
      const dir = join(base, now.getFullYear().toString(),
        String(now.getMonth() + 1).padStart(2, '0'));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
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
  return null;
}

// ---------------------------------------------------------------------------
// Invoice CRUD (auth required, user-scoped)
// ---------------------------------------------------------------------------

app.get('/api/invoices', requireAuth, (req, res) => {
  try {
    const userId = getUserId(req);
    const result = listInvoices(req.query, userId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/buyers', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const userId = getUserId(req);
    const condition = userId != null ? 'AND user_id = ?' : '';
    const params = userId != null ? [userId] : [];
    const rows = db.prepare(
      `SELECT DISTINCT buyer_name FROM invoices WHERE buyer_name IS NOT NULL AND buyer_name != '' ${condition} ORDER BY buyer_name`
    ).all(...params);
    res.json(rows.map(r => r.buyer_name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invoices/batch-reimburse', requireAuth, (req, res) => {
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
    const userId = getUserId(req);
    const changed = batchUpdateReimbursement(intIds, status, userId);
    res.json({ changed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/pending', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const userId = getUserId(req);
    const conditions = ['(amount = 0 OR amount IS NULL)', "status = 'pending'"];
    const params = [];
    if (userId != null) { conditions.push('user_id = ?'); params.push(userId); }
    const rows = db.prepare(
      `SELECT id, invoice_type, source, file_path, vendor_name, notes, created_at
       FROM invoices WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT 50`
    ).all(...params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/invoices/:id', requireAuth, (req, res) => {
  const userId = getUserId(req);
  const inv = getInvoice(parseInt(req.params.id), userId);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

app.post('/api/invoices', requireAuth, upload.single('file'), (req, res) => {
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

    const inv = createInvoice(data, req.user.id);
    res.status(201).json(inv);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/invoices/:id', requireAuth, (req, res) => {
  try {
    const data = req.body;
    if (typeof data.amount === 'string') data.amount = parseFloat(data.amount);
    if (typeof data.tax_amount === 'string') data.tax_amount = parseFloat(data.tax_amount);
    if (typeof data.tax_rate === 'string') data.tax_rate = parseFloat(data.tax_rate);

    const userId = getUserId(req);
    const inv = updateInvoice(parseInt(req.params.id), data, userId);
    if (!inv) return res.status(404).json({ error: 'Not found or no changes' });
    res.json(inv);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/invoices/:id', requireAuth, (req, res) => {
  const userId = getUserId(req);
  const inv = getInvoice(parseInt(req.params.id), userId);
  if (inv && inv.file_path) {
    const resolved = resolveFilePath(inv.file_path);
    if (resolved) { try { unlinkSync(resolved); } catch {} }
  }
  const ok = deleteInvoice(parseInt(req.params.id), userId);
  res.json({ deleted: ok });
});

// --- File attachment ---

app.post('/api/invoices/:id/attach', requireAuth, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id);
  const userId = getUserId(req);
  const inv = getInvoice(id, userId);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  if (inv.file_path) {
    const old = resolveFilePath(inv.file_path);
    if (old) { try { unlinkSync(old); } catch {} }
  }

  const updated = updateInvoice(id, { file_path: req.file.path }, userId);
  res.json(updated);
});

// --- Reimbursement ---

app.post('/api/invoices/:id/reimburse', requireAuth, (req, res) => {
  const userId = getUserId(req);
  const inv = updateInvoice(parseInt(req.params.id), {
    reimbursement_status: 'reimbursed',
    reimbursed_at: new Date().toISOString()
  }, userId);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

app.post('/api/invoices/:id/unreimburse', requireAuth, (req, res) => {
  const userId = getUserId(req);
  const inv = updateInvoice(parseInt(req.params.id), {
    reimbursement_status: 'unreimbursed',
    reimbursed_at: null
  }, userId);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

// --- File serving ---

app.get('/api/invoices/:id/file', requireAuth, (req, res) => {
  const userId = getUserId(req);
  const inv = getInvoice(parseInt(req.params.id), userId);
  if (!inv || !inv.file_path) return res.status(404).json({ error: 'No file' });
  const resolved = resolveFilePath(inv.file_path);
  if (!resolved) return res.status(404).json({ error: 'File missing' });
  const origName = inv.file_path.split('/').pop().replace(/^\d+-/, '');
  const ext = extname(origName).toLowerCase();
  const displayName = origName || `invoice-${inv.id}${ext || '.pdf'}`;
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  res.sendFile(resolved);
});

app.get('/api/invoices/:id/text', requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const inv = getInvoice(parseInt(req.params.id), userId);
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

app.get('/api/stats', requireAuth, (req, res) => {
  try {
    const userId = getUserId(req);
    res.json(getStats(req.query, userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Export ---

app.get('/api/export', requireAuth, (req, res) => {
  try {
    const userId = getUserId(req);
    const result = listInvoices({ ...req.query, limit: '10000' }, userId);
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

app.post('/api/package', requireAuth, async (req, res) => {
  try {
    const result = await packageInvoices(req.body);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/exports', requireAuth, (req, res) => {
  try { res.json(listExports()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/exports/:filename', requireAuth, (req, res) => {
  const filePath = join(EXPORTS_DIR, req.params.filename);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  if (!req.params.filename.endsWith('.zip')) return res.status(400).json({ error: 'Invalid file' });
  res.download(filePath);
});

// --- Settings (per-user) ---
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

function loadSettings(userId) {
  const path = userId ? join(DATA_DIR, `settings-${userId}.json`) : SETTINGS_PATH;
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch {
    try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')); }
    catch { return { language: 'zh', invoiceStorePath: '' }; }
  }
}

function saveSettings(settings, userId) {
  const path = userId ? join(DATA_DIR, `settings-${userId}.json`) : SETTINGS_PATH;
  writeFileSync(path, JSON.stringify(settings, null, 2));
}

app.get('/api/settings', requireAuth, (req, res) => {
  res.json(loadSettings(req.user.id));
});

app.post('/api/settings', requireAuth, (req, res) => {
  try {
    const current = loadSettings(req.user.id);
    const updated = { ...current, ...req.body };
    saveSettings(updated, req.user.id);
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Email config ---

app.get('/api/email/config', requireAuth, (req, res) => {
  const config = loadEmailConfig();
  if (!config) return res.json({ configured: false });
  res.json({
    configured: true,
    host: config.host,
    port: config.port,
    user: config.user,
    pass: config.pass ? String.fromCodePoint(0x2022).repeat(8) : '',
    secure: config.secure,
    folder: config.folder,
    pollInterval: config.pollInterval,
    enabled: config.enabled,
    markRead: config.markRead
  });
});

app.post('/api/email/config', requireAdmin, (req, res) => {
  try {
    const existing = loadEmailConfig();
    const masked = String.fromCodePoint(0x2022).repeat(8);
    const config = {
      host: req.body.host,
      port: req.body.port || 993,
      user: req.body.user,
      pass: req.body.pass === masked ? existing?.pass : req.body.pass,
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

app.post('/api/email/test', requireAdmin, async (req, res) => {
  try {
    const config = req.body.host ? req.body : loadEmailConfig();
    if (!config) return res.status(400).json({ error: 'No email config' });
    const result = await testEmailConnection(config);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/email/status', requireAuth, (req, res) => {
  res.json(getPollerStatus());
});

app.post('/api/email/poll', requireAdmin, async (req, res) => {
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

// --- Email routing rules ---

app.get('/api/email/routing-rules', requireAdmin, (req, res) => {
  try { res.json(listRoutingRules()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/email/routing-rules', requireAdmin, (req, res) => {
  try {
    const { userId, matchType, matchPattern, priority } = req.body;
    if (!userId || !matchType || !matchPattern) {
      return res.status(400).json({ error: 'userId, matchType, matchPattern required' });
    }
    const rule = createRoutingRule({ userId, matchType, matchPattern, priority });
    res.status(201).json(rule);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/email/routing-rules/:id', requireAdmin, (req, res) => {
  const ok = deleteRoutingRule(parseInt(req.params.id));
  res.json({ deleted: ok });
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

app.get('/api/github/config', requireAuth, (req, res) => {
  const config = loadGithubConfig();
  if (!config) return res.json({ configured: false });
  res.json({
    configured: true,
    token: config.token ? String.fromCodePoint(0x2022).repeat(8) + config.token.slice(-4) : '',
    repo: config.repo || GITHUB_REPO,
    enabled: config.enabled !== false,
  });
});

app.post('/api/github/config', requireAdmin, (req, res) => {
  try {
    const existing = loadGithubConfig();
    const config = {
      token: (req.body.token && !req.body.token.startsWith(String.fromCodePoint(0x2022))) ? req.body.token : existing?.token,
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

function importFeedbackMd() {
  if (feedbackCount() > 0) return;
  if (!existsSync(FEEDBACK_PATH)) return;
  const content = readFileSync(FEEDBACK_PATH, 'utf-8');
  const blocks = content.split(/^---$/m).filter(b => b.trim());
  for (const block of blocks) {
    const headerMatch = block.match(/##\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*\|\s*(\w+)(?:\s*→\s*GitHub Issue #(\d+))?/);
    if (!headerMatch) continue;
    const [fullHeader, ts, category, ghNum] = headerMatch;
    const message = block.slice(block.indexOf(fullHeader) + fullHeader.length).trim();
    if (!message) continue;
    const db = getDb();
    db.prepare(
      `INSERT INTO feedback (category, message, github_issue_number, created_at) VALUES (?, ?, ?, ?)`
    ).run(category, message, ghNum ? parseInt(ghNum) : null, ts.replace(' ', 'T') + ':00');
  }
  console.log(`[feedback] Imported ${feedbackCount()} entries from feedback.md`);
}

function syncFeedbackMd() {
  const entries = listFeedback().reverse();
  let md = '';
  for (const e of entries) {
    const ts = (e.created_at || '').replace('T', ' ').slice(0, 16);
    const ghNote = e.github_issue_number ? ` → GitHub Issue #${e.github_issue_number}` : '';
    const statusMark = e.status === 'resolved' ? ' RESOLVED' : '';
    md += `\n## ${ts} | ${e.category}${ghNote}${statusMark}\n\n${e.message}\n\n---\n`;
  }
  writeFileSync(FEEDBACK_PATH, md);
}

try { importFeedbackMd(); } catch (e) {
  console.error('[feedback] Import failed:', e.message);
}

app.get('/api/feedback', requireAuth, (req, res) => {
  try {
    const entries = listFeedback();
    let content = '';
    if (existsSync(FEEDBACK_PATH)) content = readFileSync(FEEDBACK_PATH, 'utf-8');
    res.json({ entries, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/feedback', requireAuth, async (req, res) => {
  try {
    const { category, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });
    const cat = category || 'general';

    let ghIssue = null;
    try {
      ghIssue = await createGithubIssue(cat, message);
    } catch (e) {
      console.error('[feedback] GitHub issue creation failed:', e.message);
    }

    const entry = createFeedback({
      category: cat,
      message: message.trim(),
      github_issue_number: ghIssue?.number || null,
      github_issue_url: ghIssue?.url || null,
    });
    syncFeedbackMd();
    res.json({ saved: true, entry, github: ghIssue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/feedback/:id/resolve', requireAdmin, (req, res) => {
  try {
    const entry = resolveFeedback(parseInt(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Not found' });
    syncFeedbackMd();
    res.json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/feedback/:id/reopen', requireAdmin, (req, res) => {
  try {
    const entry = reopenFeedback(parseInt(req.params.id));
    if (!entry) return res.status(404).json({ error: 'Not found' });
    syncFeedbackMd();
    res.json(entry);
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
