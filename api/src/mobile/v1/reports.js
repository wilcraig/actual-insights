const { q } = require('@actual-app/api');

const { isIncomeGroup, isTransferGroup, loadMonthCashFlow } = require('../../cash-flow-data');
const { parsePlaceholder, insightsBuilder, groupDrills } = require('./reports-insights');
const { notFound } = require('./common');
const { loadExclusions, notInClause, adjustBudgetMonth } = require('./exclusions');
const { isColorKey, createColorResolver } = require('./colors');
const { readColors } = require('../../mobile-colors-store');
const { Unsupported, conditionsFilter, txFilter, dailySums, bucketSums, sumsBy, sumsByDateAnd } = require('./reports-query');
const { addMonths, bucketKey: bucketKeyOf, enumerateBuckets, fmt, lastMonths, monthKey, monthsInRange, resolveReportRange, resolveTimeFrame, startOfDay } = require('./reports-time');

// GET /reports for the native clients: the Actual dashboard's widgets, each
// computed server-side and shaped as one card (see the native client API
// spec, "Reports: how dashboard widgets become cards"). A widget that cannot
// be shown, or whose data fails or takes too long, becomes an `unsupported`
// card that keeps its title; one bad card never hides the rest.

const MAX_CARDS = 40;
const MAX_POINTS = 400;
const MAX_ITEMS = 60;
const MAX_SERIES_CARD = 12;
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
  const clean = items
    .filter((i) => i.value !== 0)
    .map((i) => ({ label: clip(i.label || 'Uncategorized'), value: money(i.value), ...(i.drill ? { drill: i.drill } : {}), ...(isColorKey(i.color) ? { color: i.color } : {}) }));
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

// Income and spending per month by the Insights rules (the same numbers as
// the savings rate and the Sankey), last 6 months unless the widget says more.
async function cashFlowCard(ctx, meta) {
  const range = meta && meta.timeFrame ? await resolveTimeFrame(meta.timeFrame, ctx.now, { earliest: ctx.earliest, fallbackMonths: 6 }) : lastMonths(ctx.now, 6);
  const months = enumerateBuckets(range.start, range.end, 'Monthly', 24);
  const flows = await Promise.all(months.map((m) => loadMonthCashFlow(ctx.client, m)));
  return {
    kind: 'multiseries',
    chart: 'bar',
    format: 'money',
    labels: months,
    series: [
      { name: 'Income', values: flows.map((f) => f.incomeCents) },
      { name: 'Expenses', values: flows.map((f) => f.spendingCents) },
    ],
    subtitle: 'Income and expenses',
  };
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

// A category slice opens that category's payees.
function categoryDrill(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) ? { drill: { level: 'payees', categoryId: id } } : {};
}

function flattenCategories(flow) {
  const out = [];
  for (const group of flow.groups) for (const c of group.categories) out.push({ id: c.id, label: c.label, value: c.amountCents });
  return out;
}

async function spendingCard(ctx, meta) {
  const colors = await ctx.colors();
  const mode = meta && meta.mode;
  const month = ctx.month;
  if (mode === 'average') {
    const months = [-3, -2, -1].map((n) => monthKey(addMonths(ctx.now, n)));
    const flows = await Promise.all(months.map(async (m) => loadMonthCashFlow(ctx.client, m, { exclude: await ctx.excludeMonth(m) })));
    const totals = new Map();
    for (const flow of flows) {
      for (const c of flattenCategories(flow)) {
        const e = totals.get(c.id) || { label: c.label, value: 0 };
        e.value += c.value;
        totals.set(c.id, e);
      }
    }
    const items = [...totals.entries()].map(([id, e]) => ({ label: e.label, value: e.value / 3, ...categoryDrill(id), ...colors.categoryField(id) }));
    return { kind: 'breakdown', chart: 'donut', format: 'money', ...capItems(items), subtitle: 'Average of the last 3 months' };
  }
  if (mode === 'budget') {
    const budgetMonth = await ctx.budgetMonth();
    const items = [];
    for (const group of budgetMonth.categoryGroups || []) {
      if (isIncomeGroup(group) || isTransferGroup(group)) continue;
      for (const c of group.categories || []) items.push({ label: c.name, value: Math.max(0, -(c.spent ?? 0)), ...categoryDrill(c.id), ...colors.categoryField(c.id) });
    }
    return { kind: 'breakdown', chart: 'donut', format: 'money', ...capItems(items), subtitle: `Spent this month, ${month}` };
  }
  const flow = await loadMonthCashFlow(ctx.client, month, { exclude: await ctx.excludeMonth(month) });
  return { kind: 'breakdown', chart: 'donut', format: 'money', ...capItems(flattenCategories(flow).map((c) => ({ label: c.label, value: c.value, ...categoryDrill(c.id), ...colors.categoryField(c.id) }))), subtitle: month };
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

// A grouped (non-interval) bar/donut report keeps the graph the author picked
// when it has a native drawing; any other graph type leaves the default (bars).
const BREAKDOWN_CHART = { DonutGraph: 'donut', BarGraph: 'bars' };

// One series over intervals (groupBy Interval).
const SERIES_CHART = { BarGraph: 'bar', StackedBarGraph: 'bar', LineGraph: 'line', AreaGraph: 'area', TableGraph: 'bar', DonutGraph: 'bar' };

// Several groups over intervals: what the web's stacked bar, line and area
// graphs draw (a plain bar graph with groups is one bar per group, which stays
// a breakdown).
const MULTI_CHART = { StackedBarGraph: 'stackedBar', LineGraph: 'line', AreaGraph: 'stackedArea' };

const MAX_SERIES = 12;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 200;

function balanceFilter(balanceType) {
  if (balanceType === 'Deposit') return { amount: { $gt: 0 } };
  if (balanceType === 'Net') return null;
  return { amount: { $lt: 0 } };
}

const parseJson = (v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    throw new Unsupported('bad json');
  }
};

