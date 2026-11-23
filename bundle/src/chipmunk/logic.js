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

export const emptyFilter = () => ({ text: '', uncategorized: false, payees: [], categories: [], group: null, month: null });

export function toQuery(filter, { account, cursor, showHidden, limit } = {}) {
  const p = new URLSearchParams();
  if (account) p.set('account', account);
  if (filter.uncategorized) p.set('uncategorized', '1');
  if (filter.group && !filter.uncategorized && filter.categories.length === 0) p.set('group', filter.group.id);
  if (!filter.uncategorized && !filter.group && filter.categories.length) p.set('categories', filter.categories.map((c) => c.id).join(','));
  if (filter.month) p.set('month', filter.month);
  if (filter.payees.length) p.set('payees', filter.payees.map((x) => x.id).join(','));
  if (filter.text.trim()) p.set('q', filter.text.trim());
  if (limit) p.set('limit', String(limit));
  if (cursor) p.set('cursor', cursor);
  if (showHidden) p.set('showHidden', '1');
  return p.toString();
}

// 'YYYY-MM' as 'Nov 2026' (fixed English names, no time zone involved).
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

// What is shown as chips under the bar, in a stable order.
export function chips(filter) {
  const out = [];
  if (filter.text.trim()) out.push({ kind: 'text', label: `“${filter.text.trim()}”` });
  if (filter.uncategorized) out.push({ kind: 'uncategorized', label: 'Uncategorized' });
  if (filter.month) out.push({ kind: 'month', label: monthLabel(filter.month) });
  if (filter.group) out.push({ kind: 'group', label: filter.group.name });
  for (const c of filter.categories) out.push({ kind: 'category', id: c.id, label: c.name });
  for (const m of filter.payees) out.push({ kind: 'payee', id: m.id, label: m.name });
  return out;
}

export function removeChip(filter, chip) {
  const next = { ...filter, payees: [...filter.payees], categories: [...filter.categories] };
  if (chip.kind === 'text') next.text = '';
  else if (chip.kind === 'uncategorized') next.uncategorized = false;
  else if (chip.kind === 'month') next.month = null;
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

// Resizable table columns, remembered per browser. Widths are px and clamped.
const COLS_KEY = 'insights:chipmunk:txColumns';
export const COLUMN_LIMITS = { date: [70, 220], category: [110, 520], amount: [70, 220] };
export const DEFAULT_COLUMNS = { date: 110, category: 260, amount: 110 };

export function clampColumn(id, px) {
  const [min, max] = COLUMN_LIMITS[id] ?? [60, 600];
  const n = Number(px);
  return Math.round(Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)));
}

export function loadColumns(storage) {
  try {
    const raw = JSON.parse(storage.getItem(COLS_KEY) || '{}');
    const out = { ...DEFAULT_COLUMNS };
    for (const id of Object.keys(DEFAULT_COLUMNS)) if (raw && Number.isFinite(raw[id])) out[id] = clampColumn(id, raw[id]);
    return out;
  } catch {
    return { ...DEFAULT_COLUMNS };
  }
}

export function saveColumns(storage, widths) {
  try {
    storage.setItem(COLS_KEY, JSON.stringify(widths));
  } catch {
    // Blocked storage: widths just are not remembered.
  }
}

export function resetColumns(storage) {
  try {
    storage.removeItem(COLS_KEY);
  } catch {
    // Nothing to forget.
  }
}

// ---- Average spend and rollover reset (budget amount editor) ----
// Same math and wording as the phone apps (spec "Category pacing, budget averages,
// rollover reset and split remainder"; NativeBudgetInsights.swift / BudgetInsights.kt).
export const SPEND_CHOICES = [3, 6];
export const SPEND_DEFAULT_MONTHS = 3;
export const HISTORY_FETCH_MONTHS = 6;
export const NO_HISTORY = 'Not enough history yet';
export const ROLLOVER_BANNER = 'Rollover reset';
const AVG_KEY = 'insights:chipmunk:avgMonths';

/** A stored toggle value, or the default for anything else. */
export const normalizeSpendMonths = (n) => (SPEND_CHOICES.includes(Number(n)) ? Number(n) : SPEND_DEFAULT_MONTHS);

export function loadSpendMonths(storage) {
  try {
    return normalizeSpendMonths(storage.getItem(AVG_KEY));
  } catch {
    return SPEND_DEFAULT_MONTHS;
  }
}

export function saveSpendMonths(storage, months) {
  try {
    storage.setItem(AVG_KEY, String(normalizeSpendMonths(months)));
  } catch {
    // Blocked storage: the choice is just not remembered.
  }
}

/**
 * The half-up integer-cent average of abs(spent) over the newest `window`
 * entries of `history` (oldest first), or over all of them when fewer exist.
 * null when there is nothing to average.
 * @returns {{ cents: number, months: number, requested: number } | null}
 */
export function averageSpend(history, window) {
  if (!Array.isArray(history) || !(window > 0)) return null;
  const used = history.slice(-window);
  if (used.length === 0) return null;
  const sum = used.reduce((s, m) => s + Math.abs(Number(m?.spent) || 0), 0);
  const n = used.length;
  return { cents: Math.floor((sum * 2 + n) / (2 * n)), months: n, requested: window };
}

/** "Avg of last 3 months: $X", or "Avg of 2 months: $X" ("1 month") when the budget is younger. */
export function spendAverageLabel(avg, amount) {
  if (avg.months === avg.requested) return `Avg of last ${avg.months} months: ${amount}`;
  return `Avg of ${avg.months} ${avg.months === 1 ? 'month' : 'months'}: ${amount}`;
}

/** What a rollover category carries in from last month: balance - budgeted - spent, when that is positive. */
export function rolloverCarriedIn(cat) {
  const { balance, budgeted, spent } = cat ?? {};
  if (![balance, budgeted, spent].every(Number.isFinite)) return null;
  const x = balance - budgeted - spent;
  return x > 0 ? x : null;
}

/** The reset is offered for a rollover category, in the current month, when writing is allowed. */
export const offersRolloverReset = ({ carryover, month, currentMonth, canWrite }) =>
  carryover === true && canWrite === true && /^\d{4}-\d{2}$/.test(month) && month === currentMonth;

/** The confirmation text; the "carried in" sentence is left out when the amount cannot be worked out. */
export function rolloverConfirmMessage(carriedIn, amount) {
  if (carriedIn != null && amount) {
    return `Start this rollover from $0? The ${amount} carried in from last month will stop carrying over. Earlier months are not changed.`;
  }
  return 'Start this rollover from $0? Earlier months are not changed.';
}
