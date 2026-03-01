/**
 * Email poller — monitors IMAP inbox for invoice attachments.
 * Persists state (lastCheck, processed UIDs) to disk to survive restarts.
 */

import { ImapFlow } from 'imapflow';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createInvoice } from './db.mjs';

const DATA_DIR = process.env.INVOICECLAW_DATA || '/data';
const CONFIG_PATH = join(DATA_DIR, 'email-config.json');
const STATE_PATH = join(DATA_DIR, 'email-poller-state.json');
const INVOICES_DIR = join(DATA_DIR, 'invoices');

let pollerState = {
  running: false,
  lastCheck: null,
  nextCheck: null,
  lastError: null,
  processedCount: 0
};
let pollerTimer = null;
let processedUids = new Set();

function loadState() {
  if (!existsSync(STATE_PATH)) return;
  try {
    const data = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    if (data.lastCheck) pollerState.lastCheck = data.lastCheck;
    if (data.processedCount) pollerState.processedCount = data.processedCount;
    if (Array.isArray(data.processedUids)) processedUids = new Set(data.processedUids);
  } catch {}
}

function saveState() {
  try {
    writeFileSync(STATE_PATH, JSON.stringify({
      lastCheck: pollerState.lastCheck,
      processedCount: pollerState.processedCount,
      processedUids: [...processedUids].slice(-500),
    }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[email-poller] Failed to save state:', err.message);
  }
}

export function getPollerStatus() {
  return { ...pollerState };
}

export function loadEmailConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveEmailConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  restartPoller();
}

export async function testEmailConnection(config) {
  const client = new ImapFlow({
    host: config.host,
    port: parseInt(config.port) || 993,
    secure: config.secure !== false,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    socketTimeout: 15000,
    greetingTimeout: 10000
  });

  client.on('error', () => {});

  try {
    await client.connect();
    const mailbox = await client.getMailboxLock(config.folder || 'INBOX');
    const status = { exists: client.mailbox.exists };
    mailbox.release();
    await client.logout();
    return { success: true, ...status };
  } catch (err) {
    try { await client.logout(); } catch {}
    return { success: false, error: err.message };
  }
}

const INVOICE_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.bmp']);

const SKIP_PATTERNS = [
  /^temp\w*\.\w+$/i,
  /行程单/,
];

function shouldSkipFile(filename) {
  if (!filename) return true;
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(filename)) return true;
  }
  if (filename.length < 5) return true;
  return false;
}

export async function pollOnce() {
  const config = loadEmailConfig();
  if (!config || !config.host || !config.user || !config.pass) return;

  const client = new ImapFlow({
    host: config.host,
    port: parseInt(config.port) || 993,
    secure: config.secure !== false,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    socketTimeout: 90000,
    greetingTimeout: 15000
  });

  client.on('error', (err) => {
    console.error('[email-poller] IMAP client error:', err.message);
    pollerState.lastError = err.message;
  });

  try {
    await client.connect();
    console.log('[email-poller] IMAP connected');
    const lock = await client.getMailboxLock(config.folder || 'INBOX');

    try {
      const since = pollerState.lastCheck
        ? new Date(pollerState.lastCheck)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const messages = [];
      for await (const msg of client.fetch({ since, seen: false }, {
        envelope: true, bodyStructure: true, uid: true
      })) {
        messages.push(msg);
      }
      console.log(`[email-poller] Found ${messages.length} unseen message(s)`);

      let newCount = 0;
      for (const msg of messages) {
        const uidKey = `${config.user}:${msg.uid}`;
        if (processedUids.has(uidKey)) {
          console.log(`[email-poller] Skipping already-processed uid=${msg.uid}`);
          continue;
        }

        try {
          const saved = await processMessage(client, msg, config);
          processedUids.add(uidKey);
          newCount += saved;
        } catch (err) {
          console.error(`[email-poller] Failed to process message uid=${msg.uid}:`, err.message);
        }
      }

      if (newCount > 0) {
        console.log(`[email-poller] Saved ${newCount} new attachment(s)`);
      }
    } finally {
      lock.release();
    }

    await client.logout();
    pollerState.lastCheck = new Date().toISOString();
    pollerState.lastError = null;
    saveState();
    console.log('[email-poller] Poll completed, total processed:', pollerState.processedCount);
  } catch (err) {
    pollerState.lastError = err.message;
    console.error('[email-poller] Poll error:', err.message);
    try { await client.logout(); } catch {}
  }
}

async function processMessage(client, msg, config) {
  const subject = msg.envelope?.subject || '';
  const fromAddr = msg.envelope?.from?.[0]?.address || 'unknown';
  const notePrefix = `From: ${fromAddr}, Subject: ${subject}`;

  let saved = 0;

  const attachments = msg.bodyStructure?.childNodes ? findAttachments(msg.bodyStructure) : [];
  const validAttachments = attachments.filter(att => {
    const ext = extname(att.filename || '').toLowerCase();
    return INVOICE_EXTENSIONS.has(ext) && !shouldSkipFile(att.filename);
  });

  if (validAttachments.length > 0) {
    saved = await downloadAttachments(client, msg, validAttachments, notePrefix);
  } else if (/发票|invoice/i.test(subject)) {
    saved = await processLinksFromBody(client, msg, notePrefix);
  }

  if (config.markRead !== false) {
    try {
      await client.messageFlagsAdd(msg.uid.toString(), ['\\Seen'], { uid: true });
    } catch {}
  }

  return saved;
}

