import { mount, unmount, flushSync } from 'svelte';

vi.mock('../api-client', () => ({ fetchApi: vi.fn() }));

import { fetchApi } from '../api-client';
import MobileTab from './MobileTab.svelte';

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ACCOUNTS = [
  { id: 'a-chk', name: 'Checking', closed: false, offBudget: false, hidden: false },
  { id: 'a-old', name: 'Checking (Simplifi history)', closed: true, offBudget: false, hidden: true },
  { id: 'a-ret', name: 'Retirement', closed: false, offBudget: true, hidden: false },
];

let component;
function open(handlers = {}) {
  fetchApi.mockImplementation((path, options) => {
    const handler = handlers[`${options?.method || 'GET'} ${path}`];
    if (handler) return Promise.resolve(handler(options));
    if (path === '/api/mobile/tokens') return Promise.resolve(json({ tokens: [] }));
    if (path === '/api/mobile/hidden-accounts') return Promise.resolve(json({ accounts: ACCOUNTS }));
    return Promise.reject(new Error(`unexpected ${path}`));
  });
  document.body.innerHTML = '<div id="host"></div>';
  component = mount(MobileTab, { target: document.getElementById('host') });
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  fetchApi.mockReset();
});

const boxes = () => [...document.querySelectorAll('.hidden-row')];

test('lists every account with closed and off-budget marked, checked = hidden, and explains it', async () => {
  open();
  await flush();
  flushSync();
  expect(boxes().map((r) => r.textContent.trim())).toEqual(['Checking', 'Checking (Simplifi history) (closed)', 'Retirement (off budget)']);
  expect(boxes().map((r) => r.querySelector('input').checked)).toEqual([false, true, false]);
  expect(document.body.textContent).toContain('Hidden accounts disappear from the phone app: the accounts list, transactions, spending details and report totals. Your budget numbers still come from Actual itself.');
});

test('Save sends the checked ids, then shows Saved.', async () => {
  const put = vi.fn(() => json({ accounts: ACCOUNTS.map((a) => ({ ...a, hidden: a.id === 'a-chk' || a.id === 'a-old' })) }));
  open({ 'PUT /api/mobile/hidden-accounts': put });
  await flush();
  flushSync();
  const first = boxes()[0].querySelector('input');
  first.checked = true;
  first.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
  document.querySelector('.save-hidden').click();
  await flush();
  flushSync();
  expect(JSON.parse(put.mock.calls[0][0].body)).toEqual({ hiddenIds: ['a-old', 'a-chk'] });
  expect(document.querySelector('.saved-status').textContent).toBe('Saved.');
});

test('a failed load and a failed save show the error and keep the page usable', async () => {
  open({ 'GET /api/mobile/hidden-accounts': () => json({ error: 'boom' }, false, 500) });
  await flush();
  flushSync();
  expect(document.querySelector('.hidden-error').textContent).toBe('boom');
  unmount(component);

  open({ 'PUT /api/mobile/hidden-accounts': () => json({ error: 'nope' }, false, 400) });
  await flush();
  flushSync();
  document.querySelector('.save-hidden').click();
  await flush();
  flushSync();
  expect(document.querySelector('.hidden-error').textContent).toBe('nope');
  expect(document.querySelector('.saved-status')).toBeNull();
});
