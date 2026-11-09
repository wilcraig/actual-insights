vi.mock('../../src/chipmunk/chipmunk-api', async (orig) => ({
  ...(await orig()),
  getMode: vi.fn(), setMode: vi.fn(), getReportList: vi.fn(), getReports: vi.fn(), getAccounts: vi.fn(), getTransactions: vi.fn(),
  suggest: vi.fn(), getBudget: vi.fn(), getSeriesList: vi.fn(), saveSeries: vi.fn(), stopSeries: vi.fn(),
  patchTransactions: vi.fn(), setBudgeted: vi.fn(), moveBudget: vi.fn(),
}));
import * as api from '../../src/chipmunk/chipmunk-api';
import TransactionsTab from '../../src/chipmunk/TransactionsTab.svelte';
import BudgetTab from '../../src/chipmunk/BudgetTab.svelte';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
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
const typeInto = async (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); await flush(); };
const keydown = async (el, init) => { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); await flush(); };
const tx = (id, over = {}) => ({ id, date: '2026-11-01', amount: -1000, payee: `Payee ${id}`, category: null, color: 'blue', ...over });

afterEach(() => { try { app?.$destroy?.(); } catch {} });
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  api.getTransactions.mockResolvedValue({ transactions: [tx('t1'), tx('t2', { date: '2026-10-01' }), tx('t3', { date: '2026-09-01' })], nextCursor: null, uncategorizedCount: 0 });
  api.getAccounts.mockResolvedValue({ accounts: [] });
  api.suggest.mockResolvedValue({ payees: [], categories: [] });
  api.getBudget.mockResolvedValue({ totals: { toBudget: 0, budgeted: 0, spent: 0, balance: 0 }, groups: [{ id: 'g1', name: 'Usual', color: 'blue', budgeted: 50000, spent: 0, balance: 50000, categories: [{ id: 'c1', name: 'Groceries', budgeted: 45000, spent: 0, balance: 45000, color: 'blue' }, { id: 'c2', name: 'Fuel', budgeted: 5000, spent: 0, balance: 5000, color: 'blue' }] }] });
  api.getSeriesList.mockResolvedValue({ series: [] });
  api.patchTransactions.mockImplementation(async (ids) => ({ schema: 1, updated: ids, unchanged: [], skipped: [] }));
});

