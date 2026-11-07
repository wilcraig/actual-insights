
const { isIncomeGroup, isTransferGroup, loadMonthCashFlow, savingsRateFromFlow } = require('../../cash-flow-data');
const { dateRange } = require('../../aql-date-range');
const { loadBurnRate } = require('../../burn-rate-data');
const { loadAccountBalances } = require('../../account-balances-data');
const { loadPaycheckAlerts } = require('../../paycheck-alerts-data');
const { loadUnlinkedTransfers } = require('../../unlinked-transfers-data');
const { buildOccurrences, loadScheduleData, upcomingOccurrences } = require('../../bills-data');
const { monthBounds, baseFilterFor, breakdownByGroups } = require('../../spending-data');
const { buildSankey } = require('./reports-sankey');
const { readGoals } = require('../../goals-store');
const { computeMonthEndProjection } = require('../../month-end-data');
const { Unsupported, txFilter, dailySums } = require('./reports-query');
const { fmt, startOfDay, addDays } = require('./reports-time');

// Cards for markdown widgets that carry an Insights placeholder
// `{{INSIGHTS:<name>:<json>}}` (the legacy `{{ACTUALMINT:` prefix too). Each
// builder reuses the data code behind the matching web widget.

const PREFIXES = ['{{INSIGHTS:', '{{ACTUALMINT:'];

// Same rule as bundle/src/mount.js: the JSON body may itself end in `}`, so
// try each successive `}}` until the text between parses.
function parsePlaceholder(text) {
  if (typeof text !== 'string') return null;
  let best = null;
  for (const prefix of PREFIXES) {
    const at = text.indexOf(prefix);
    if (at !== -1 && (best === null || at < best.at)) best = { at, prefix };
  }
  if (!best) return null;
  const rest = text.slice(best.at + best.prefix.length);
  const colon = rest.indexOf(':');
  if (colon < 1) return null;
  const name = rest.slice(0, colon);
  const bodyStart = colon + 1;
  let from = bodyStart;
  for (;;) {
    const end = rest.indexOf('}}', from);
    if (end === -1) return null;
    try {
      return { name, config: JSON.parse(rest.slice(bodyStart, end)) };
    } catch {
      from = end + 1;
    }
  }
}

const asIdList = (config) => (Array.isArray(config) ? config.filter((v) => typeof v === 'string') : []);

function spendingCategories(budgetMonth) {
  const out = [];
  for (const group of budgetMonth.categoryGroups || []) {
    if (isIncomeGroup(group) || isTransferGroup(group)) continue;
    for (const category of group.categories || []) out.push({ ...category, groupId: group.id, groupName: group.name });
  }
  return out;
}

const MAX_DRILL_IDS = 200;

// What the pacing widget paces against: budget plus carryover (the web's
// `balance + spent`, with spent as positive money out).
const spentOf = (c) => -(c.spent ?? 0);
const availableOf = (c) => (c.balance ?? 0) + spentOf(c);

// The three config shapes of the placeholder body: the legacy bare array
// (category id strings and `{title, budgets}` rollups), or the object
// `{categoryIds, allGroups}` the widget builder's "Category Groups" box makes.
function parsePacingConfig(config) {
  const object = config && typeof config === 'object' && !Array.isArray(config);
  const list = Array.isArray(config) ? config : object && Array.isArray(config.categoryIds) ? config.categoryIds : [];
  const items = [];
  for (const item of list) {
    if (typeof item === 'string') items.push(item);
    else if (item && typeof item === 'object' && typeof item.title === 'string' && Array.isArray(item.budgets)) {
      items.push({ title: item.title, budgets: item.budgets.filter((v) => typeof v === 'string') });
    }
  }
  const allGroups = Boolean(object && config.allGroups === true);
  const parsed = { items, allGroups };
  if (allGroups && Array.isArray(config.groupIds)) parsed.groupIds = config.groupIds.filter((id) => typeof id === 'string');
  return parsed;
}

// A single category keeps its long-standing mobile numbers: spent never goes
// below zero before the carryover-aware available amount is worked out.
function categoryRow(c, colors) {
  const spent = Math.max(0, spentOf(c));
  return { label: c.name, current: spent, target: Math.max(0, (c.balance ?? 0) + spent), drill: { level: 'payees', categoryId: c.id }, ...colors.categoryField(c.id) };
}

