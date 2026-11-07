const { q } = require('@actual-app/api');

const { isIncomeGroup, isTransferGroup, loadMonthCashFlow } = require('../../cash-flow-data');
const { parsePlaceholder, insightsBuilder } = require('./reports-insights');
const { Unsupported, conditionsFilter, txFilter, dailySums, bucketSums, sumsBy } = require('./reports-query');
const { addMonths, enumerateBuckets, fmt, lastMonths, monthKey, monthsInRange, resolveReportRange, resolveTimeFrame, startOfDay } = require('./reports-time');

// GET /reports for the native clients: the Actual dashboard's widgets, each
// computed server-side and shaped as one card (see the native client API
// spec, "Reports: how dashboard widgets become cards"). A widget that cannot
// be shown, or whose data fails or takes too long, becomes an `unsupported`
// card that keeps its title; one bad card never hides the rest.

const MAX_CARDS = 40;
const MAX_POINTS = 400;
const MAX_ITEMS = 60;
const MAX_TEXT = 4000;
const MAX_NAME = 200;
const MAX_CALENDAR_DAYS = 62;
const CARD_TIMEOUT_MS = 5000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MONEY_LIMIT = 10000000000000;

const clip = (value, max = MAX_NAME) => String(value ?? '').slice(0, max);

function money(n) {
  const r = Math.round(Number(n));
  if (!Number.isFinite(r) || Math.abs(r) > MONEY_LIMIT) throw new Unsupported('number out of range');
  return r === 0 ? 0 : r;
}

// Percent and number stats keep two decimals; money is always whole cents.
function statNumber(n, format) {
  if (format === 'money') return money(n);
  const r = Math.round(Number(n) * 100) / 100;
  if (!Number.isFinite(r) || Math.abs(r) > MONEY_LIMIT) throw new Unsupported('number out of range');
  return r === 0 ? 0 : r;
}

// ---- markdown ----

function stripMarkdown(md) {
  return String(md ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, '')
    .replace(/^(\s*)[*+]\s+/gm, '$1- ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A plain markdown card: the first heading becomes the title when the widget
// has no name, and the rest is the text.
function textCard(meta) {
  const content = String(meta.content ?? '');
  let title = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : null;
  let body = content;
  if (!title) {
    const m = /^\s*#{1,6}\s+(.+?)\s*(?:\n|$)/.exec(content);
    if (m) {
      title = stripMarkdown(m[1]);
      body = content.slice(m[0].length);
    }
  }
  return { kind: 'text', title: title || 'Note', text: stripMarkdown(body).slice(0, MAX_TEXT) };
}

// ---- breakdown / series helpers ----

// Largest first (by absolute value), at most `max` items: the tail folds into
// one "Other". total is the sum of everything, so it never drops the tail.
function capItems(items, max = MAX_ITEMS) {
  const clean = items.filter((i) => i.value !== 0).map((i) => ({ label: clip(i.label || 'Uncategorized'), value: money(i.value) }));
  clean.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const total = clean.reduce((sum, i) => sum + i.value, 0);
  if (clean.length <= max) return { items: clean, total: money(total) };
  const head = clean.slice(0, max - 1);
  const other = clean.slice(max - 1).reduce((sum, i) => sum + i.value, 0);
  return { items: [...head, { label: 'Other', value: money(other) }], total: money(total) };
}

function capPoints(points) {
  return points.slice(-MAX_POINTS).map((p) => ({ label: clip(p.label), value: money(p.value) }));
}

// ---- card builders ----

async function summaryCard(ctx, meta) {
  let content = meta.content;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      throw new Unsupported('summary content');
    }
  }
  const type = content && content.type;
  if (type !== 'sum' && type !== 'avgPerMonth' && type !== 'avgPerTransact') throw new Unsupported('summary type');
  const range = await resolveTimeFrame(meta.timeFrame, ctx.now, { earliest: ctx.earliest });
  const filter = txFilter({ start: range.start, end: range.end, extra: [conditionsFilter(meta.conditions, meta.conditionsOp)] });
  const daily = await dailySums(ctx.client, filter);
  let sum = 0;
  let count = 0;
  for (const v of daily.values()) {
    sum += v.amount;
    count += v.count;
  }
  let value = sum;
  if (type === 'avgPerMonth') value = sum / monthsInRange(range.start, range.end);
  if (type === 'avgPerTransact') value = count === 0 ? 0 : sum / count;
  return { kind: 'stat', value: money(value), format: 'money', subtitle: `${range.start} to ${range.end}` };
}

