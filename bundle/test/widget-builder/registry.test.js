import { WIDGET_REGISTRY } from '../../src/widget-builder/registry';

test('registers every widget with a mount.js consumer, and nothing unimplemented', () => {
  expect(WIDGET_REGISTRY).toEqual([
    { id: 'pacing-bars', label: 'Pacing bars', toBody: expect.any(Function), fields: [
      { key: 'categoryIds', type: 'category-multiselect', label: 'Categories', optionalWhen: 'allGroups' },
      { key: 'allGroups', type: 'checkbox', label: 'Category Groups', help: expect.any(String) },
    ] },
    { id: 'month-end-net', label: 'Projected month-end net', fields: [] },
    { id: 'paycheck-alerts', label: 'Paycheck alerts (3-paycheck months)', fields: [] },
    { id: 'bills-timeline', label: 'Bills / autopay timeline', fields: [] },
    { id: 'account-balances', label: 'Account balances chart', fields: [
      { key: 'accountIds', type: 'account-multiselect', label: 'Accounts' },
      { key: 'labelContent', type: 'select', label: 'Combined-view band label', options: [
        { value: 'both', label: 'Balance + account name' },
        { value: 'amount', label: 'Balance only' },
        { value: 'name', label: 'Account name only' },
      ] },
    ] },
    { id: 'unlinked-transfers', label: 'Unlinked transfers (possible double-counted income/expense)', fields: [] },
    { id: 'spending-breakdown-donut', label: 'Spending breakdown donut', fields: [] },
    { id: 'savings-goals-thermometers', label: 'Sinking fund goals (thermometers)', fields: [
      { key: 'categoryIds', type: 'category-multiselect', label: 'Categories' },
    ] },
    { id: 'burn-rate', label: 'Cumulative burn rate (pacing slope)', fields: [] },
    { id: 'savings-rate-gauge', label: 'Net savings rate gauge', fields: [
      { key: 'investmentGroupIds', type: 'group-multiselect', label: 'Count as savings (not spending)', optional: true },
    ] },
    { id: 'spending-sankey', label: 'Monthly Sankey (Income → Group → Category)', fields: [] },
    { id: 'spending-treemap', label: 'Spending treemap', fields: [] },
    { id: 'subscription-radar', label: 'Subscription renewal radar', fields: [] },
    { id: 'spending-heatmap', label: 'Spending intensity calendar heatmap', fields: [
      { key: 'range', type: 'select', label: 'Range', options: [
        { value: 'month', label: 'Last 30 days' },
        { value: 'year', label: 'Last 12 months' },
      ] },
    ] },
  ]);
});

test('the Category Groups checkbox has one short helper sentence', () => {
  const field = WIDGET_REGISTRY.find((w) => w.id === 'pacing-bars').fields.find((f) => f.key === 'allGroups');
  expect(field.label).toBe('Category Groups');
  expect(field.help).toMatch(/one pacing bar per category group/);
  expect(field.help.split('. ').length).toBe(1);
});