// A rollup that is exactly one group's visible categories (all of them, none
// from elsewhere) carries that group's colour; any other mix has none.
function rollupColor(members, colors) {
  const groupIds = new Set(members.map((c) => colors.groupOfCategory.get(c.id)));
  if (groupIds.size !== 1) return {};
  const [groupId] = groupIds;
  if (groupId === undefined || !colors.hasGroup(groupId)) return {};
  const ids = new Set(members.map((c) => c.id));
  const whole = colors.groupCategories(groupId);
  return ids.size === whole.length && whole.every((id) => ids.has(id)) ? { color: colors.group(groupId) } : {};
}

function rollupRow(title, members, colors) {
  return {
    ...rollupColor(members, colors),
    label: title,
    current: Math.max(0, members.reduce((sum, c) => sum + spentOf(c), 0)),
    target: Math.max(0, members.reduce((sum, c) => sum + availableOf(c), 0)),
    drill: { level: 'categories', categoryIds: members.map((c) => c.id).slice(0, MAX_DRILL_IDS) },
  };
}

async function pacingBars(ctx, config) {
  const { items: picked, allGroups, groupIds } = parsePacingConfig(config);
  const budgetMonth = await ctx.budgetMonth();
  const colors = await ctx.colors();
  const byId = new Map();
  for (const group of budgetMonth.categoryGroups || []) for (const c of group.categories || []) byId.set(c.id, c);
  const items = [];

  if (allGroups) {
    // One rollup per visible expense group with something in it. Without
    // groupIds that is every group in Actual's order (a group added later shows
    // up by itself); with groupIds only those, in exactly that order, unknown
    // and repeated ids ignored.
    const eligible = new Map();
    for (const group of budgetMonth.categoryGroups || []) {
      if (group.hidden || isIncomeGroup(group) || isTransferGroup(group)) continue;
      const members = (group.categories || []).filter((c) => !c.hidden);
      if (members.length > 0) eligible.set(group.id, { name: group.name, members });
    }
    const order = groupIds ? [...new Set(groupIds)] : [...eligible.keys()];
    for (const id of order) {
      const g = eligible.get(id);
      if (g) items.push(rollupRow(g.name, g.members, colors));
    }
  }

  if (picked.length > 0) {
    for (const item of picked) {
      if (typeof item === 'string') {
        const c = byId.get(item);
        if (!c) continue;
        items.push(categoryRow(c, colors));
      } else {
        const members = item.budgets.map((id) => byId.get(id)).filter(Boolean);
        if (members.length > 0) items.push(rollupRow(item.title, members, colors));
      }
    }
  } else if (!allGroups) {
    // No selection at all: every spending category with something available.
    for (const group of budgetMonth.categoryGroups || []) {
      if (isIncomeGroup(group) || isTransferGroup(group)) continue;
      for (const c of group.categories || []) {
        const row = categoryRow(c, colors);
        if (row.target > 0) items.push(row);
      }
    }
  }
  return { kind: 'progress', format: 'money', items, subtitle: ctx.month };
}

async function goalThermometers(ctx, config) {
  const only = new Set(asIdList(config));
  const goals = await readGoals();
  const items = [];
  let accounts = null;
  let categories = null;
  for (const goal of goals) {
    if (goal.entityType === 'account') {
      if (only.size > 0) continue;
      accounts = accounts || (await ctx.accounts());
      const account = accounts.find((a) => a.id === goal.entityId);
      if (!account) continue;
      items.push({ label: account.name, current: await ctx.client.getAccountBalance(account.id), target: goal.targetAmountCents });
    } else if (goal.entityType === 'category') {
      if (only.size > 0 && !only.has(goal.entityId)) continue;
      if (!categories) {
        categories = new Map();
        for (const group of (await ctx.budgetMonth()).categoryGroups || []) {
          for (const c of group.categories || []) categories.set(c.id, c);
        }
      }
      const category = categories.get(goal.entityId);
      if (!category) continue;
      items.push({ label: category.name, current: category.balance ?? 0, target: goal.targetAmountCents });
    }
  }
  return { kind: 'progress', format: 'money', items };
}

