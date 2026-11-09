vi.mock('../../src/chipmunk/chipmunk-api', async (orig) => ({
  ...(await orig()),
  getMode: vi.fn(), setMode: vi.fn(), getReportList: vi.fn(), getReports: vi.fn(), getAccounts: vi.fn(), getTransactions: vi.fn(),
  suggest: vi.fn(), getBudget: vi.fn(), getSeriesList: vi.fn(), saveSeries: vi.fn(), stopSeries: vi.fn(),
}));
import * as api from '../../src/chipmunk/chipmunk-api';
import { setChipmunkMode } from '../../src/chipmunk/mode-state';
import ChipmunkModeRow from '../../src/chipmunk/ChipmunkModeRow.svelte';
import ReportsTab from '../../src/chipmunk/ReportsTab.svelte';
import AccountsTab from '../../src/chipmunk/AccountsTab.svelte';
import TransactionsTab from '../../src/chipmunk/TransactionsTab.svelte';
import BudgetTab from '../../src/chipmunk/BudgetTab.svelte';
import InsightsPage from '../../src/insights-page/InsightsPage.svelte';

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
let app;
const host = () => document.getElementById('host');
async function mount(Comp, props = {}) {
  document.body.innerHTML = '<div id="host"></div>';
  app = new Comp({ target: host(), props });
  await flush();
  return host();
}
const click = async (el) => { el.click(); await flush(); };
const byText = (root, text, sel = 'button') => [...root.querySelectorAll(sel)].find((b) => b.textContent.trim().includes(text));
const input = async (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); await flush(); };

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  setChipmunkMode({ enabled: false, entitled: false });
});
afterEach(() => { try { app?.$destroy?.(); } catch {} });

describe('ChipmunkModeRow', () => {
  test('hidden when the server answer is unusable', async () => {
    api.getMode.mockResolvedValue([]);
    expect((await mount(ChipmunkModeRow)).querySelector('input')).toBeNull();
    api.getMode.mockRejectedValue(new Error('x'));
    expect((await mount(ChipmunkModeRow)).querySelector('input')).toBeNull();
  });
  test('toggles through the API and publishes the state', async () => {
    api.getMode.mockResolvedValue({ enabled: false, entitled: true, reason: 'unlicensed-dev' });
    api.setMode.mockResolvedValue({ enabled: true, entitled: true, reason: 'unlicensed-dev' });
    const h = await mount(ChipmunkModeRow);
    const box = h.querySelector('#insights-chipmunk-mode');
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(api.setMode).toHaveBeenCalledWith(true);
    const { getChipmunkMode } = await import('../../src/chipmunk/mode-state');
    expect(getChipmunkMode().enabled).toBe(true);
  });
  test('disabled with a reason when not entitled; a failed save is shown', async () => {
    api.getMode.mockResolvedValue({ enabled: false, entitled: false, reason: 'expired' });
    let h = await mount(ChipmunkModeRow);
    expect(h.querySelector('input').disabled).toBe(true);
    expect(h.textContent).toContain('Open Chipmunk (iPhone, Mac or Android) once with a current subscription to unlock this');
    expect(h.textContent).toContain('has run out');
    expect(h.textContent).not.toContain('Test mode');
    api.getMode.mockResolvedValue({ enabled: false, entitled: true });
    api.setMode.mockRejectedValue(new Error('boom'));
    h = await mount(ChipmunkModeRow);
    h.querySelector('input').checked = true;
    h.querySelector('input').dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(h.textContent).toContain('boom');
  });
});