// Resolves a grouped row's id to the group it belongs to: { key, label,
// drill? }, or null when the row is skipped. Category -> its payees; Group ->
// that group's categories; Payee, Account have nothing to open.
async function groupResolver(ctx, groupBy, report) {
  const names = new Map();
  let drills = null;
  const colors = await ctx.colors();
  if (groupBy === 'Payee') for (const p of await ctx.payees()) names.set(p.id, p.name);
  else if (groupBy === 'Account') for (const a of await ctx.accounts()) names.set(a.id, a.name);
  else if (groupBy === 'Group') {
    for (const g of await ctx.categoryGroups()) for (const c of g.categories || []) names.set(c.id, { id: g.id, name: g.name });
    drills = await groupDrills(ctx);
  } else {
    for (const g of await ctx.categoryGroups()) for (const c of g.categories || []) names.set(c.id, c.name);
  }
  return (id) => {
    if (groupBy === 'Category' && id === null && report.show_uncategorized === false) return null;
    if (groupBy === 'Group') {
      const g = names.get(id);
      if (!g) return { key: 'none', label: 'Uncategorized' };
      return { key: String(g.id), label: g.name, ...(drills.has(g.id) ? { drill: drills.get(g.id) } : {}), ...colors.groupField(g.id) };
    }
    const name = names.get(id);
    return {
      key: String(id),
      label: name || (id === null ? 'Uncategorized' : 'Unknown'),
      ...(groupBy === 'Category' ? { ...categoryDrill(id), ...colors.categoryField(id) } : {}),
    };
  };
}

// Several groups over intervals: bucket -> value per group. More than the
// contract's 12 series folds the smallest into "Other".
function groupSeries(rows, resolve, sign, interval, buckets) {
  const index = new Map(buckets.map((b, i) => [b, i]));
  const groups = new Map();
  for (const row of rows) {
    const group = resolve(row.id);
    if (!group) continue;
    const at = index.get(bucketKeyOf(row.date, interval));
    if (at === undefined) continue;
    const e = groups.get(group.key) || { name: group.label, values: buckets.map(() => 0) };
    e.values[at] += sign * row.amount;
    groups.set(group.key, e);
  }
  const total = (e) => e.values.reduce((sum, v) => sum + Math.abs(v), 0);
  let series = [...groups.values()].filter((e) => total(e) > 0).sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name));
  if (series.length > MAX_SERIES) {
    const rest = series.slice(MAX_SERIES - 1);
    series = series.slice(0, MAX_SERIES - 1);
    series.push({ name: 'Other', values: buckets.map((_, i) => rest.reduce((sum, e) => sum + e.values[i], 0)) });
  }
  return series;
}