async function billsTimeline(ctx) {
  const today = startOfDay(ctx.now);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const rows = (await upcomingOccurrences(ctx.client, today, monthEnd))
    .filter((o) => Number.isFinite(o.amountCents))
    .map((o) => ({ title: o.name || o.payeeName || 'Bill', subtitle: o.accountName || undefined, date: o.date, value: Math.round(o.amountCents) }));
  return { kind: 'list', rows, subtitle: 'Rest of this month' };
}

async function monthEndNet(ctx) {
  const projection = await computeMonthEndProjection(ctx.client, ctx.month);
  return { kind: 'stat', value: projection.projectedNetCents, format: 'money', subtitle: `Projected net, ${ctx.month}` };
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TRANSFER_GROUP = /^transfers?$/i;

// group id -> the drill that opens that group's categories: its visible
// (not hidden) category ids, at most 200. A group with none has no entry.
async function groupDrills(ctx) {
  const drills = new Map();
  for (const group of await ctx.categoryGroups()) {
    const ids = (group.categories || []).filter((c) => !c.hidden && ID_PATTERN.test(String(c.id))).map((c) => c.id).slice(0, MAX_DRILL_IDS);
    if (ids.length > 0) drills.set(group.id, { level: 'categories', categoryIds: ids });
  }
  return drills;
}

// Burn rate as the web chart draws it: the cumulative spend per day through
// today ("Spent so far", then gaps) against the straight line from 0 on day 1
// to the month's budget on the last day ("Even pace"). Labels are the days of
// the month. Numbers come from loadBurnRate, the code behind /api/burn-rate.
async function burnRate(ctx) {
  const data = await loadBurnRate(ctx.client, ctx.month, ctx.now);
  const { monthEnd } = monthBounds(ctx.month);
  const lastDay = Number(monthEnd.slice(8, 10));
  const labels = [];
  const spent = [];
  const pace = [];
  const byDay = new Map(data.days.map((d) => [Number(d.date.slice(8, 10)), d.cumulativeSpendCents]));
  for (let day = 1; day <= lastDay; day += 1) {
    labels.push(String(day));
    spent.push(byDay.has(day) ? byDay.get(day) : null);
    // The web's targetValueAt(): elapsed days over (last day - first day).
    pace.push(lastDay > 1 ? Math.round((data.budgetedCents * (day - 1)) / (lastDay - 1)) : data.budgetedCents);
  }
  return {
    kind: 'multiseries',
    chart: 'line',
    format: 'money',
    labels,
    series: [
      { name: 'Spent so far', values: spent },
      { name: 'Even pace', values: pace },
    ],
    subtitle: `Spent so far, ${ctx.month}`,
  };
}

// Savings rate as the web gauge draws it: the whole-percent label, the fill
// clamped to the 0..100 axis, red below 0, amber below 20, green from 20.
async function savingsRate(ctx, config) {
  const flow = await loadMonthCashFlow(ctx.client, ctx.month);
  const { rate } = savingsRateFromFlow(flow, asIdList(config));
  if (rate === null) throw new Unsupported('no income');
  const percent = Math.round(rate * 100);
  const bands = [
    { from: 0, to: 20, tone: 'warn' },
    { from: 20, to: 100, tone: 'good' },
  ];
  if (percent < 0) bands.unshift({ from: 0, to: 0, tone: 'bad' });
  return {
    kind: 'gauge',
    value: Math.max(0, Math.min(100, percent)),
    min: 0,
    max: 100,
    format: 'percent',
    caption: `Net savings rate: ${percent}%`,
    bands,
    subtitle: ctx.month,
  };
}

// The groups level of the web donut/treemap (/api/spending-breakdown with
// level=groups): this month's spending per expense group, a user-made
// Transfers group left out, each slice opening that group's categories.
async function spendingDonut(ctx, config) {
  const { monthStart, monthEnd } = monthBounds(ctx.month);
  const [slices, drills, colors] = await Promise.all([
    breakdownByGroups(ctx.client, baseFilterFor(dateRange(monthStart, monthEnd)), asIdList(config)),
    groupDrills(ctx),
    ctx.colors(),
  ]);
  const items = slices
    .filter((s) => !TRANSFER_GROUP.test(String(s.label).trim()))
    .map((s) => ({ label: s.label, value: s.amountCents, ...(drills.has(s.id) ? { drill: drills.get(s.id) } : {}), ...colors.groupField(s.id) }));
  return { kind: 'breakdown', chart: 'donut', format: 'money', items, subtitle: ctx.month };
}

// The web chart's default view: the last month (1M) of daily balances, one
// band per open account, combined (stacked). accountIds as in the placeholder.
// Beyond 12 accounts the contract's series cap folds the smallest into one.
async function accountBalances(ctx, config) {
  const ids = Array.isArray(config) ? asIdList(config) : asIdList(config && config.accountIds);
  const data = await loadAccountBalances(ctx.client, '1M', ids, ctx.now);
  const labels = data.netWorth.map((p) => p.date);
  let series = data.accounts.map((a) => ({ name: a.name, values: a.points.map((p) => p.balanceCents), total: a.points.length ? a.points[a.points.length - 1].balanceCents : 0 }));
  if (series.length > 12) {
    const ranked = [...series].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    const keep = new Set(ranked.slice(0, 11));
    const rest = series.filter((x) => !keep.has(x));
    series = series.filter((x) => keep.has(x));
    series.push({ name: 'Other accounts', values: labels.map((_, i) => rest.reduce((sum, x) => sum + x.values[i], 0)) });
  }
  return {
    kind: 'multiseries',
    chart: 'stackedArea',
    format: 'money',
    labels,
    series: series.map(({ name, values }) => ({ name, values })),
    subtitle: `${data.rangeStart} to ${data.rangeEnd}`,
  };
}

// The same numbers as SpendingSankey: this month's cash flow.
async function spendingSankey(ctx) {
  const flow = await loadMonthCashFlow(ctx.client, ctx.month);
  return { kind: 'sankey', format: 'money', ...buildSankey(flow), subtitle: ctx.month };
}

// Same rules as bundle/src/widgets/radar-data.js (parseRadarConfig and
// excludeCategories); that file is ESM for the browser bundle, so the two
// small functions are mirrored here and pinned by tests.
function parseRadarConfig(config) {
  const object = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  return {
    layout: object.layout === 'vertical' ? 'vertical' : 'horizontal',
    excludeCategoryIds: Array.isArray(object.excludeCategoryIds) ? object.excludeCategoryIds.filter((id) => typeof id === 'string') : [],
  };
}

function excludeCategories(items, excludeCategoryIds) {
  if (!excludeCategoryIds || excludeCategoryIds.length === 0) return items;
  const excluded = new Set(excludeCategoryIds);
  return items.filter((item) => typeof item.categoryId !== 'string' || !item.categoryId || !excluded.has(item.categoryId));
}

const RADAR_WINDOW_DAYS = 30;

// The web radar's window (today through 30 days on) and items (the bills
// timeline's occurrences, minus excluded categories), as a timeline.
async function subscriptionRadar(ctx, config) {
  const { layout, excludeCategoryIds } = parseRadarConfig(config);
  const today = startOfDay(ctx.now);
  const windowEnd = addDays(today, RADAR_WINDOW_DAYS);
  const endStr = fmt(windowEnd);
  const data = await loadScheduleData(ctx.client);
  const occurrences = buildOccurrences(data, today, new Date(windowEnd.getFullYear(), windowEnd.getMonth(), windowEnd.getDate(), 23, 59, 59, 999));
  const items = excludeCategories(occurrences.filter((o) => o.date <= endStr && Number.isFinite(o.amountCents)), excludeCategoryIds).map((o) => ({
    date: o.date,
    title: o.payeeName || o.scheduleName || 'Renewal',
    ...(o.groupName ? { subtitle: o.groupName } : {}),
    value: Math.round(o.amountCents),
  }));
  return { kind: 'timeline', layout, start: fmt(today), end: endStr, items, subtitle: 'Next 30 days' };
}

// The web banner's rows: "<n> <schedule> paychecks this month (~x.x/month
// average)". value is the paycheck amount.
async function paycheckAlerts(ctx) {
  const { alerts, currentMonth } = await loadPaycheckAlerts(ctx.client, ctx.now);
  const rows = alerts.map((a) => ({
    title: `${a.occurrences} ${a.scheduleName} paychecks ${a.month === currentMonth ? 'this month' : 'next month'}`,
    subtitle: `~${a.averagePerMonth.toFixed(1)}/month average`,
    value: Math.round(a.amountPerOccurrenceCents),
  }));
  return { kind: 'list', rows };
}

// Pairs the web widget lists, one row each: the two account names, the earlier
// date, the amount. (The web data carries no payee, so the title is the route.)
async function unlinkedTransfers(ctx) {
  const data = await loadUnlinkedTransfers(ctx.client, ctx.now);
  const rows = data.candidates.map((c) => ({
    title: `${c.first.accountName || 'Account'} to ${c.second.accountName || 'account'}`,
    subtitle: c.first.date === c.second.date ? c.first.date : `${c.first.date} and ${c.second.date}`,
    date: c.first.date,
    value: Math.round(c.amountCents),
  }));
  return { kind: 'list', rows, subtitle: 'Last 180 days' };
}

// Daily spending for the last `days` days ending today, by the same rules as
// the spending-calendar route (income and Transfers groups taken back out).
async function spendingHeatmap(ctx, config) {
  const range = typeof config === 'string' ? config : config && config.range;
  // A calendar card holds at most 62 days, so the 12-month view shows the latest 62.
  const days = range === 'year' ? 62 : 30;
  const today = startOfDay(ctx.now);
  const start = fmt(addDays(today, -(days - 1)));
  const end = fmt(today);
  const base = [{ 'category.group.is_income': false }];
  const filter = txFilter({ start, end, extra: base, transfers: false });
  const groups = (await ctx.categoryGroups()).filter((g) => !g.is_income && (isTransferGroup(g) || isIncomeGroup(g)));
  const [all, removed] = await Promise.all([
    dailySums(ctx.client, filter),
    groups.length > 0
      ? dailySums(ctx.client, txFilter({ start, end, extra: [...base, { 'category.group': { $oneof: groups.map((g) => g.id) } }], transfers: false }))
      : Promise.resolve(new Map()),
  ]);
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = fmt(addDays(today, -i));
    const net = (all.get(date)?.amount || 0) - (removed.get(date)?.amount || 0);
    out.push({ date, value: -net });
  }
  return { kind: 'calendar', days: out, subtitle: `Spending, last ${days} days` };
}