describe('ChipmunkModeRow subscription state', () => {
  test('entitled: says who verified it, when, and until when', async () => {
    api.getMode.mockResolvedValue({ enabled: false, entitled: true, reason: 'verified', lastVerifiedAt: '2026-11-09T21:00:00.000Z', validUntil: '2026-12-16T21:00:00.000Z', mode: 'strict' });
    const h = await mount(ChipmunkModeRow);
    expect(h.querySelector('input').disabled).toBe(false);
    expect(h.textContent).toMatch(/Verified by your Chipmunk app on .*2026.*; the app re-checks daily \(valid until .*2026.*\)/);
    expect(h.textContent).not.toContain('Test mode');
  });
  test.each([['none', 'No Chipmunk subscription has been confirmed yet'], ['unverified', 'could not be verified'], ['not_configured', 'cannot check that store']])(
    'not entitled (%s): friendly reason, toggle disabled', async (reason, text) => {
      api.getMode.mockResolvedValue({ enabled: false, entitled: false, reason, lastVerifiedAt: null, validUntil: null, mode: 'strict' });
      const h = await mount(ChipmunkModeRow);
      expect(h.querySelector('input').disabled).toBe(true);
      expect(h.textContent).toContain(text);
    });
  test.each(['dev', 'open'])('%s mode shows a Test mode note', async (mode) => {
    api.getMode.mockResolvedValue({ enabled: false, entitled: true, reason: 'verified', lastVerifiedAt: null, validUntil: null, mode });
    const h = await mount(ChipmunkModeRow);
    expect(h.textContent).toContain('Test mode');
    expect(h.textContent).not.toContain('Verified by your Chipmunk app');
  });
  test('an older server without the new fields still renders', async () => {
    api.getMode.mockResolvedValue({ enabled: false, entitled: true, reason: 'unlicensed-dev' });
    const h = await mount(ChipmunkModeRow);
    expect(h.querySelector('input').disabled).toBe(false);
    expect(h.textContent).not.toContain('Test mode');
  });
});

describe('InsightsPage tabs', () => {
  test('off: the five original tabs only', async () => {
    const h = await mount(InsightsPage, { tabId: 'general' });
    expect([...h.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim())).toEqual(['General', 'Summaries', 'Channels', 'Forecast', 'Mobile app']);
  });
  test('on: Chipmunk tabs in front, and turning it on live adds them', async () => {
    api.getReportList.mockResolvedValue({ reports: [], defaultId: null });
    api.getReports.mockResolvedValue({ cards: [] });
    const h = await mount(InsightsPage, { tabId: 'reports' });
    setChipmunkMode({ enabled: true, entitled: true });
    await flush();
    expect([...h.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim()).slice(0, 5)).toEqual(['Reports', 'Accounts', 'Transactions', 'Budget', 'General']);
  });
});

describe('ReportsTab', () => {
  const list = { reports: [{ id: 'p1', title: 'Main' }, { id: 'p2', title: 'Other' }], defaultId: 'p1' };
  const donut = (month, value) => ({ id: 'c1', kind: 'breakdown', title: 'Spending', format: 'money', chart: 'donut', total: value, items: [{ label: 'Food', value }], monthNav: { month, earliest: '2020-01' } });

  test('title dropdown lists reports, default first, and the pick is remembered', async () => {
    api.getReportList.mockResolvedValue(list);
    api.getReports.mockResolvedValue({ cards: [{ id: 's', kind: 'stat', title: 'Income', value: 12345, format: 'money' }] });
    const h = await mount(ReportsTab);
    const sel = h.querySelector('select');
    expect([...sel.options].map((o) => o.text)).toEqual(['Main', 'Other']);
    expect(api.getReports).toHaveBeenLastCalledWith({ report: 'p1' });
    expect(h.textContent).toContain('$123.45');
    sel.value = 'p2';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(api.getReports).toHaveBeenLastCalledWith({ report: 'p2' });
    expect(localStorage.getItem('insights:chipmunk:report')).toBe('p2');
  });

  test('a remembered report that still exists is used', async () => {
    localStorage.setItem('insights:chipmunk:report', 'p2');
    api.getReportList.mockResolvedValue(list);
    api.getReports.mockResolvedValue({ cards: [] });
    const h = await mount(ReportsTab);
    expect(api.getReports).toHaveBeenLastCalledWith({ report: 'p2' });
    expect(h.textContent).toContain('No reports yet');
  });

  test('month arrows load that month for the card, and a failure is shown on it', async () => {
    const now = new Date();
    const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prev = `${now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()}-${String(now.getMonth() === 0 ? 12 : now.getMonth()).padStart(2, '0')}`;
    api.getReportList.mockResolvedValue(list);
    api.getReports.mockImplementation(async ({ month } = {}) => ({ cards: [donut(month ?? cur, month ? 111 : 999)] }));
    const h = await mount(ReportsTab);
    expect(h.querySelector('.next').disabled).toBe(true);
    await click(h.querySelector('.prev'));
    expect(api.getReports).toHaveBeenLastCalledWith({ report: 'p1', month: prev });
    expect(h.querySelector('.donut text').textContent).toBe('$1.11');
    api.getReports.mockRejectedValue(new Error('nope'));
    await click(h.querySelector('.prev'));
    expect(h.querySelector('.err').textContent).toBe('nope');
  });

  test('every card kind renders without throwing, unknown ones with a placeholder', async () => {
    api.getReportList.mockResolvedValue(list);
    api.getReports.mockResolvedValue({ cards: [
      { id: '1', kind: 'text', title: 'T', text: 'hello' },
      { id: '2', kind: 'series', title: 'S', format: 'money', chart: 'bar', points: [{ label: 'Jun', value: 5 }, { label: 'Jul', value: -2 }] },
      { id: '3', kind: 'progress', title: 'P', format: 'money', items: [{ label: 'Groceries', current: 5, target: 10 }] },
      { id: '4', kind: 'list', title: 'L', rows: [{ title: 'Bill', date: '2026-11-13', value: -100 }] },
      { id: '5', kind: 'gauge', title: 'G', value: 20, min: 0, max: 100, format: 'percent' },
      { id: '6', kind: 'table', title: 'Tb', format: 'money', columns: ['A'], rows: [{ label: 'r', values: [1] }] },
      { id: '7', kind: 'calendar', title: 'C', days: [{ date: '2026-11-01', value: 100 }] },
      { id: '8', kind: 'multiseries', title: 'M', chart: 'line', format: 'money', labels: ['a'], series: [{ name: 'x', values: [null, 5] }] },
      { id: '9', kind: 'sankey', title: 'Sk', format: 'money', nodes: [], links: [] },
      { id: '10', kind: 'unsupported', title: 'U' },
    ] });
    const h = await mount(ReportsTab);
    expect(h.querySelectorAll('section.card')).toHaveLength(10);
    expect(h.textContent).toContain('hello');
    expect(h.querySelector('[data-kind=unsupported]').textContent).toContain("Reports page");
  });

  test('a failing list shows the error', async () => {
    api.getReportList.mockRejectedValue(new Error('down'));
    expect((await mount(ReportsTab)).querySelector('.err').textContent).toBe('down');
  });
});