// Income minus spending per month by the Insights rules (the same numbers as
// the savings rate and the Sankey), last 6 months unless the widget says more.
async function cashFlowCard(ctx, meta) {
  const range = meta && meta.timeFrame ? await resolveTimeFrame(meta.timeFrame, ctx.now, { earliest: ctx.earliest, fallbackMonths: 6 }) : lastMonths(ctx.now, 6);
  const months = enumerateBuckets(range.start, range.end, 'Monthly', 24);
  const flows = await Promise.all(months.map((m) => loadMonthCashFlow(ctx.client, m)));
  const points = months.map((m, i) => ({ label: m, value: flows[i].incomeCents - flows[i].spendingCents }));
  return { kind: 'series', chart: 'bar', format: 'money', points: capPoints(points), subtitle: 'Income minus spending' };
}

// Month-end total across all open accounts. Starting balances are
// transactions, so a running sum of every transaction is the balance.
async function netWorthCard(ctx, meta) {
  const range = meta && meta.timeFrame ? await resolveTimeFrame(meta.timeFrame, ctx.now, { earliest: ctx.earliest }) : lastMonths(ctx.now, 12);
  const todayMonth = monthKey(ctx.now);
  const endMonth = range.end.slice(0, 7) < todayMonth ? range.end.slice(0, 7) : todayMonth;
  const filter = txFilter({ end: `${endMonth}-31`, extra: [{ 'account.closed': false }, conditionsFilter(meta && meta.conditions, meta && meta.conditionsOp)] });
  const monthly = bucketSums(await dailySums(ctx.client, filter), 'Monthly');
  const startMonth = range.start.slice(0, 7);
  let running = 0;
  const known = [...monthly.keys()].sort();
  for (const m of known) if (m < startMonth) running += monthly.get(m);
  const points = [];
  for (const m of enumerateBuckets(`${startMonth}-01`, `${endMonth}-01`, 'Monthly', MAX_POINTS)) {
    running += m < startMonth ? 0 : monthly.get(m) || 0;
    points.push({ label: m, value: running });
  }
  return { kind: 'series', chart: 'line', format: 'money', points: capPoints(points), subtitle: 'Month-end balance' };
}

function flattenCategories(flow) {
  const out = [];
  for (const group of flow.groups) for (const c of group.categories) out.push({ id: c.id, label: c.label, value: c.amountCents });
  return out;
}

async function spendingCard(ctx, meta) {
  const mode = meta && meta.mode;
  const month = ctx.month;
  if (mode === 'average') {
    const months = [-3, -2, -1].map((n) => monthKey(addMonths(ctx.now, n)));
    const flows = await Promise.all(months.map((m) => loadMonthCashFlow(ctx.client, m)));
    const totals = new Map();
    for (const flow of flows) {
      for (const c of flattenCategories(flow)) {
        const e = totals.get(c.id) || { label: c.label, value: 0 };
        e.value += c.value;
        totals.set(c.id, e);
      }
    }
    const items = [...totals.values()].map((e) => ({ label: e.label, value: e.value / 3 }));
    return { kind: 'breakdown', format: 'money', ...capItems(items), subtitle: 'Average of the last 3 months' };
  }
  if (mode === 'budget') {
    const budgetMonth = await ctx.budgetMonth();
    const items = [];
    for (const group of budgetMonth.categoryGroups || []) {
      if (isIncomeGroup(group) || isTransferGroup(group)) continue;
      for (const c of group.categories || []) items.push({ label: c.name, value: Math.max(0, -(c.spent ?? 0)) });
    }
    return { kind: 'breakdown', format: 'money', ...capItems(items), subtitle: `Spent this month, ${month}` };
  }
  const flow = await loadMonthCashFlow(ctx.client, month);
  return { kind: 'breakdown', format: 'money', ...capItems(flattenCategories(flow).map((c) => ({ label: c.label, value: c.value }))), subtitle: month };
}

async function calendarCard(ctx, meta) {
  const range = await resolveTimeFrame(meta.timeFrame, ctx.now, { earliest: ctx.earliest, fallbackMonths: 1 });
  const today = fmt(startOfDay(ctx.now));
  // At most 62 days: the latest 62 of the window, never beyond today.
  const end = range.end > today && range.start <= today ? today : range.end;
  const endDate = new Date(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10)));
  const startDate = new Date(Number(range.start.slice(0, 4)), Number(range.start.slice(5, 7)) - 1, Number(range.start.slice(8, 10)));
  const floor = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - (MAX_CALENDAR_DAYS - 1));
  const from = startDate > floor ? startDate : floor;
  if (from > endDate) throw new Unsupported('empty window');
  const filter = txFilter({ start: fmt(from), end, extra: [conditionsFilter(meta.conditions, meta.conditionsOp)] });
  const daily = await dailySums(ctx.client, filter);
  const days = [];
  for (let d = from, i = 0; d <= endDate && i < MAX_CALENDAR_DAYS; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), i += 1) {
    const date = fmt(d);
    days.push({ date, value: money(daily.get(date)?.amount || 0) });
  }
  return { kind: 'calendar', days, subtitle: 'Net per day' };
}

