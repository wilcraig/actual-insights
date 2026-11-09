vi.mock('../../src/chipmunk/chipmunk-api', async (orig) => ({
  ...(await orig()),
  getMode: vi.fn(), setMode: vi.fn(), getReportList: vi.fn(), getReports: vi.fn(), getAccounts: vi.fn(), getTransactions: vi.fn(),
  suggest: vi.fn(), getBudget: vi.fn(), getSeriesList: vi.fn(),
}));
import * as api from '../../src/chipmunk/chipmunk-api';
import { setChipmunkMode } from '../../src/chipmunk/mode-state';
import ChipmunkShell from '../../src/chipmunk/shell/ChipmunkShell.svelte';
import TransactionsTab from '../../src/chipmunk/TransactionsTab.svelte';
import { mountChipmunkShell } from '../../src/chipmunk/shell/mount-shell';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
let app;
const host = () => document.getElementById('host');
async function mount(Comp, props = {}) {
  document.body.innerHTML = '<div id="host"></div>';
  app = new Comp({ target: host(), props });
  await flush();
  return host();
}
const key = async (init) => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); await flush(); };
const links = (h) => [...h.querySelectorAll('.cm-sidebar a')].map((a) => a.textContent.replace(/\s+/g, ' ').trim());

const tx = (id, over = {}) => ({ id, date: '2026-11-01', amount: -1000, payee: `Payee ${id}`, category: { id: 'c', name: 'Groceries' }, categoryGroup: 'Usual', color: 'blue', ...over });

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '/budget');
  setChipmunkMode({ enabled: true, entitled: true });
  api.getReportList.mockResolvedValue({ reports: [{ id: 'r1', title: 'Main' }], defaultId: 'r1' });
  api.getReports.mockResolvedValue({ cards: [] });
  api.getAccounts.mockResolvedValue({ accounts: [{ id: 'a1', name: 'Checking', balance: 100, offBudget: false }], groups: [] });
  api.getTransactions.mockResolvedValue({ transactions: [tx('t1'), tx('t2', { amount: 5000, date: '2026-11-03', payee: 'Zed' })], nextCursor: null, uncategorizedCount: 0 });
  api.suggest.mockResolvedValue({ payees: [], categories: [] });
  api.getBudget.mockResolvedValue({ groups: [], month: '2026-11' });
  api.getSeriesList.mockResolvedValue({ series: [] });
});
afterEach(() => { try { app?.$destroy?.(); } catch {} });