describe('AccountsTab', () => {
  const resp = { accounts: [
    { id: 'a1', name: 'Checking', balance: 100000, onBudget: true, groupId: 'g1' },
    { id: 'a2', name: 'Card', balance: -5000, onBudget: true, groupId: null },
  ], groups: [{ id: 'g1', name: 'Cash', balance: 100000 }] };

  test('groups start collapsed, open on click, are remembered, balances are green/red', async () => {
    api.getAccounts.mockResolvedValue(resp);
    let h = await mount(AccountsTab);
    expect(h.querySelector('.group .inner')).toBeNull();
    expect(h.querySelector('.group .bal').classList.contains('positive')).toBe(true);
    expect(h.querySelector('li.account .bal').classList.contains('negative')).toBe(true);
    await click(h.querySelector('.group .head'));
    expect(h.querySelector('.group .inner').textContent).toContain('Checking');
    expect(JSON.parse(localStorage.getItem('insights:chipmunk:expandedGroups'))).toEqual(['g1']);
    app.$destroy();
    h = await mount(AccountsTab);
    expect(h.querySelector('.group .inner')).not.toBeNull();
    await click(h.querySelector('.group .head'));
    expect(h.querySelector('.group .inner')).toBeNull();
  });
  test('error and empty states', async () => {
    api.getAccounts.mockRejectedValue(new Error('bad'));
    expect((await mount(AccountsTab)).querySelector('.err').textContent).toBe('bad');
    api.getAccounts.mockResolvedValue({ accounts: [], groups: [] });
    expect((await mount(AccountsTab)).textContent).toContain('No open accounts');
  });
});

