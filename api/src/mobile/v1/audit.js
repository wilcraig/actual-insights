const fs = require('fs/promises');
const path = require('path');

// The recovery trail for the phone's writes: one JSON line per successful
// write in <data dir>/mobile-audit.log (time, token id, operation, ids, before
// and after). It never holds the token or anything that could be turned back
// into one. A failure to write the line is logged by code and swallowed: the
// budget change already happened and must not be reported as failed.

const FILE_NAME = 'mobile-audit.log';

const dataDir = () => process.env.INSIGHTS_DATA_DIR || process.env.ACTUALMINT_DATA_DIR || '/data';

async function appendAudit({ tokenId, op, ids, amount, before, after }, now = new Date()) {
  const line = JSON.stringify({ time: now.toISOString(), tokenId, op, ids, amount, before, after });
  try {
    // Mode 0600, like the token file: budget values belong to the owner.
    await fs.appendFile(path.join(dataDir(), FILE_NAME), `${line}\n`, { mode: 0o600 });
  } catch (err) {
    console.error('mobile audit: could not append to the audit log:', err && err.code ? err.code : 'unexpected error');
  }
}

module.exports = { appendAudit, FILE_NAME };