const SERIES_CHART = { BarGraph: 'bar', StackedBarGraph: 'bar', LineGraph: 'line', AreaGraph: 'area', TableGraph: 'bar', DonutGraph: 'bar' };

function balanceFilter(balanceType) {
  if (balanceType === 'Deposit') return { amount: { $gt: 0 } };
  if (balanceType === 'Net') return null;
  return { amount: { $lt: 0 } };
}

async function customReportCard(ctx, meta) {
  const id = meta && meta.id;
  if (typeof id !== 'string') throw new Unsupported('no report id');
  const report = (await ctx.customReports()).find((r) => r.id === id && !r.tombstone);
  if (!report) throw new Unsupported('report not found');
  const parse = (v) => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      throw new Unsupported('bad json');
    }
  };
  const conditions = parse(report.conditions);
  const balanceType = report.balance_type || 'Payment';
  const sign = balanceType === 'Payment' ? -1 : 1;
  const groupBy = report.group_by || 'Category';
  const range = await resolveReportRange(report, ctx.now, { earliest: ctx.earliest });
  const extra = [
    conditionsFilter(conditions, report.conditions_op),
    balanceFilter(balanceType),
    report.show_offbudget ? null : { 'account.offbudget': false },
  ];
  const filter = txFilter({ start: range.start, end: range.end, extra, transfers: false });
  const title = report.name || meta.name || 'Report';
  const subtitle = `${range.start} to ${range.end}`;

  if (groupBy === 'Interval') {
    const interval = ['Daily', 'Weekly', 'Monthly', 'Yearly'].includes(report.interval) ? report.interval : 'Monthly';
    const sums = bucketSums(await dailySums(ctx.client, filter), interval);
    const points = enumerateBuckets(range.start, range.end, interval, MAX_POINTS).map((k) => ({ label: k, value: sign * (sums.get(k) || 0) }));
    return { kind: 'series', title, subtitle, chart: SERIES_CHART[report.graph_type] || 'bar', format: 'money', points: capPoints(points) };
  }

  if (!['Category', 'Group', 'Payee', 'Account'].includes(groupBy)) throw new Unsupported('groupBy');
  const column = { Category: 'category', Group: 'category', Payee: 'payee', Account: 'account' }[groupBy];
  const rows = await sumsBy(ctx.client, column, filter);
  const names = new Map();
  if (groupBy === 'Payee') for (const p of await ctx.payees()) names.set(p.id, p.name);
  else if (groupBy === 'Account') for (const a of await ctx.accounts()) names.set(a.id, a.name);
  else if (groupBy === 'Group') {
    for (const g of await ctx.categoryGroups()) for (const c of g.categories || []) names.set(c.id, { id: g.id, name: g.name });
  } else {
    for (const g of await ctx.categoryGroups()) for (const c of g.categories || []) names.set(c.id, c.name);
  }
  const folded = new Map();
  for (const row of rows) {
    if (groupBy === 'Category' && row.id === null && report.show_uncategorized === false) continue;
    const key = groupBy === 'Group' ? (names.get(row.id) || { id: null, name: 'Uncategorized' }) : { id: row.id, name: names.get(row.id) };
    const label = groupBy === 'Group' ? key.name : (key.name || (row.id === null ? 'Uncategorized' : 'Unknown'));
    const k = groupBy === 'Group' ? String(key.id) : String(row.id);
    const e = folded.get(k) || { label, value: 0 };
    e.value += sign * row.amount;
    folded.set(k, e);
  }
  return { kind: 'breakdown', title, subtitle, format: 'money', ...capItems([...folded.values()]) };
}

async function markdownCard(ctx, meta) {
  const placeholder = parsePlaceholder(meta.content);
  if (!placeholder) return textCard(meta);
  const builder = insightsBuilder(placeholder.name);
  if (!builder) throw new Unsupported('insights widget');
  const card = await builder.build(ctx, placeholder.config);
  return { title: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : builder.title, ...card };
}

const MAPPERS = {
  'markdown-card': { title: 'Note', build: markdownCard },
  'summary-card': { title: 'Summary', build: summaryCard },
  'cash-flow-card': { title: 'Cash flow', build: cashFlowCard },
  'net-worth-card': { title: 'Net worth', build: netWorthCard },
  'spending-card': { title: 'Spending', build: spendingCard },
  'calendar-card': { title: 'Calendar', build: calendarCard },
  'custom-report': { title: 'Report', build: customReportCard },
};