describe('TransactionsTab', () => {
  const tx = (id, over = {}) => ({ id, date: '2026-11-01', accountId: 'a', accountName: 'A', payee: `Shop ${id}`, amount: -1000, category: { id: 'c', name: 'Food' }, categoryGroup: 'Usual', split: false, transfer: false, color: 'green', ...over });
  beforeEach(() => {
    api.getAccounts.mockResolvedValue({ accounts: [{ id: 'a', name: 'Checking' }] });
    api.getTransactions.mockResolvedValue({ transactions: [tx('t1'), tx('t2', { category: null, categoryGroup: null })], nextCursor: 'c_2026-11-01_t2', uncategorizedCount: 3 });
  });

  test('lists rows (Group > Category / Uncategorized) and pages', async () => {
    const h = await mount(TransactionsTab);
    expect(h.querySelectorAll('.tx')).toHaveLength(2);
    expect(h.textContent).toContain('Usual > Food');
    expect(h.textContent).toContain('Uncategorized');
    api.getTransactions.mockResolvedValue({ transactions: [tx('t3')], nextCursor: null });
    await click(h.querySelector('.more'));
    expect(api.getTransactions).toHaveBeenLastCalledWith('limit=50&cursor=c_2026-11-01_t2');
    expect(h.querySelectorAll('.tx')).toHaveLength(3);
    expect(h.querySelector('.more')).toBeNull();
  });

  test('typeahead: choose filters to that item, + adds, chips remove', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      api.suggest.mockResolvedValue({ merchants: [{ id: 'p1', name: 'Safeway' }], categories: [{ id: 'c1', name: 'Groceries', groupName: 'Usual' }] });
      document.body.innerHTML = '<div id="host"></div>';
      app = new TransactionsTab({ target: host() });
      await vi.advanceTimersByTimeAsync(10);
      const search = host().querySelector('.search');
      search.value = 'sa';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
      expect(api.suggest).toHaveBeenCalledWith('sa', 8);
      expect(host().querySelectorAll('.suggest .pick').length).toBe(3);
      [...host().querySelectorAll('.suggest .pick')][0].click();
      await vi.advanceTimersByTimeAsync(10);
      expect(api.getTransactions).toHaveBeenLastCalledWith('payees=p1&limit=50');
      expect(host().querySelector('.chips').textContent).toContain('Safeway');
      search.value = 'gr';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
      host().querySelector('.suggest .add[aria-label*="Groceries"]').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(api.getTransactions).toHaveBeenLastCalledWith('categories=c1&payees=p1&limit=50');
      host().querySelector('.chips .chip').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(api.getTransactions.mock.calls.at(-1)[0]).not.toContain('categories');
    } finally {
      vi.useRealTimers();
    }
  });

  test('Enter applies free text; clearing the field removes it; suggest failure is tolerated', async () => {
    const h = await mount(TransactionsTab);
    const search = h.querySelector('.search');
    search.value = 'coffee';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    h.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(api.getTransactions).toHaveBeenLastCalledWith('q=coffee&limit=50');
    await input(search, '');
    expect(api.getTransactions.mock.calls.at(-1)[0]).toBe('limit=50');
  });

  test('filter panel: Uncategorized with its count', async () => {
    api.suggest.mockResolvedValue({ merchants: [], categories: [] });
    const h = await mount(TransactionsTab);
    await click(h.querySelector('.filter-btn'));
    expect(h.querySelector('.panel').textContent).toContain('Uncategorized (3)');
    const box = h.querySelector('.panel input[type=checkbox]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(api.getTransactions).toHaveBeenLastCalledWith('uncategorized=1&limit=50');
    expect(h.querySelector('.chips').textContent).toContain('Uncategorized');
  });

  test('error state', async () => {
    api.getTransactions.mockRejectedValue(new Error('bad'));
    expect((await mount(TransactionsTab)).querySelector('.err').textContent).toBe('bad');
  });
});