// Interval table: a row per interval with deposits, payments and net.
async function intervalTable(ctx, report, range, baseExtra, interval, title, subtitle) {
  const make = (balance) => txFilter({ start: range.start, end: range.end, extra: [...baseExtra, balance], transfers: false });
  const [deposits, payments] = await Promise.all([
    dailySums(ctx.client, make({ amount: { $gt: 0 } })).then((d) => bucketSums(d, interval)),
    dailySums(ctx.client, make({ amount: { $lt: 0 } })).then((d) => bucketSums(d, interval)),
  ]);
  const buckets = enumerateBuckets(range.start, range.end, interval, MAX_TABLE_ROWS);
  const rows = buckets.map((b) => {
    const d = deposits.get(b) || 0;
    const p = -(payments.get(b) || 0);
    return { label: b, values: [d, p, d - p] };
  });
  const totals = [0, 1, 2].map((i) => rows.reduce((sum, r) => sum + r.values[i], 0));
  return { kind: 'table', title, subtitle, format: 'money', columns: ['Deposits', 'Payments', 'Net'], rows, totals };
}

// Grouped table: a row per group, a column per interval (when they fit) and a Total.
function groupTable(rows, resolve, sign, interval, buckets, title, subtitle) {
  const perInterval = buckets.length <= MAX_TABLE_COLUMNS - 1;
  const index = new Map(buckets.map((b, i) => [b, i]));
  const groups = new Map();
  for (const row of rows) {
    const group = resolve(row.id);
    if (!group) continue;
    const e = groups.get(group.key) || { label: group.label, values: buckets.map(() => 0), total: 0 };
    const at = index.get(bucketKeyOf(row.date, interval));
    if (at !== undefined) e.values[at] += sign * row.amount;
    e.total += sign * row.amount;
    groups.set(group.key, e);
  }
  const list = [...groups.values()].filter((e) => e.total !== 0 || e.values.some((v) => v !== 0)).sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.label.localeCompare(b.label));
  const body = list.slice(0, MAX_TABLE_ROWS).map((e) => ({ label: e.label, values: perInterval ? [...e.values, e.total] : [e.total] }));
  const width = perInterval ? buckets.length + 1 : 1;
  const totals = Array.from({ length: width }, (_, i) => list.reduce((sum, e) => sum + (perInterval ? [...e.values, e.total][i] : e.total), 0));
  return { kind: 'table', title, subtitle, format: 'money', columns: perInterval ? [...buckets, 'Total'] : ['Total'], rows: body, totals };
}

async function customReportCard(ctx, meta) {
  const id = meta && meta.id;
  if (typeof id !== 'string') throw new Unsupported('no report id');
  const report = (await ctx.customReports()).find((r) => r.id === id && !r.tombstone);
  if (!report) throw new Unsupported('report not found');
  const conditions = parseJson(report.conditions);
  const balanceType = report.balance_type || 'Payment';
  const sign = balanceType === 'Payment' ? -1 : 1;
  const groupBy = report.group_by || 'Category';
  const graph = report.graph_type;
  const range = await resolveReportRange(report, ctx.now, { earliest: ctx.earliest });
  // A report by account is about real money; every other one leaves excluded and hidden transactions out.
  const exclude = groupBy === 'Account' ? null : await ctx.excludeClause(range.start, range.end);
  const baseExtra = [conditionsFilter(conditions, report.conditions_op), report.show_offbudget ? null : { 'account.offbudget': false }, exclude];
  const filter = txFilter({ start: range.start, end: range.end, extra: [...baseExtra, balanceFilter(balanceType)], transfers: false });
  const title = report.name || meta.name || 'Report';
  const subtitle = `${range.start} to ${range.end}`;
  const interval = ['Daily', 'Weekly', 'Monthly', 'Yearly'].includes(report.interval) ? report.interval : 'Monthly';

  if (groupBy === 'Interval') {
    if (graph === 'TableGraph') return intervalTable(ctx, report, range, baseExtra, interval, title, subtitle);
    const sums = bucketSums(await dailySums(ctx.client, filter), interval);
    const points = enumerateBuckets(range.start, range.end, interval, MAX_POINTS).map((k) => ({ label: k, value: sign * (sums.get(k) || 0) }));
    return { kind: 'series', title, subtitle, chart: SERIES_CHART[graph] || 'bar', format: 'money', points: capPoints(points) };
  }

  if (!['Category', 'Group', 'Payee', 'Account'].includes(groupBy)) throw new Unsupported('groupBy');
  const column = { Category: 'category', Group: 'category', Payee: 'payee', Account: 'account' }[groupBy];
  const resolve = await groupResolver(ctx, groupBy, report);

  if (graph === 'TableGraph' || MULTI_CHART[graph]) {
    const buckets = enumerateBuckets(range.start, range.end, interval, MAX_POINTS);
    const rows = await sumsByDateAnd(ctx.client, column, filter);
    if (graph === 'TableGraph') return groupTable(rows, resolve, sign, interval, buckets, title, subtitle);
    return { kind: 'multiseries', title, subtitle, chart: MULTI_CHART[graph], format: 'money', labels: buckets, series: groupSeries(rows, resolve, sign, interval, buckets) };
  }

  const rows = await sumsBy(ctx.client, column, filter);
  const folded = new Map();
  for (const row of rows) {
    const group = resolve(row.id);
    if (!group) continue;
    const e = folded.get(group.key) || { label: group.label, value: 0, ...(group.drill ? { drill: group.drill } : {}), ...(group.color ? { color: group.color } : {}) };
    e.value += sign * row.amount;
    folded.set(group.key, e);
  }
  const chart = BREAKDOWN_CHART[graph];
  return { kind: 'breakdown', title, subtitle, ...(chart ? { chart } : {}), format: 'money', ...capItems([...folded.values()]) };
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
  const exclusions = () => once('exclusions', () => loadExclusions(client));
  return {
    client,
    now,
    month,
    // Excluded and hidden transactions are added back to spent/balance, so every
    // pacing and spending view built on this reads the adjusted figures.
    budgetMonth: () => once('budgetMonth', async () => adjustBudgetMonth(await client.getBudgetMonth(month), await exclusions(), month)),
    // An AQL clause leaving out the excluded/hidden transactions dated in
    // [start, end] (or one 'YYYY-MM'), null when there are none.
    excludeClause: async (start, end) => notInClause((await exclusions()).idsBetween(start, end)),
    excludeMonth: async (m) => notInClause((await exclusions()).idsBetween(`${m}-01`, `${m}-31`)),
    accounts: () => once('accounts', async () => (await client.getAccounts()) || []),
    payees: () => once('payees', async () => (await client.getPayees()) || []),
    colors: () => once('colors', async () => createColorResolver((await client.getCategoryGroups()) || [], await readColors())),
    categoryGroups: () => once('categoryGroups', async () => (await client.getCategoryGroups()) || []),
    customReports: () => once('customReports', async () => ((await client.aqlQuery(q('custom_reports').select('*'))).data) || []),
    earliest: () =>
      once('earliest', async () => {
        const { data } = await client.aqlQuery(q('transactions').filter({ tombstone: false }).orderBy({ date: 'asc' }).select(['date']).limit(1));
        return data && data[0] && data[0].date;
      }),
  };
}