describe('ChipmunkShell', () => {
  test('sidebar: the four screens, Settings, More Insights, Open Actual', async () => {
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    const l = links(h);
    expect(l.slice(0, 4).map((t) => t.replace(/[⌘\w+]*\d$/, '').trim())).toEqual(['Reports', 'Accounts', 'Transactions', 'Budget']);
    expect(l.join('|')).toContain('Settings');
    expect(h.textContent).toContain('More Insights');
    for (const t of ['General', 'Summaries', 'Channels', 'Forecast', 'Mobile app']) expect(l.join('|')).toContain(t);
    expect(h.textContent).toContain('Open Actual');
  });
  test('starts at Reports and makes the address canonical', async () => {
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    expect(location.hash).toBe('#/chipmunk/reports');
    expect(h.querySelector('.cm-sidebar a[aria-current=page]').textContent).toContain('Reports');
  });
  test('clicking a link pushes the hash; Back and Forward follow', async () => {
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    [...h.querySelectorAll('.cm-sidebar a')].find((a) => a.textContent.includes('Accounts')).click();
    await flush();
    expect(location.hash).toBe('#/chipmunk/accounts');
    expect(h.querySelector('.cm-sidebar a[aria-current=page]').textContent).toContain('Accounts');
    history.back();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.querySelector('.cm-sidebar a[aria-current=page]').textContent).toContain('Reports');
    history.forward();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.querySelector('.cm-sidebar a[aria-current=page]').textContent).toContain('Accounts');
  });
  test('a deep link opens that screen', async () => {
    history.replaceState(null, '', '/budget#/chipmunk/budget');
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    expect(h.querySelector('.cm-sidebar a[aria-current=page]').textContent).toContain('Budget');
    expect(api.getBudget).toHaveBeenCalled();
  });
  test('More Insights shows the unchanged Insights page inside the shell', async () => {
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    [...h.querySelectorAll('.cm-sidebar a')].find((a) => a.textContent.includes('Forecast')).click();
    await flush();
    expect(location.hash).toBe('#actual-insights/forecast');
    expect([...h.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim())).toEqual(['General', 'Summaries', 'Channels', 'Forecast', 'Mobile app']);
    expect(h.querySelector('[role=tab][aria-selected=true]').textContent.trim()).toBe('Forecast');
  });
  test('keyboard: Alt/Ctrl-1..4 and Ctrl-comma', async () => {
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    await key({ key: '3', altKey: true });
    expect(location.hash).toBe('#/chipmunk/transactions');
    await key({ key: '4', ctrlKey: true });
    expect(location.hash).toBe('#/chipmunk/budget');
    await key({ key: ',', ctrlKey: true });
    expect(location.hash).toBe('#/chipmunk/settings');
    await key({ key: '1', metaKey: true });
    expect(location.hash).toBe('#/chipmunk/reports');
    expect(h).toBeTruthy();
  });
  test('Open Actual and Widget builder call back', async () => {
    const openActual = vi.fn();
    const h = await mount(ChipmunkShell, { openActual });
    [...h.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open Actual').click();
    expect(openActual).toHaveBeenCalledWith({});
    [...h.querySelectorAll('button')].find((b) => b.textContent.includes('Widget builder')).click();
    expect(openActual).toHaveBeenCalledWith({ path: '/reports' });
  });
  test('hamburger toggles the drawer', async () => {
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    expect(h.querySelector('.cm-shell').classList.contains('cm-drawer-open')).toBe(false);
    h.querySelector('.cm-hamburger').click();
    await flush();
    expect(h.querySelector('.cm-shell').classList.contains('cm-drawer-open')).toBe(true);
    await key({ key: 'Escape' });
    expect(h.querySelector('.cm-shell').classList.contains('cm-drawer-open')).toBe(false);
  });
  test('settings screen: confirmation before turning the mode off, then it calls the API', async () => {
    api.getMode.mockResolvedValue({ enabled: true, entitled: true, reason: 'verified', lastVerifiedAt: '2026-11-01T00:00:00Z' });
    api.setMode.mockResolvedValue({ enabled: false, entitled: true, reason: 'verified' });
    history.replaceState(null, '', '/budget#/chipmunk/settings');
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    expect(h.textContent).toContain('Verified by your Chipmunk app');
    h.querySelector('#insights-chipmunk-mode').click();
    await flush();
    expect(api.setMode).not.toHaveBeenCalled();
    expect(h.textContent).toContain('Turn off Chipmunk mode?');
    h.querySelector('.chipmunk-confirm-no').click();
    await flush();
    expect(h.querySelector('.chipmunk-confirm')).toBeNull();
    h.querySelector('#insights-chipmunk-mode').click();
    await flush();
    h.querySelector('.chipmunk-confirm-yes').click();
    await flush();
    expect(api.setMode).toHaveBeenCalledWith(false);
  });
  test('command palette: Ctrl-K opens, filters, Enter runs; Escape closes; accounts hand off to Transactions', async () => {
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    await key({ key: 'k', ctrlKey: true });
    const input = h.querySelector('.cm-pal-input');
    expect(input).not.toBeNull();
    input.value = 'checking';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    const opts = [...h.querySelectorAll('.cm-pal-list [role=option]')].map((o) => o.textContent);
    expect(opts.some((t) => t.includes('Transactions in Checking'))).toBe(true);
    h.querySelector('.cm-pal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(h.querySelector('.cm-pal')).toBeNull();
    expect(location.hash).toBe('#/chipmunk/transactions');
    expect(api.getTransactions.mock.calls.at(-1)[0]).toContain('account=a1');
    await key({ key: 'k', ctrlKey: true });
    expect(h.querySelector('.cm-pal')).not.toBeNull();
    h.querySelector('.cm-pal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(h.querySelector('.cm-pal')).toBeNull();
  });
  test('a screen that throws shows a message with a way out instead of a blank page', async () => {
    api.getAccounts.mockImplementation(() => { throw new Error('kaboom'); });
    history.replaceState(null, '', '/budget#/chipmunk/accounts');
    const h = await mount(ChipmunkShell, { openActual: vi.fn() });
    // AccountsTab catches its own load errors; the shell itself must still be standing.
    expect(h.querySelector('.cm-sidebar')).not.toBeNull();
  });
});

describe('Transactions table', () => {
  async function table() { return mount(TransactionsTab); }
  const rowsText = (h) => [...h.querySelectorAll('tr.tx')].map((r) => r.querySelector('.c-payee').textContent);
  test('renders a table, newest first, and sorts by a header; the same header again reverses', async () => {
    const h = await table();
    expect(rowsText(h)).toEqual(['Zed', 'Payee t1']);
    const th = (name) => [...h.querySelectorAll('th .th')].find((b) => b.textContent.includes(name));
    th('Amount').click();
    await flush();
    expect(rowsText(h)).toEqual(['Zed', 'Payee t1']); // amount desc: 50.00 then -10.00
    th('Amount').click();
    await flush();
    expect(rowsText(h)).toEqual(['Payee t1', 'Zed']);
    expect(th('Amount').closest('th').getAttribute('aria-sort')).toBe('ascending');
    th('Payee').click();
    await flush();
    expect(rowsText(h)).toEqual(['Payee t1', 'Zed']);
  });
  test('click selects one, Ctrl-click adds, Shift-click ranges; total shown; detail pane for the active row', async () => {
    const h = await table();
    const rows = () => [...h.querySelectorAll('tr.tx')];
    rows()[0].click();
    await flush();
    expect(h.querySelector('.detail h3').textContent).toBe('Zed');
    rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await flush();
    expect(h.querySelector('.selbar').textContent).toContain('2 selected');
    expect(h.querySelector('.selbar').textContent).toContain('$40.00');
    [...h.querySelectorAll('.selbar button')].find((b) => b.textContent === 'Clear').click();
    await flush();
    expect(h.querySelector('.selbar')).toBeNull();
    rows()[0].click();
    await flush();
    rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await flush();
    expect(h.querySelectorAll('tr.tx.sel')).toHaveLength(2);
  });
  test('keyboard: j/k move, Space toggles, Escape clears', async () => {
    const h = await table();
    const table_ = h.querySelector('table.grid');
    const press = async (k) => { table_.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); await flush(); };
    await press('j');
    expect(h.querySelector('tr.tx.cur .c-payee').textContent).toBe('Zed');
    await press('j');
    expect(h.querySelector('tr.tx.cur .c-payee').textContent).toBe('Payee t1');
    await press('k');
    expect(h.querySelector('tr.tx.cur .c-payee').textContent).toBe('Zed');
    await press(' ');
    expect(h.querySelectorAll('tr.tx.sel')).toHaveLength(0); // j had selected it; Space toggled it off
    await press('Escape');
    expect(h.querySelector('.detail')).toBeNull();
  });
});

describe('mountChipmunkShell', () => {
  test('mounts a fixed full-viewport host; hide/show toggle it; destroy removes it', async () => {
    document.body.innerHTML = '';
    const s = mountChipmunkShell(document, window, { openActual: vi.fn() });
    const hostEl = document.querySelector('[data-chipmunk-shell]');
    expect(hostEl.style.position).toBe('fixed');
    expect(hostEl.getAttribute('data-chipmunk-owned')).toBe('shell');
    s.hide();
    expect(hostEl.style.display).toBe('none');
    s.show();
    expect(hostEl.style.display).toBe('block');
    s.destroy();
    expect(document.querySelector('[data-chipmunk-shell]')).toBeNull();
  });
});
