// Pure helpers for the Chipmunk-mode tabs (no DOM, no network).

// Same 12 keys and hex values as the phone (Chipmunk repo shared/fixtures/palette.json).
export const PALETTE = {
  blue: ['#2563eb', '#60a5fa'], teal: ['#0d9488', '#2dd4bf'], green: ['#16a34a', '#4ade80'], lime: ['#65a30d', '#a3e635'],
  yellow: ['#ca8a04', '#facc15'], orange: ['#ea580c', '#fb923c'], red: ['#dc2626', '#f87171'], pink: ['#db2777', '#f472b6'],
  purple: ['#9333ea', '#c084fc'], indigo: ['#4f46e5', '#818cf8'], brown: ['#92400e', '#d6a77a'], gray: ['#6b7280', '#9ca3af'],
};
export const PALETTE_KEYS = Object.keys(PALETTE);

export function colorFor(key, index = 0, dark = false) {
  const k = PALETTE[key] ? key : PALETTE_KEYS[((index % 12) + 12) % 12];
  return PALETTE[k][dark ? 1 : 0];
}

export function formatMoney(cents, { currency = 'USD', locale } = {}) {
  if (!Number.isFinite(cents)) return '–';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)}`;
  }
}

// Green for money, red for owing, neutral for zero or unknown (the phone's
// accounts list colours negatives red; the web adds green for positives).
export function balanceTone(cents) {
  if (!Number.isFinite(cents) || cents === 0) return 'neutral';
  return cents < 0 ? 'negative' : 'positive';
}

// ---- account groups -------------------------------------------------------

const COLLAPSE_KEY = 'insights:chipmunk:expandedGroups';

// Groups are collapsed unless the user opened them (remembered per browser).
export function loadExpanded(storage) {
  try {
    const raw = JSON.parse(storage.getItem(COLLAPSE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveExpanded(storage, set) {
  try {
    storage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    // No persistence: the choice holds for this visit.
  }
}

// -> [{ section: 'On budget'|'Off budget', rows: [{type:'account',account}|{type:'group',group,accounts}] }]
// Accounts keep the server's (Actual's sidebar) order; a group sits where its first account is.
export function layoutAccounts(response) {
  const accounts = response?.accounts ?? [];
  const groups = new Map((response?.groups ?? []).map((g) => [g.id, g]));
  const sections = [];
  for (const [label, onBudget] of [['On budget', true], ['Off budget', false]]) {
    const mine = accounts.filter((a) => a.onBudget === onBudget);
    if (mine.length === 0) continue;
    const rows = [];
    const seen = new Map();
    for (const account of mine) {
      const group = account.groupId && groups.get(account.groupId);
      if (!group) {
        rows.push({ type: 'account', account });
      } else if (seen.has(group.id)) {
        seen.get(group.id).accounts.push(account);
      } else {
        const row = { type: 'group', group, accounts: [account] };
        seen.set(group.id, row);
        rows.push(row);
      }
    }
    // A group's subtotal is for this section only.
    for (const row of rows) {
      if (row.type === 'group') {
        row.subtotal = row.accounts.some((a) => a.balance === null) ? null : row.accounts.reduce((s, a) => s + a.balance, 0);
      }
    }
    sections.push({ label, rows });
  }
  return sections;
}

// ---- transaction search + filter -----------------------------------------

export const emptyFilter = () => ({ text: '', uncategorized: false, payees: [], categories: [], group: null });

export function toQuery(filter, { account, cursor, showHidden, limit } = {}) {
  const p = new URLSearchParams();
  if (account) p.set('account', account);
  if (filter.uncategorized) p.set('uncategorized', '1');
  if (filter.group && !filter.uncategorized && filter.categories.length === 0) p.set('group', filter.group.id);
  if (!filter.uncategorized && !filter.group && filter.categories.length) p.set('categories', filter.categories.map((c) => c.id).join(','));
  if (filter.payees.length) p.set('payees', filter.payees.map((x) => x.id).join(','));
  if (filter.text.trim()) p.set('q', filter.text.trim());
  if (limit) p.set('limit', String(limit));
  if (cursor) p.set('cursor', cursor);
  if (showHidden) p.set('showHidden', '1');
  return p.toString();
}

// What is shown as chips under the bar, in a stable order.
export function chips(filter) {
  const out = [];
  if (filter.text.trim()) out.push({ kind: 'text', label: `“${filter.text.trim()}”` });
  if (filter.uncategorized) out.push({ kind: 'uncategorized', label: 'Uncategorized' });
  if (filter.group) out.push({ kind: 'group', label: filter.group.name });
  for (const c of filter.categories) out.push({ kind: 'category', id: c.id, label: c.name });
  for (const m of filter.payees) out.push({ kind: 'payee', id: m.id, label: m.name });
  return out;
}

export function removeChip(filter, chip) {
  const next = { ...filter, payees: [...filter.payees], categories: [...filter.categories] };
  if (chip.kind === 'text') next.text = '';
  else if (chip.kind === 'uncategorized') next.uncategorized = false;
  else if (chip.kind === 'group') next.group = null;
  else if (chip.kind === 'category') next.categories = next.categories.filter((c) => c.id !== chip.id);
  else if (chip.kind === 'payee') next.payees = next.payees.filter((m) => m.id !== chip.id);
  return next;
}

// A suggestion row is { kind: 'merchant'|'category', id, name }. "Choose" replaces
// that kind's selection with just this item; "add" extends it (max 20 each).
export function applySuggestion(filter, row, { add = false } = {}) {
  const next = { ...filter, payees: [...filter.payees], categories: [...filter.categories], text: '' };
  const item = { id: row.id, name: row.name };
  const key = row.kind === 'merchant' ? 'payees' : 'categories';
  if (row.kind === 'category') {
    next.uncategorized = false;
    next.group = null;
  }
  const existing = next[key];
  if (add) {
    if (!existing.some((x) => x.id === item.id) && existing.length < 20) existing.push(item);
  } else {
    next[key] = [item];
  }
  return next;
}

export function suggestionRows(response) {
  return [
    ...(response?.merchants ?? []).map((m) => ({ kind: 'merchant', id: m.id, name: m.name })),
    ...(response?.categories ?? []).map((c) => ({ kind: 'category', id: c.id, name: c.name, groupName: c.groupName })),
  ];
}

// ---- reports --------------------------------------------------------------

const REPORT_KEY = 'insights:chipmunk:report';

export function loadReportChoice(storage) {
  try {
    return storage.getItem(REPORT_KEY) || null;
  } catch {
    return null;
  }
}
export function saveReportChoice(storage, id) {
  try {
    if (id) storage.setItem(REPORT_KEY, id);
    else storage.removeItem(REPORT_KEY);
  } catch {
    // Not remembered.
  }
}

// The report to show: the picked one if it still exists, else the saved one if
// listed, else the server's default.
export function effectiveReport(list, picked, saved) {
  const ids = new Set((list?.reports ?? []).map((r) => r.id));
  if (picked && ids.has(picked)) return picked;
  if (saved && ids.has(saved)) return saved;
  return list?.defaultId ?? null;
}

// Month arrows on a breakdown card: earliest <= month <= current.
export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}
export function canShift(nav, delta, currentMonth) {
  if (!nav) return false;
  const next = shiftMonth(nav.month, delta);
  if (delta < 0) return !nav.earliest || next >= nav.earliest;
  return next <= currentMonth;
}

// ---- budget series --------------------------------------------------------

// Form -> request body for POST/PUT /budget-series (cents already).
export function seriesBody({ categoryId, amountCents, startMonth, mode, months, untilMonth, dryRun }, { isUpdate = false } = {}) {
  const body = { amount: amountCents, startMonth, mode };
  if (!isUpdate) body.categoryId = categoryId;
  if (mode === 'months') body.months = months;
  if (mode === 'until') body.untilMonth = untilMonth;
  if (dryRun) body.dryRun = true;
  return body;
}

export function parseAmountToCents(text) {
  const t = String(text ?? '').trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function seriesSummary(series) {
  if (!series) return '';
  if (series.mode === 'indefinite') return 'Repeats every month';
  const [y, m] = series.endMonth.split('-').map(Number);
  const name = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
  return `Repeats until ${name}`;
}