describe('BudgetTab and series', () => {
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const budget = { totals: { toBudget: 1000, budgeted: 50000, spent: 20000, balance: 30000, income: 0 }, groups: [
    { id: 'g1', name: 'Usual', color: 'blue', budgeted: 50000, spent: 20000, balance: 30000, categories: [
      { id: 'c1', name: 'Groceries', budgeted: 45000, spent: 20000, balance: 25000, color: 'blue' },
      { id: 'c2', name: 'Fuel', budgeted: 5000, spent: 0, balance: 5000, color: 'blue' },
    ] },
  ] };
  const series = { id: 'ser-1', categoryId: 'c2', categoryName: 'Fuel', amount: 5000, startMonth: cur, mode: 'indefinite', months: null, untilMonth: null, endMonth: null, appliedThrough: cur };
  beforeEach(() => {
    api.getBudget.mockResolvedValue(budget);
    api.getSeriesList.mockResolvedValue({ series: [series] });
  });

  test('groups collapsed first; categories show the repeat marker; month arrows reload', async () => {
    const h = await mount(BudgetTab);
    expect(h.querySelector('.cat')).toBeNull();
    await click(h.querySelector('.head'));
    expect(h.querySelectorAll('.cat')).toHaveLength(2);
    expect(h.querySelector('[data-category-id=c2]').textContent).toContain('Repeats every month');
    expect(h.querySelector('[data-category-id=c1]').textContent).not.toContain('Repeats');
    await click(h.querySelector('.prev'));
    expect(api.getBudget.mock.calls.at(-1)[0]).not.toBe(cur);
  });

  test('repeat: Review runs a dry run, shows each month, Confirm writes', async () => {
    api.saveSeries.mockImplementation(async (body) => body.dryRun
      ? { dryRun: true, changes: [{ month: cur, before: 45000, after: 50000 }, { month: '2099-01', before: 0, after: 50000 }] }
      : { dryRun: false });
    const h = await mount(BudgetTab);
    await click(h.querySelector('.head'));
    await click(h.querySelector('[data-category-id=c1] .repeat-btn'));
    const form = h.querySelector('.series-form');
    await input(form.querySelector('.amount'), '500.00');
    await click(form.querySelector('.review'));
    expect(api.saveSeries).toHaveBeenLastCalledWith({ amount: 50000, startMonth: cur, mode: 'months', categoryId: 'c1', months: 3, dryRun: true }, null);
    expect(h.querySelectorAll('.changes tbody tr')).toHaveLength(2);
    expect(api.saveSeries).toHaveBeenCalledTimes(1);
    await click(h.querySelector('.confirm'));
    expect(api.saveSeries).toHaveBeenLastCalledWith({ amount: 50000, startMonth: cur, mode: 'months', categoryId: 'c1', months: 3 }, null);
    expect(h.querySelector('.series-form')).toBeNull();
  });

  test('indefinite mode sends no months; bad amount blocks; 409 explains', async () => {
    const h = await mount(BudgetTab);
    await click(h.querySelector('.head'));
    await click(h.querySelector('[data-category-id=c1] .repeat-btn'));
    const form = h.querySelector('.series-form');
    await input(form.querySelector('.amount'), 'abc');
    await click(form.querySelector('.review'));
    expect(api.saveSeries).not.toHaveBeenCalled();
    expect(form.querySelector('.err').textContent).toContain('Enter an amount');
    await input(form.querySelector('.amount'), '10');
    const mode = form.querySelector('.mode');
    mode.value = 'indefinite';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    const err = Object.assign(new Error('conflict'), { status: 409 });
    api.saveSeries.mockRejectedValue(err);
    await click(form.querySelector('.review'));
    expect(api.saveSeries.mock.calls[0][0]).toEqual({ amount: 1000, startMonth: cur, mode: 'indefinite', categoryId: 'c1', dryRun: true });
    expect(form.querySelector('.err').textContent).toContain('already has a series');
  });

  test('existing series: edit uses PUT by id without categoryId; stop asks first then deletes', async () => {
    api.saveSeries.mockResolvedValue({ dryRun: true, changes: [{ month: cur, before: 5000, after: 6000 }] });
    api.stopSeries.mockResolvedValue({ ok: true });
    const h = await mount(BudgetTab);
    await click(h.querySelector('.head'));
    await click(h.querySelector('[data-category-id=c2] .repeat-btn'));
    const form = h.querySelector('.series-form');
    expect(form.querySelector('h4').textContent).toContain('Edit series');
    await input(form.querySelector('.amount'), '60');
    await click(form.querySelector('.review'));
    expect(api.saveSeries).toHaveBeenLastCalledWith({ amount: 6000, startMonth: cur, mode: 'indefinite', dryRun: true }, 'ser-1');
    await click(h.querySelector('.back'));
    await click(h.querySelector('.stop'));
    expect(api.stopSeries).not.toHaveBeenCalled();
    expect(h.textContent).toContain('keep their amounts');
    await click(h.querySelector('.stop-confirm'));
    expect(api.stopSeries).toHaveBeenCalledWith('ser-1');
  });

  test('error state', async () => {
    api.getBudget.mockRejectedValue(new Error('bad'));
    expect((await mount(BudgetTab)).querySelector('.err').textContent).toBe('bad');
  });
});
