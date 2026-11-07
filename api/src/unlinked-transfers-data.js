// Same window a bank-sync transfer's two sides can legitimately land on --
// matches the Actual docs' own historical-transfer-matching script
// (actualbudget.org/docs/advanced/scripts/modify-transfers), which uses the
// same +/-3-day tolerance. A gap wider than this is treated as "probably not
// the same real-world transfer" rather than widened further.
const MATCH_WINDOW_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDateOnly(dateStr) {
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  return new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
}

function daysBetween(dateStrA, dateStrB) {
  const a = parseDateOnly(dateStrA);
  const b = parseDateOnly(dateStrB);
  return Math.abs(a.getTime() - b.getTime()) / MS_PER_DAY;
}

// Finds unlinked (transfer_id == null) transactions whose amount, date and
// account make them very likely the two unmatched sides of one real-world
// transfer -- the same scenario the morning-briefing income investigation
// found by hand (a credit-card autopay whose checking-side debit and
// card-side credit post a few days apart, outside Actual's own bank-sync
// transfer-matching window). Deliberately stricter than Actual's own docs
// script in one respect: a candidate counts only when BOTH sides see each
// other as their unique match, not just one side -- a one-directional match
// (e.g. three same-amount transactions all pointing at one single
// candidate) is exactly the kind of inconsistent, non-reciprocal state that
// should never be auto-linked.
//
// `transactionsByAccount` is a Map<accountId, transaction[]>, where each
// transaction has at least { id, account, amount, date, transfer_id,
// tombstone }.
function findUnlinkedTransferCandidates(transactionsByAccount) {
  const candidates = [];
  for (const [accountId, transactions] of transactionsByAccount) {
    for (const txn of transactions) {
      if (txn.tombstone) continue;
      if (txn.transfer_id) continue;
      candidates.push({ ...txn, account: txn.account || accountId });
    }
  }

  function matchesFor(txn) {
    return candidates.filter(
      (other) =>
        other.id !== txn.id &&
        other.account !== txn.account &&
        other.amount === -txn.amount &&
        daysBetween(other.date, txn.date) <= MATCH_WINDOW_DAYS
    );
  }

  const pairs = [];
  const seen = new Set();
  for (const txn of candidates) {
    const matches = matchesFor(txn);
    if (matches.length !== 1) continue;

    const match = matches[0];
    const reciprocal = matchesFor(match);
    if (reciprocal.length !== 1 || reciprocal[0].id !== txn.id) continue;

    const pairKey = [txn.id, match.id].sort().join('|');
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const [first, second] = txn.date <= match.date ? [txn, match] : [match, txn];
    pairs.push({
      amountCents: Math.abs(txn.amount),
      first: { id: first.id, account: first.account, date: first.date },
      second: { id: second.id, account: second.account, date: second.date },
    });
  }

  pairs.sort((a, b) => (a.first.date < b.first.date ? 1 : -1));
  return pairs;
}

// Pairs of opposite-amount, never-linked transactions in the last 180 days.
// Shared by /api/unlinked-transfers and the native reports.
async function loadUnlinkedTransfers(client, now = new Date()) {
  const rangeEnd = now;
  const rangeStart = new Date(rangeEnd.getTime() - 180 * MS_PER_DAY);
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const rangeStartStr = fmt(rangeStart);
  const rangeEndStr = fmt(rangeEnd);

  const allAccounts = await client.getAccounts();
  const onBudgetAccounts = (allAccounts || []).filter((a) => !a.closed && !a.offbudget);
  const accountNameById = new Map(onBudgetAccounts.map((a) => [a.id, a.name]));

  const transactionsByAccount = new Map();
  await Promise.all(
    onBudgetAccounts.map(async (account) => {
      const transactions = await client.getTransactions(account.id, rangeStartStr, rangeEndStr);
      transactionsByAccount.set(account.id, transactions || []);
    })
  );

  const pairs = findUnlinkedTransferCandidates(transactionsByAccount);

  return {
    rangeStart: rangeStartStr,
    rangeEnd: rangeEndStr,
    candidates: pairs.map((p) => ({
      amountCents: p.amountCents,
      first: { ...p.first, accountName: accountNameById.get(p.first.account) || null },
      second: { ...p.second, accountName: accountNameById.get(p.second.account) || null },
    })),
  };
}

module.exports = { loadUnlinkedTransfers, findUnlinkedTransferCandidates };