async function downloadAttachments(client, msg, attachments, notePrefix) {
  let saved = 0;
  for (const att of attachments) {
    try {
      const { content } = await client.download(msg.uid.toString(), att.part, { uid: true });
      const chunks = [];
      for await (const chunk of content) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      if (buffer.length < 100) {
        console.log(`[email-poller] Skipping tiny file (${buffer.length}B): ${att.filename}`);
        continue;
      }

      const path = saveInvoiceFile(buffer, att.filename || 'attachment' + extname(att.filename || ''));
      createInvoice({
        invoice_type: 'other', direction: 'inbound', source: 'email',
        status: 'pending', file_path: path, notes: notePrefix,
        invoice_date: new Date().toISOString().split('T')[0], amount: 0, category: 'other'
      });
      pollerState.processedCount++;
      saved++;
      console.log(`[email-poller] Saved attachment: ${basename(path)} (${buffer.length}B)`);
    } catch (err) {
      console.error(`[email-poller] Failed to download attachment: ${err.message}`);
    }
  }
  return saved;
}

async function processLinksFromBody(client, msg, notePrefix) {
  let htmlBody = '';
  try {
    const htmlPart = findHtmlPart(msg.bodyStructure);
    if (!htmlPart) return 0;
    const { content } = await client.download(msg.uid.toString(), htmlPart, { uid: true });
    const chunks = [];
    for await (const chunk of content) chunks.push(chunk);
    htmlBody = Buffer.concat(chunks).toString('utf-8');
  } catch (err) {
    console.error('[email-poller] Failed to fetch email body:', err.message);
    return 0;
  }

  const linkPattern = /https?:\/\/[^\s"'<>]+\.pdf(?:\?[^\s"'<>]*)?/gi;
  const links = [...new Set((htmlBody.match(linkPattern) || []))];

  if (links.length === 0) {
    console.log('[email-poller] Invoice email has no downloadable PDF links');
    return 0;
  }

  let saved = 0;
  for (const url of links.slice(0, 5)) {
    try {
      console.log(`[email-poller] Downloading PDF from link: ${url.substring(0, 80)}...`);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) {
        console.log(`[email-poller] Link returned ${resp.status}, skipping`);
        continue;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length < 500) {
        console.log(`[email-poller] Downloaded file too small (${buffer.length}B), skipping`);
        continue;
      }

      const urlFilename = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'invoice.pdf';
      const path = saveInvoiceFile(buffer, urlFilename);
      createInvoice({
        invoice_type: 'other', direction: 'inbound', source: 'email',
        status: 'pending', file_path: path, notes: notePrefix,
        invoice_date: new Date().toISOString().split('T')[0], amount: 0, category: 'other'
      });
      pollerState.processedCount++;
      saved++;
      console.log(`[email-poller] Saved from link: ${basename(path)} (${buffer.length}B)`);
    } catch (err) {
      console.error(`[email-poller] Failed to download from link: ${err.message}`);
    }
  }
  return saved;
}

function saveInvoiceFile(buffer, filename) {
  const now = new Date();
  const destDir = join(INVOICES_DIR, now.getFullYear().toString(), String(now.getMonth() + 1).padStart(2, '0'));
  mkdirSync(destDir, { recursive: true });
  const destName = `${Date.now()}-${filename}`;
  const destPath = join(destDir, destName);
  writeFileSync(destPath, buffer);
  return destPath;
}

function findHtmlPart(structure, path = '') {
  if (!structure) return null;
  if (structure.type === 'text/html') return path || '1';
  if (structure.childNodes) {
    for (let i = 0; i < structure.childNodes.length; i++) {
      const childPath = path ? `${path}.${i + 1}` : `${i + 1}`;
      const found = findHtmlPart(structure.childNodes[i], childPath);
      if (found) return found;
    }
  }
  return null;
}

function findAttachments(structure, path = '') {
  const result = [];
  if (structure.disposition === 'attachment' || (structure.type && structure.type.startsWith('application/'))) {
    if (structure.dispositionParameters?.filename || structure.parameters?.name) {
      result.push({
        filename: structure.dispositionParameters?.filename || structure.parameters?.name,
        part: path || '1'
      });
    }
  }
  if (structure.childNodes) {
    for (let i = 0; i < structure.childNodes.length; i++) {
      const childPath = path ? `${path}.${i + 1}` : `${i + 1}`;
      result.push(...findAttachments(structure.childNodes[i], childPath));
    }
  }
  return result;
}

export function startPoller() {
  loadState();

  const config = loadEmailConfig();
  if (!config || !config.enabled) {
    pollerState.running = false;
    return;
  }

  const interval = (parseInt(config.pollInterval) || 15) * 60 * 1000;
  pollerState.running = true;

  const tick = async () => {
    await pollOnce();
    pollerState.nextCheck = new Date(Date.now() + interval).toISOString();
  };

  tick();
  pollerTimer = setInterval(tick, interval);
}

export function stopPoller() {
  if (pollerTimer) { clearInterval(pollerTimer); pollerTimer = null; }
  pollerState.running = false;
  pollerState.nextCheck = null;
}

export function restartPoller() {
  stopPoller();
  startPoller();
}