describe('bulk actions on selected transactions', () => {
  const rows = (h) => [...h.querySelectorAll('tr.tx')];
  const selectTwo = async (h) => {
    rows(h)[0].click();
    await flush();
    rows(h)[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await flush();
  };

  test('the bar appears with a selection; hide asks first in plain words, Cancel changes nothing', async () => {
    const h = await mount(TransactionsTab);
    expect(h.querySelector('.selbar')).toBeNull();
    await selectTwo(h);
    expect(h.querySelector('.selbar').textContent).toContain('2 selected');
    await click(byText(h.querySelector('.selbar'), 'Hide'));
    const dialog = h.querySelector('[role=alertdialog]');
    expect(dialog.textContent).toContain('Hide 2 transactions?');
    expect(dialog.textContent).toContain('no undo');
    expect(api.patchTransactions).not.toHaveBeenCalled();
    await click(byText(dialog, 'Cancel'));
    expect(h.querySelector('[role=alertdialog]')).toBeNull();
    expect(api.patchTransactions).not.toHaveBeenCalled();
  });

  test('Apply writes once with the selected ids, reports the outcome and reloads', async () => {
    const h = await mount(TransactionsTab);
    await selectTwo(h);
    await click(byText(h.querySelector('.selbar'), 'Hide'));
    api.getTransactions.mockClear();
    await click(byText(h.querySelector('[role=alertdialog]'), 'Apply'));
    expect(api.patchTransactions).toHaveBeenCalledTimes(1);
    const [ids, changes] = api.patchTransactions.mock.calls[0];
    expect([...ids].sort()).toEqual(['t1', 't2']);
    expect(changes).toEqual({ hidden: true });
    expect(h.querySelector('.result').textContent).toContain('2 transactions updated');
    expect(api.getTransactions).toHaveBeenCalled();
  });

  test('skipped rows are reported; an error is shown and nothing claims success', async () => {
    const h = await mount(TransactionsTab);
    await selectTwo(h);
    api.patchTransactions.mockResolvedValueOnce({ schema: 1, updated: ['t1'], unchanged: [], skipped: [{ id: 't2', reason: 'not_allowed' }] });
    await click(byText(h.querySelector('.selbar'), 'Mark cleared'));
    await click(byText(h.querySelector('[role=alertdialog]'), 'Apply'));
    expect(h.querySelector('.result').textContent).toMatch(/1 transaction updated, 1 skipped/);
    await selectTwo(h);
    api.patchTransactions.mockRejectedValueOnce(new Error('boom'));
    await click(byText(h.querySelector('.selbar'), 'Exclude'));
    await click(byText(h.querySelector('[role=alertdialog]'), 'Apply'));
    expect(h.querySelector('.err').textContent).toBe('boom');
  });

  test('Categorize: pick a category, confirm, then one write with the category id', async () => {
    const h = await mount(TransactionsTab);
    await selectTwo(h);
    await click(byText(h.querySelector('.selbar'), 'Categorize'));
    expect(api.getBudget).toHaveBeenCalled();
    const select = h.querySelector('.pickbar select');
    expect(byText(select, 'Usual > Fuel', 'option')).toBeTruthy();
    select.value = 'c2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    await click(byText(h.querySelector('.pickbar'), 'Continue'));
    expect(h.querySelector('[role=alertdialog]').textContent).toContain('Usual > Fuel');
    await click(byText(h.querySelector('[role=alertdialog]'), 'Apply'));
    expect(api.patchTransactions.mock.calls[0][1]).toEqual({ category: 'c2' });
  });

  test('large selections go in batches of at most 50', async () => {
    api.getTransactions.mockResolvedValue({ transactions: Array.from({ length: 120 }, (_, i) => tx(`t${String(i).padStart(3, '0')}`, { date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` })), nextCursor: null, uncategorizedCount: 0 });
    const h = await mount(TransactionsTab);
    rows(h)[0].click();
    await flush();
    rows(h)[119].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await flush();
    await click(byText(h.querySelector('.selbar'), 'Mark cleared'));
    await click(byText(h.querySelector('[role=alertdialog]'), 'Apply'));
    expect(api.patchTransactions.mock.calls.map((c) => c[0].length)).toEqual([50, 50, 20]);
  });

  test('right-click: selects the row, opens the menu, runs through the same confirmation; Escape closes', async () => {
    const h = await mount(TransactionsTab);
    rows(h)[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }));
    await flush();
    expect(rows(h)[2].classList.contains('sel')).toBe(true);
    const menu = document.querySelector('[role=menu]');
    expect([...menu.querySelectorAll('[role=menuitem]')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['Mark cleared', 'Hide', 'Search for this payee', 'Copy payee']));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(document.querySelector('[role=menu]')).toBeNull();
    rows(h)[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    document.querySelector('[role=menu]').querySelectorAll('[role=menuitem]')[1].click();
    await flush();
    expect(h.querySelector('[role=alertdialog]').textContent).toContain('Mark 1 transaction as cleared?');
    await click(byText(h.querySelector('[role=alertdialog]'), 'Apply'));
    expect(api.patchTransactions).toHaveBeenCalledWith(['t3'], { cleared: true });
  });

  test('the context menu keeps an existing multi-selection', async () => {
    const h = await mount(TransactionsTab);
    await selectTwo(h);
    rows(h)[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    expect(h.querySelectorAll('tr.tx.sel')).toHaveLength(2);
    expect(document.querySelector('[role=menu]').textContent).toContain('Categorize 2 transactions');
    expect(byText(document.querySelector('[role=menu]'), 'Copy payee').disabled).toBe(true);
  });

  test('Show hidden is a filter option', async () => {
    const h = await mount(TransactionsTab);
    await click(h.querySelector('.filter-btn'));
    await click([...h.querySelectorAll('.panel input[type=checkbox]')].at(-1));
    expect(api.getTransactions.mock.calls.at(-1)[0]).toContain('showHidden=1');
  });
});

describe('resizable columns', () => {
  const handle = (h, label) => h.querySelector(`[aria-label="Resize ${label} column"]`);
  test('arrow keys resize, the width is remembered, double-click resets', async () => {
    let h = await mount(TransactionsTab);
    const col = () => h.querySelectorAll('colgroup col')[1];
    expect(col().style.width).toBe('110px');
    await keydown(handle(h, 'Date'), { key: 'ArrowRight' });
    expect(col().style.width).toBe('120px');
    await keydown(handle(h, 'Date'), { key: 'ArrowRight', shiftKey: true });
    expect(col().style.width).toBe('160px');
    expect(JSON.parse(localStorage.getItem('insights:chipmunk:txColumns')).date).toBe(160);
    app.$destroy();
    h = await mount(TransactionsTab);
    expect(h.querySelectorAll('colgroup col')[1].style.width).toBe('160px');
    handle(h, 'Date').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(h.querySelectorAll('colgroup col')[1].style.width).toBe('110px');
  });
  test('dragging the handle resizes within limits', async () => {
    const h = await mount(TransactionsTab);
    const hd = handle(h, 'Amount');
    hd.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 540 }));
    await flush();
    expect(h.querySelectorAll('colgroup col')[4].style.width).toBe('150px');
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 5000 }));
    await flush();
    expect(h.querySelectorAll('colgroup col')[4].style.width).toBe('220px');
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(JSON.parse(localStorage.getItem('insights:chipmunk:txColumns')).amount).toBe(220);
  });
});

describe('budget: inline editing, move, context menu', () => {
  const cur = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; })();
  async function open() {
    const h = await mount(BudgetTab);
    await click(h.querySelector('.head'));
    return h;
  }
  const amtBtn = (h, id) => h.querySelector(`[data-category-id=${id}] .amt-btn`);
  const field = (h) => h.querySelector('.amt-input');

  test('click, type, Enter saves through the set route and refreshes', async () => {
    api.setBudgeted.mockResolvedValue({});
    const h = await open();
    await click(amtBtn(h, 'c1'));
    expect(field(h).value).toBe('450.00');
    await typeInto(field(h), '500.00');
    await keydown(field(h), { key: 'Enter' });
    expect(api.setBudgeted).toHaveBeenCalledWith(cur, 'c1', 50000);
    expect(field(h)).toBeNull();
    expect(api.getBudget).toHaveBeenCalledTimes(2); // load + refresh
  });
  test('Escape cancels without writing; an unchanged value does not write; junk shows an error and stays open', async () => {
    const h = await open();
    await click(amtBtn(h, 'c1'));
    await typeInto(field(h), '999');
    await keydown(field(h), { key: 'Escape' });
    expect(field(h)).toBeNull();
    await click(amtBtn(h, 'c1'));
    await keydown(field(h), { key: 'Enter' });
    expect(api.setBudgeted).not.toHaveBeenCalled();
    await click(amtBtn(h, 'c1'));
    await typeInto(field(h), 'abc');
    await keydown(field(h), { key: 'Enter' });
    expect(h.querySelector('.err.inline').textContent).toContain('Enter an amount');
    expect(field(h)).not.toBeNull();
    expect(api.setBudgeted).not.toHaveBeenCalled();
  });
  test('Tab saves and moves on to the next category; a server error keeps the field open with the message', async () => {
    api.setBudgeted.mockResolvedValueOnce({});
    const h = await open();
    await click(amtBtn(h, 'c1'));
    await typeInto(field(h), '460');
    await keydown(field(h), { key: 'Tab' });
    expect(api.setBudgeted).toHaveBeenCalledWith(cur, 'c1', 46000);
    expect(h.querySelector('[data-category-id=c2] .amt-input')).not.toBeNull();
    api.setBudgeted.mockRejectedValueOnce(new Error('bad_request'));
    await typeInto(field(h), '70');
    await keydown(field(h), { key: 'Enter' });
    expect(h.querySelector('.err.inline').textContent).toBe('bad_request');
    expect(field(h)).not.toBeNull();
  });
  test('Repeat from the editor opens the series editor with the typed amount', async () => {
    const h = await open();
    await click(amtBtn(h, 'c1'));
    await typeInto(field(h), '510');
    await click(byText(h.querySelector('[data-category-id=c1]'), 'Repeat'));
    expect(h.querySelector('.series-form .amount').value).toBe('510.00');
    expect(api.setBudgeted).not.toHaveBeenCalled();
  });
  test('context menu on a category: edit, move money, repeat', async () => {
    api.moveBudget.mockResolvedValue({});
    const h = await open();
    h.querySelector('[data-category-id=c1]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
    await flush();
    expect([...document.querySelectorAll('[role=menuitem]')].map((b) => b.textContent)).toEqual(['Edit budgeted amount', 'Move money from here…', 'Repeat…', 'Copy category name']);
    byText(document, 'Move money', '[role=menuitem]').click();
    await flush();
    const panel = h.querySelector('.move');
    expect(panel.querySelector('select').value).toBe('c2');
    await typeInto(panel.querySelector('input'), '25');
    await click(byText(panel, 'Move'));
    expect(api.moveBudget).toHaveBeenCalledWith(cur, { from: 'c1', to: 'c2', amount: 2500 });
    expect(h.querySelector('.move')).toBeNull();
  });
  test('context menu on a group expands and collapses', async () => {
    const h = await mount(BudgetTab);
    h.querySelector('.head').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    byText(document, 'Expand group', '[role=menuitem]').click();
    await flush();
    expect(h.querySelectorAll('.cat')).toHaveLength(2);
  });
});