async function readPages(client) {
  return ((await client.aqlQuery(q('dashboard_pages').select('*'))).data || []).filter((p) => p && !p.tombstone);
}

async function readWidgets(client, pages, pageId) {
  const rows = ((await client.aqlQuery(q('dashboard').select('*'))).data || []).filter(
    (w) => w && !w.tombstone && (pageId === null || !w.dashboard_page_id || w.dashboard_page_id === pageId)
  );
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  rows.sort((a, b) => n(a.y) - n(b.y) || n(a.x) - n(b.x) || String(a.id).localeCompare(String(b.id)));
  return rows.slice(0, MAX_CARDS);
}

async function readCustomReports(client) {
  return ((await client.aqlQuery(q('custom_reports').select('*'))).data || []).filter((r) => r && !r.tombstone);
}

function cardId(widget, index, used) {
  let id = typeof widget.id === 'string' && ID_PATTERN.test(widget.id) ? widget.id : clip(String(widget.id ?? '').replace(/[^A-Za-z0-9_-]/g, '_'), 64);
  if (!ID_PATTERN.test(id)) id = `w${index}`;
  if (used.has(id)) id = `${id.slice(0, 56)}_${index}`;
  used.add(id);
  return id;
}

// A drill is passed through only in the exact shapes the contract allows.
function cleanDrill(drill) {
  if (!drill || typeof drill !== 'object') return null;
  if (drill.level === 'payees' && ID_PATTERN.test(String(drill.categoryId))) return { level: 'payees', categoryId: drill.categoryId };
  if (drill.level === 'categories' && Array.isArray(drill.categoryIds)) {
    const ids = [...new Set(drill.categoryIds.filter((id) => typeof id === 'string' && ID_PATTERN.test(id)))].slice(0, 200);
    if (ids.length > 0) return { level: 'categories', categoryIds: ids };
  }
  return null;
}

