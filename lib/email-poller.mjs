/**
 * Email poller — monitors IMAP inbox for invoice attachments.
 */

import { ImapFlow } from 'imapflow';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createInvoice } from './db.mjs';

const DATA_DIR = process.env.INVOICECLAW_DATA || '/data';
const CONFIG_PATH = join(DATA_DIR, 'email-config.json');
const INVOICES_DIR = join(DATA_DIR, 'invoices');

let pollerState = {
  running: false,
  lastCheck: null,
  nextCheck: null,
  lastError: null,
  processedCount: 0
};
let pollerTimer = null;

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
    logger: false
  });

  try {
    await client.connect();
    const mailbox = await client.getMailboxLock(config.folder || 'INBOX');
    const status = { exists: client.mailbox.exists };
    mailbox.release();
    await client.logout();
    return { success: true, ...status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

const INVOICE_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.bmp']);

export async function pollOnce() {
  const config = loadEmailConfig();
  if (!config || !config.host || !config.user || !config.pass) return;

  const client = new ImapFlow({
    host: config.host,
    port: parseInt(config.port) || 993,
    secure: config.secure !== false,
    auth: { user: config.user, pass: config.pass },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.folder || 'INBOX');

    try {
      const since = pollerState.lastCheck
        ? new Date(pollerState.lastCheck)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      for await (const msg of client.fetch({ since, seen: false }, {
        envelope: true, bodyStructure: true, uid: true
      })) {
        await processMessage(client, msg, config);
      }
    } finally {
      lock.release();
    }

    await client.logout();
    pollerState.lastCheck = new Date().toISOString();
    pollerState.lastError = null;
  } catch (err) {
    pollerState.lastError = err.message;
    console.error('[email-poller] Error:', err.message);
  }
}

async function processMessage(client, msg, config) {
  if (!msg.bodyStructure || !msg.bodyStructure.childNodes) return;

  const attachments = findAttachments(msg.bodyStructure);
  if (attachments.length === 0) return;

  for (const att of attachments) {
    const ext = extname(att.filename || '').toLowerCase();
    if (!INVOICE_EXTENSIONS.has(ext)) continue;

    try {
      const { content } = await client.download(msg.uid.toString(), att.part, { uid: true });
      const chunks = [];
      for await (const chunk of content) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      const now = new Date();
      const year = now.getFullYear().toString();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const destDir = join(INVOICES_DIR, year, month);
      mkdirSync(destDir, { recursive: true });

      const destName = `${Date.now()}-${att.filename || 'attachment' + ext}`;
      const destPath = join(destDir, destName);
      writeFileSync(destPath, buffer);

      createInvoice({
        invoice_type: 'other',
        direction: 'inbound',
        source: 'email',
        status: 'pending',
        file_path: destPath,
        notes: `From: ${msg.envelope?.from?.[0]?.address || 'unknown'}, Subject: ${msg.envelope?.subject || ''}`,
        invoice_date: now.toISOString().split('T')[0],
        amount: 0,
        category: 'other'
      });
      pollerState.processedCount++;

      console.log(`[email-poller] Saved attachment: ${destName}`);
    } catch (err) {
      console.error(`[email-poller] Failed to download attachment: ${err.message}`);
    }
  }

  if (config.markRead !== false) {
    try {
      await client.messageFlagsAdd(msg.uid.toString(), ['\\Seen'], { uid: true });
    } catch {}
  }
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
