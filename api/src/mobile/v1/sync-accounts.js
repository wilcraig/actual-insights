const { getActualClient } = require('../../actual-client');
const { HttpError } = require('./common');
const { appendAudit } = require('./audit');
const { exclusive, syncNow } = require('./write');

// POST /accounts/sync: Actual's own bank sync for every linked account (the
// API's runBankSync with no accountId runs them all, like the sidebar's 'Sync
// accounts'). It can take up to about a minute, so:
//  - a second request while one is pending or running is a 409 'busy' at once
//    (the flag is taken before waiting for the write lock);
//  - the work runs inside the shared write lock, so it never interleaves with
//    another write, and the lock is given back after a generous timeout even
//    if Actual never answers (the late result is dropped);
//  - any failure is 502 'bank_sync_failed'. Nothing Actual says is echoed or
//    logged (only error.code); transactions that did import stay imported.

const DEFAULT_TIMEOUT_MS = 110 * 1000;
let inFlight = false;

const timeoutMs = () => {
  const n = Number(process.env.INSIGHTS_BANK_SYNC_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
};

async function runWithTimeout(client) {
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs());
  });
  const run = Promise.resolve().then(() => client.runBankSync());
  run.catch(() => {}); // a result arriving after the timeout is dropped
  try {
    await Promise.race([run, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function syncAllAccounts({ tokenId }) {
  if (inFlight) throw new HttpError(409, 'busy');
  inFlight = true;
  try {
    return await exclusive(async () => {
      const client = await getActualClient();
      try {
        await runWithTimeout(client);
      } catch (err) {
        console.error('mobile v1 accounts sync failed:', err && err.code ? err.code : 'unexpected error');
        // Part of the sync may have imported before the error: pick it up.
        await syncNow(client);
        throw new HttpError(502, 'bank_sync_failed');
      }
      await syncNow(client);
      await appendAudit({ tokenId, op: 'accounts.sync' });
      return { schema: 1, ok: true, syncedAt: new Date().toISOString() };
    });
  } finally {
    inFlight = false;
  }
}

const resetSyncState = () => {
  inFlight = false;
};

module.exports = { syncAllAccounts, resetSyncState, DEFAULT_TIMEOUT_MS };