// ---- plumbing ----

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('card timed out'), { code: 'TIMEOUT' })), ms);
    if (timer.unref) timer.unref();
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseMeta(meta) {
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      return {};
    }
  }
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
}

function makeContext(client, now) {
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) {
      const p = Promise.resolve().then(fn);
      p.catch(() => {});
      memo.set(key, p);
    }
    return memo.get(key);
  };
  const month = monthKey(now);
  return {
    client,
    now,
    month,
    budgetMonth: () => once('budgetMonth', () => client.getBudgetMonth(month)),
    accounts: () => once('accounts', async () => (await client.getAccounts()) || []),
    payees: () => once('payees', async () => (await client.getPayees()) || []),
    categoryGroups: () => once('categoryGroups', async () => (await client.getCategoryGroups()) || []),
    customReports: () => once('customReports', async () => ((await client.aqlQuery(q('custom_reports').select('*'))).data) || []),
    earliest: () =>
      once('earliest', async () => {
        const { data } = await client.aqlQuery(q('transactions').filter({ tombstone: false }).orderBy({ date: 'asc' }).select(['date']).limit(1));
        return data && data[0] && data[0].date;
      }),
  };
}

async function readWidgets(client) {
  const pages = ((await client.aqlQuery(q('dashboard_pages').select('*'))).data || []).filter((p) => !p.tombstone);
  const pageId = pages.length > 0 ? pages[0].id : null;
  const rows = ((await client.aqlQuery(q('dashboard').select('*'))).data || []).filter(
    (w) => w && !w.tombstone && (pageId === null || !w.dashboard_page_id || w.dashboard_page_id === pageId)
  );
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  rows.sort((a, b) => n(a.y) - n(b.y) || n(a.x) - n(b.x) || String(a.id).localeCompare(String(b.id)));
  return rows.slice(0, MAX_CARDS);
}

function cardId(widget, index, used) {
  let id = typeof widget.id === 'string' && ID_PATTERN.test(widget.id) ? widget.id : clip(String(widget.id ?? '').replace(/[^A-Za-z0-9_-]/g, '_'), 64);
  if (!ID_PATTERN.test(id)) id = `w${index}`;
  if (used.has(id)) id = `${id.slice(0, 56)}_${index}`;
  used.add(id);
  return id;
}

async function buildCard(ctx, widget, id, timeoutMs) {
  const meta = parseMeta(widget.meta);
  const mapper = MAPPERS[widget.type];
  const fallbackTitle = clip(meta.name || (mapper && mapper.title) || 'Widget');
  const unsupported = (title) => ({ id, kind: 'unsupported', title: clip(title || fallbackTitle) });
  if (!mapper) return unsupported();
  try {
    const built = await withTimeout(Promise.resolve().then(() => mapper.build(ctx, meta)), timeoutMs);
    const { title, subtitle, ...rest } = built;
    const card = { id, title: clip(title || fallbackTitle), ...rest };
    if (subtitle) card.subtitle = clip(subtitle);
    if (card.kind === 'list') {
      card.rows = card.rows.slice(0, MAX_ITEMS).map((r) => {
        const row = { title: clip(r.title), value: money(r.value) };
        if (r.subtitle) row.subtitle = clip(r.subtitle);
        if (r.date) row.date = r.date;
        return row;
      });
    }
    if (card.kind === 'calendar') card.days = card.days.map((d) => ({ date: d.date, value: money(d.value) }));
    if (card.kind === 'progress') {
      card.items = card.items.slice(0, MAX_ITEMS).map((i) => ({ label: clip(i.label), current: money(i.current), target: money(i.target) }));
    }
    if (card.kind === 'breakdown' && (card.total === undefined || card.items.length > MAX_ITEMS)) Object.assign(card, capItems(card.items));
    if (card.kind === 'stat') {
      card.value = statNumber(card.value, card.format);
      if (card.compare) card.compare = { value: statNumber(card.compare.value, card.format), label: clip(card.compare.label) };
    }
    return card;
  } catch (err) {
    // The code only: a message could echo budget data.
    console.error(`reports: ${widget.type} card unavailable:`, err && err.code ? err.code : 'unexpected error');
    return unsupported();
  }
}

async function buildReports({ client, now = new Date(), cardTimeoutMs = CARD_TIMEOUT_MS } = {}) {
  const widgets = await readWidgets(client);
  const ctx = makeContext(client, now);
  const used = new Set();
  const ids = widgets.map((w, i) => cardId(w, i, used));
  const cards = await Promise.all(widgets.map((w, i) => buildCard(ctx, w, ids[i], cardTimeoutMs)));
  return { schema: 1, generatedAt: now.toISOString(), cards };
}

module.exports = { buildReports, stripMarkdown, CARD_TIMEOUT_MS, MAX_CARDS };
