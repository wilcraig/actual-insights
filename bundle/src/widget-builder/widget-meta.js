// What the builder shows about each widget beyond its fields: a line of help
// text for the picker, and the size the widget gets when it is added to the
// dashboard (grid columns of 12 and rows, the units Actual's own dashboard
// uses; an Actual Text widget starts at 4 x 2, which is too small for a chart).
// Kept apart from registry.js so adding a widget there never needs this file:
// anything missing here falls back to DEFAULT_META.

export const DEFAULT_META = { description: '', size: { w: 6, h: 4 } };

const WIDGET_META = {
  'pacing-bars': {
    description: 'Spent versus budget for each category you pick, or for every category group.',
    size: { w: 6, h: 4 },
  },
  'month-end-net': {
    description: 'Where income minus spending is heading by the end of the month.',
    size: { w: 4, h: 2 },
  },
  'paycheck-alerts': {
    description: 'A banner for months with three paychecks, so the extra one is not spent by accident.',
    size: { w: 6, h: 2 },
  },
  'bills-timeline': {
    description: 'Upcoming bills and autopays laid out along the days of the month.',
    size: { w: 8, h: 4 },
  },
  'account-balances': {
    description: 'Balance history for the accounts you pick, as a stacked area or lines.',
    size: { w: 8, h: 5 },
  },
  'account-balance-list': {
    description: 'Current balance of each account you pick, with an optional total.',
    size: { w: 4, h: 4 },
  },
  'unlinked-transfers': {
    description: 'Transactions that look like transfers between your own accounts but were never linked.',
    size: { w: 6, h: 4 },
  },
  'spending-breakdown-donut': {
    description: 'This month\'s spending by category group, with a drill-down into each category.',
    size: { w: 6, h: 5 },
  },
  'savings-goals-thermometers': {
    description: 'Progress toward the savings goals you set on the Insights page.',
    size: { w: 6, h: 5 },
  },
  'burn-rate': {
    description: 'Cumulative spending through the month against the pace that fits your budget.',
    size: { w: 6, h: 4 },
  },
  'savings-rate-gauge': {
    description: 'The share of income you are keeping this month.',
    size: { w: 4, h: 4 },
  },
  'spending-sankey': {
    description: 'Where this month\'s money came from and where it went: income, group, category.',
    size: { w: 12, h: 6 },
  },
  'spending-treemap': {
    description: 'This month\'s spending as nested blocks, sized by amount, with group-to-category drill-down.',
    size: { w: 8, h: 5 },
  },
  'subscription-radar': {
    description: 'Recurring charges and when each renews.',
    size: { w: 8, h: 4 },
  },
  'spending-heatmap': {
    description: 'A calendar shaded by how much you spent each day.',
    size: { w: 8, h: 4 },
  },
};

export function metaFor(widgetId) {
  return { ...DEFAULT_META, ...(WIDGET_META[widgetId] ?? {}) };
}
