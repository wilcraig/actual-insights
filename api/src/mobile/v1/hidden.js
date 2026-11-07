const { getActualClient } = require('../../actual-client');
const { readHiddenIds } = require('../../mobile-hidden-accounts-store');

// Hidden accounts, applied in ONE place. Every device-token builder gets its
// Actual client from scopedClient(), a view of the real client in which the
// hidden accounts do not exist:
//   - getAccounts() leaves them out (so every balance, goal, forecast and
//     report that walks the account list skips them),
//   - getAccountBalance()/getTransactions() for one of them come back empty,
//   - every AQL query on `transactions` gets an "account is not hidden"
//     filter, so no row of theirs is ever counted, listed or addressable (a
//     transaction in a hidden account is simply not found).
// Budget data (getBudgetMonth, categories) is Actual's own computation and is
// deliberately left alone. The real client is never modified.

function notHiddenFilter(hiddenIds) {
  return { $and: hiddenIds.map((id) => ({ account: { $ne: id } })) };
}

// A query on the transactions table, restricted to visible accounts.
function restrictQuery(query, hiddenIds) {
  if (hiddenIds.length === 0 || !query || typeof query.serialize !== 'function') return query;
  if (query.serialize().table !== 'transactions') return query;
  return query.filter(notHiddenFilter(hiddenIds));
}

// A transfer out of a visible account INTO a hidden one is still the visible
// account's money, so the row stays, but its payee ("Transfer: <account>")
// must not give the hidden account's name away.
const MASKED_TRANSFER_NAME = 'Other account';
function maskTransferNames(result, hidden) {
  if (!result || !Array.isArray(result.data)) return result;
  let changed = false;
  const data = result.data.map((row) => {
    if (row && row['payee.transfer_acct'] != null && hidden.has(row['payee.transfer_acct'])) {
      changed = true;
      return { ...row, 'payee.name': MASKED_TRANSFER_NAME };
    }
    return row;
  });
  return changed ? { ...result, data } : result;
}

function scopeClient(client, hiddenIds) {
  const hidden = new Set(hiddenIds);
  if (hidden.size === 0) return client;
  const ids = [...hidden];
  const overrides = {
    hiddenIds: hidden,
    getAccounts: async (...args) => ((await client.getAccounts(...args)) || []).filter((a) => !hidden.has(a.id)),
    getAccountBalance: async (id, ...rest) => (hidden.has(id) ? 0 : client.getAccountBalance(id, ...rest)),
    getTransactions: async (id, ...rest) => (hidden.has(id) ? [] : client.getTransactions(id, ...rest)),
    aqlQuery: async (query, ...rest) => maskTransferNames(await client.aqlQuery(restrictQuery(query, ids), ...rest), hidden),
  };
  return new Proxy(client, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function scopedClient() {
  const client = await getActualClient();
  return scopeClient(client, await readHiddenIds());
}

module.exports = { scopeClient, scopedClient, restrictQuery, notHiddenFilter };