// Contract limits and rounding for the chart kinds added after v1's first
// cut (gauge, multiseries, sankey, timeline, table). Mutates the card.
function shapeChartCard(card) {
  const cell = (v, format) => (v === null || v === undefined ? null : statNumber(v, format));
  if (card.kind === 'gauge') {
    card.value = statNumber(card.value, 'percent');
    card.min = statNumber(card.min, 'percent');
    card.max = statNumber(card.max, 'percent');
    if (card.caption) card.caption = clip(card.caption);
    else delete card.caption;
    card.bands = (card.bands || []).slice(0, 6).map((b) => ({ from: statNumber(b.from, 'percent'), to: statNumber(b.to, 'percent'), tone: b.tone }));
    if (card.bands.length === 0) delete card.bands;
  } else if (card.kind === 'multiseries') {
    card.labels = card.labels.slice(-MAX_POINTS).map((l) => clip(l));
    const n = card.labels.length;
    card.series = card.series.slice(0, MAX_SERIES_CARD).map((s) => ({ name: clip(s.name), values: s.values.slice(-n).map((v) => cell(v, card.format)) }));
  } else if (card.kind === 'sankey') {
    card.nodes = card.nodes.map((n) => ({ id: n.id, label: clip(n.label), column: n.column }));
    card.links = card.links.map((l) => ({ source: l.source, target: l.target, value: money(l.value) })).filter((l) => l.value > 0);
  } else if (card.kind === 'timeline') {
    card.items = card.items.slice(0, 100).map((i) => {
      const item = { date: i.date, title: clip(i.title), value: money(i.value) };
      if (i.subtitle) item.subtitle = clip(i.subtitle);
      return item;
    });
  } else if (card.kind === 'table') {
    card.columns = card.columns.slice(0, 12).map((c) => clip(c));
    const n = card.columns.length;
    card.rows = card.rows.slice(0, 200).map((r) => ({ label: clip(r.label), values: r.values.slice(0, n).map((v) => statNumber(v, card.format)) }));
    if (card.totals) card.totals = card.totals.slice(0, n).map((v) => statNumber(v, card.format));
  }
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
      card.items = card.items.slice(0, MAX_ITEMS).map((i) => {
        const item = { label: clip(i.label), current: money(i.current), target: money(i.target) };
        const drill = cleanDrill(i.drill);
        if (drill) item.drill = drill;
        if (isColorKey(i.color)) item.color = i.color;
        return item;
      });
    }
    if (card.kind === 'breakdown') {
      if (card.total === undefined || card.items.length > MAX_ITEMS) Object.assign(card, capItems(card.items));
      card.items = card.items.map((i) => {
        const { drill, ...rest } = i;
        const clean = cleanDrill(drill);
        return clean ? { ...rest, drill: clean } : rest;
      });
    }
    shapeChartCard(card);
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

// Everything the Home menu can show: each dashboard page in page order, then
// each saved custom report. Ids the contract would not accept are skipped.
async function buildReportList({ client, now = new Date() } = {}) {
  const [pages, customs] = await Promise.all([readPages(client), readCustomReports(client)]);
  const reports = [];
  for (const page of pages) {
    if (typeof page.id === 'string' && ID_PATTERN.test(page.id)) reports.push({ id: page.id, title: clip(page.name || 'Dashboard'), kind: 'dashboard' });
  }
  const defaultId = reports.length > 0 ? reports[0].id : null;
  for (const report of customs) {
    if (typeof report.id === 'string' && ID_PATTERN.test(report.id)) reports.push({ id: report.id, title: clip(report.name || 'Report'), kind: 'custom' });
  }
  return { schema: 1, generatedAt: now.toISOString(), reports: reports.slice(0, 100), defaultId };
}

// reportId: omitted = the first dashboard page; a dashboard page id = that
// page's widgets; a custom report id = one card. Anything else is a 404.
async function buildReports({ client, now = new Date(), cardTimeoutMs = CARD_TIMEOUT_MS, reportId } = {}) {
  const pages = await readPages(client);
  const ctx = makeContext(client, now);
  let widgets;
  if (reportId === undefined) {
    widgets = await readWidgets(client, pages, pages.length > 0 ? pages[0].id : null);
  } else if (pages.some((p) => p.id === reportId)) {
    widgets = await readWidgets(client, pages, reportId);
  } else if ((await readCustomReports(client)).some((r) => r.id === reportId)) {
    widgets = [{ id: reportId, type: 'custom-report', meta: { id: reportId } }];
  } else {
    throw notFound();
  }
  const used = new Set();
  const ids = widgets.map((w, i) => cardId(w, i, used));
  const cards = await Promise.all(widgets.map((w, i) => buildCard(ctx, w, ids[i], cardTimeoutMs)));
  return { schema: 1, generatedAt: now.toISOString(), cards };
}

module.exports = { buildReports, buildReportList, stripMarkdown, CARD_TIMEOUT_MS, MAX_CARDS };
