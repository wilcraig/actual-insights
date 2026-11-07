
const { upcomingOccurrences } = require('../../bills-data');
const { isIncomeGroup, isTransferGroup, loadMonthCashFlow } = require('../../cash-flow-data');
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
  return { items, allGroups: Boolean(object && config.allGroups === true) };
}

// A single category keeps its long-standing mobile numbers: spent never goes
// below zero before the carryover-aware available amount is worked out.
function categoryRow(c) {
  const spent = Math.max(0, spentOf(c));
  return { label: c.name, current: spent, target: Math.max(0, (c.balance ?? 0) + spent), drill: { level: 'payees', categoryId: c.id } };
}

function rollupRow(title, members) {
  return {
    label: title,
    current: Math.max(0, members.reduce((sum, c) => sum + spentOf(c), 0)),
    target: Math.max(0, members.reduce((sum, c) => sum + availableOf(c), 0)),
    drill: { level: 'categories', categoryIds: members.map((c) => c.id).slice(0, MAX_DRILL_IDS) },
  };
}

async function pacingBars(ctx, config) {
  const { items: picked, allGroups } = parsePacingConfig(config);
  const budgetMonth = await ctx.budgetMonth();
  const byId = new Map();
  for (const group of budgetMonth.categoryGroups || []) for (const c of group.categories || []) byId.set(c.id, c);
  const items = [];

  if (allGroups) {
    // One rollup per visible expense group with something in it; a group added
    // later shows up by itself.
    for (const group of budgetMonth.categoryGroups || []) {
      if (group.hidden || isIncomeGroup(group) || isTransferGroup(group)) continue;
      const members = (group.categories || []).filter((c) => !c.hidden);
      if (members.length > 0) items.push(rollupRow(group.name, members));
    }
  }

  if (picked.length > 0) {
    for (const item of picked) {
      if (typeof item === 'string') {
        const c = byId.get(item);
        if (!c) continue;
        items.push(categoryRow(c));
      } else {
        const members = item.budgets.map((id) => byId.get(id)).filter(Boolean);
        if (members.length > 0) items.push(rollupRow(item.title, members));
      }
    }
  } else if (!allGroups) {
    // No selection at all: every spending category with something available.
    for (const group of budgetMonth.categoryGroups || []) {
      if (isIncomeGroup(group) || isTransferGroup(group)) continue;
      for (const c of group.categories || []) {
        const row = categoryRow(c);
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

// Spent so far this month against what is budgeted (the burn-rate widget's
// two lines, as a number and a comparison).
async function burnRate(ctx) {
  const cats = spendingCategories(await ctx.budgetMonth());
  const spent = cats.reduce((sum, c) => sum + -(c.spent ?? 0), 0);
  const budgeted = cats.reduce((sum, c) => sum + (c.budgeted ?? 0), 0);
  return { kind: 'stat', value: spent, format: 'money', subtitle: `Spent so far, ${ctx.month}`, compare: { value: budgeted, label: 'Budgeted' } };
}

// Percent with one decimal of precision (a stat 'percent' is 0-100).
async function savingsRate(ctx, config) {
  const investment = new Set(asIdList(config));
  const flow = await loadMonthCashFlow(ctx.client, ctx.month);
  const investmentCents = flow.groups.filter((g) => investment.has(g.id)).reduce((sum, g) => sum + g.amountCents, 0);
  if (flow.incomeCents === 0) throw new Unsupported('no income');
  const rate = (flow.incomeCents - flow.spendingCents + investmentCents) / flow.incomeCents;
  return { kind: 'stat', value: Math.round(rate * 1000) / 10, format: 'percent', subtitle: `Savings rate, ${ctx.month}` };
}

async function spendingDonut(ctx, config) {
  const only = new Set(asIdList(config));
  const flow = await loadMonthCashFlow(ctx.client, ctx.month);
  const items = flow.groups.filter((g) => only.size === 0 || only.has(g.id)).map((g) => ({ label: g.label, value: g.amountCents }));
  return { kind: 'breakdown', format: 'money', items, subtitle: ctx.month };
}

async function accountBalances(ctx, config) {
  const only = new Set(Array.isArray(config) ? asIdList(config) : asIdList(config && config.accountIds));
  const open = (await ctx.accounts()).filter((a) => !a.closed && (only.size === 0 || only.has(a.id)));
  const items = [];
  for (const account of open) {
    items.push({ label: account.name, value: await ctx.client.getAccountBalance(account.id) });
  }
  return { kind: 'breakdown', format: 'money', items };
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
  'spending-treemap': { title: 'Spending by group', build: (ctx) => spendingDonut(ctx, []) },
  'account-balances': { title: 'Account balances', build: accountBalances },
  'spending-heatmap': { title: 'Spending calendar', build: spendingHeatmap },
};

// null when the placeholder names a widget with no mobile form.
function insightsBuilder(name) {
  return Object.prototype.hasOwnProperty.call(BUILDERS, name) ? BUILDERS[name] : null;
}

module.exports = { parsePlaceholder, insightsBuilder };
