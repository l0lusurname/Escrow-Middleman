import fs from 'fs/promises';
import path from 'path';

const DEFAULT_STORE = process.env.SELLAUTH_INVOICE_STORE_FILE || './data/processed_invoices.json';

async function ensureStoreExists(storePath = DEFAULT_STORE) {
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(storePath);
  } catch (err) {
    await fs.writeFile(storePath, JSON.stringify({ processed: [] }, null, 2));
  }
}

export async function loadProcessedStore(storePath = DEFAULT_STORE) {
  await ensureStoreExists(storePath);
  const raw = await fs.readFile(storePath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    const set = new Set(Array.isArray(parsed.processed) ? parsed.processed : []);
    return { set, storePath };
  } catch (err) {
    // corrupt file - reset
    await fs.writeFile(storePath, JSON.stringify({ processed: [] }, null, 2));
    return { set: new Set(), storePath };
  }
}

export async function hasProcessed(invoiceId, storePath = DEFAULT_STORE) {
  const { set } = await loadProcessedStore(storePath);
  return set.has(String(invoiceId));
}

export async function markProcessed(invoiceId, storePath = DEFAULT_STORE) {
  const { set, storePath: sp } = await loadProcessedStore(storePath);
  set.add(String(invoiceId));
  const arr = Array.from(set.values());
  await fs.writeFile(sp, JSON.stringify({ processed: arr }, null, 2));
}