const BUILDERS = {
  'pacing-bars': { title: 'Budget pacing', build: pacingBars },
  'savings-goals-thermometers': { title: 'Savings goals', build: goalThermometers },
  'bills-timeline': { title: 'Upcoming bills', build: billsTimeline },
  'upcoming-bills': { title: 'Upcoming bills', build: billsTimeline },
  'month-end-net': { title: 'Month-end net', build: monthEndNet },
  'burn-rate': { title: 'Spending so far', build: burnRate },
  'savings-rate-gauge': { title: 'Savings rate', build: savingsRate },
  'spending-breakdown-donut': { title: 'Spending by group', build: spendingDonut },
  donut: { title: 'Spending by group', build: spendingDonut },
  'spending-treemap': { title: 'Spending by group', build: async (ctx) => ({ ...(await spendingDonut(ctx, [])), chart: 'treemap' }) },
  'spending-sankey': { title: 'Where the money flows', build: spendingSankey },
  'subscription-radar': { title: 'Subscription renewals', build: subscriptionRadar },
  'paycheck-alerts': { title: 'Paycheck alerts', build: paycheckAlerts },
  'unlinked-transfers': { title: 'Unlinked transfers', build: unlinkedTransfers },
  'account-balances': { title: 'Account balances', build: accountBalances },
  'spending-heatmap': { title: 'Spending calendar', build: spendingHeatmap },
};

// null when the placeholder names a widget with no mobile form.
function insightsBuilder(name) {
  return Object.prototype.hasOwnProperty.call(BUILDERS, name) ? BUILDERS[name] : null;
}

module.exports = { parsePlaceholder, insightsBuilder, groupDrills, parseRadarConfig, excludeCategories };
