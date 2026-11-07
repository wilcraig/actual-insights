vi.mock('../src/api-client', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../src/api-client';
import PacingBars from '../src/widgets/PacingBars.svelte';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  fetchApi.mockReset();
});

test('each pacing row is a real <button> (keyboard-accessible), and clicking it opens the breakdown modal', async () => {
  fetchApi
    .mockResolvedValueOnce(
      jsonResponse({
        daysElapsed: 10,
        daysInMonth: 30,
        categories: [
          { id: 'catA', name: 'Groceries', groupId: 'group1', groupName: 'Everyday Expenses', spent: 4000, balance: 6000 },
        ],
      }),
    )
    .mockResolvedValue(jsonResponse({ total: 0, slices: [] }));

  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new PacingBars({ target, props: { items: ['catA'] } });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const row = target.querySelector('button.pacing-row');
  expect(row).not.toBeNull();
  expect(row.tagName).toBe('BUTTON');

  expect(document.body.querySelector('.actualmint-breakdown-modal-backdrop')).toBeNull();

  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(document.body.querySelector('.actualmint-breakdown-modal-backdrop')).not.toBeNull();

  const lastCall = fetchApi.mock.calls[fetchApi.mock.calls.length - 1];
  expect(lastCall[0]).toContain('level=payees');
  expect(lastCall[0]).toContain('categoryId=catA');
});

test('the opened modal is mounted onto document.body, not inside the widget\'s own DOM subtree', async () => {
  // Confirmed root cause: Actual's Reports page positions each widget's
  // grid-item ancestor with a CSS `transform` (react-grid-layout's default
  // `useCSSTransforms: true`), which per the CSS spec becomes the
  // containing block for any `position: fixed` descendant. The modal's
  // full-screen backdrop relies on `position: fixed` covering the real
  // viewport, so it must never be a descendant of the widget's own root
  // element -- it has to be mounted directly onto document.body instead.
  fetchApi
    .mockResolvedValueOnce(
      jsonResponse({
        daysElapsed: 10,
        daysInMonth: 30,
        categories: [
          { id: 'catA', name: 'Groceries', groupId: 'group1', groupName: 'Everyday Expenses', spent: 4000, balance: 6000 },
        ],
      }),
    )
    .mockResolvedValue(jsonResponse({ total: 0, slices: [] }));

  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new PacingBars({ target, props: { items: ['catA'] } });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const row = target.querySelector('button.pacing-row');
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const backdrop = document.body.querySelector('.actualmint-breakdown-modal-backdrop');
  expect(backdrop).not.toBeNull();
  // The widget's own root element (direct child of #host) must not
  // contain the backdrop.
  expect(target.contains(backdrop)).toBe(false);
  // It should instead be a direct child of document.body (mounted via
  // Svelte 5's mount(Component, { target: document.body })).
  expect(backdrop.closest('body')).toBe(document.body);
});

test('a rollup row is also a real <button>, and clicking it opens the breakdown modal scoped to the rollup\'s member categories', async () => {
  fetchApi
    .mockResolvedValueOnce(
      jsonResponse({
        daysElapsed: 10,
        daysInMonth: 30,
        categories: [
          { id: 'catA', name: 'Botox', groupId: 'group1', groupName: 'Health', spent: 4000, balance: 6000 },
          { id: 'catB', name: 'Skincare', groupId: 'group1', groupName: 'Health', spent: 1000, balance: 9000 },
        ],
      }),
    )
    .mockResolvedValue(jsonResponse({ total: 0, slices: [] }));

  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new PacingBars({
    target,
    props: { items: [{ title: 'Elizabeth Personal Care', budgets: ['catA', 'catB'] }] },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const row = target.querySelector('button.pacing-row--rollup');
  expect(row).not.toBeNull();
  expect(row.tagName).toBe('BUTTON');

  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(document.body.querySelector('.actualmint-breakdown-modal-backdrop')).not.toBeNull();

  const lastCall = fetchApi.mock.calls[fetchApi.mock.calls.length - 1];
  expect(lastCall[0]).toContain('level=categories');
  expect(lastCall[0]).toContain('categoryIds=catA%2CcatB');
});

test('allGroups: loads /api/category-groups, draws one rollup bar per expense group, and a group bar drills into its categories', async () => {
  fetchApi.mockImplementation(async (url) => {
    if (url === '/api/category-groups') {
      return jsonResponse({
        groups: [
          { id: 'g1', name: 'Everyday Expenses', isIncome: false, isTransfer: false, categoryIds: ['catA', 'catB'] },
          { id: 'g2', name: 'Personal Income', isIncome: true, isTransfer: false, categoryIds: ['catI'] },
        ],
      });
    }
    if (url.startsWith('/api/budget-pacing')) {
      return jsonResponse({
        daysElapsed: 10,
        daysInMonth: 30,
        categories: [
          { id: 'catA', name: 'Groceries', groupId: 'g1', groupName: 'Everyday Expenses', spent: 4000, balance: 6000 },
          { id: 'catB', name: 'Fuel', groupId: 'g1', groupName: 'Everyday Expenses', spent: 1000, balance: 1000 },
        ],
      });
    }
    return jsonResponse({ total: 0, slices: [] });
  });

  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new PacingBars({ target, props: { items: [], allGroups: true } });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const pacingCall = fetchApi.mock.calls.find(([url]) => url.startsWith('/api/budget-pacing'));
  expect(decodeURIComponent(pacingCall[0])).toContain('categories=catA,catB');
  expect(decodeURIComponent(pacingCall[0])).not.toContain('catI');

  const rows = target.querySelectorAll('button.pacing-row');
  expect(rows).toHaveLength(1);
  expect(rows[0].classList.contains('pacing-row--rollup')).toBe(true);
  expect(rows[0].textContent).toContain('Everyday Expenses');

  rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(document.body.querySelector('.actualmint-breakdown-modal-backdrop')).not.toBeNull();
  const lastCall = fetchApi.mock.calls[fetchApi.mock.calls.length - 1];
  expect(lastCall[0]).toContain('level=categories');
  expect(decodeURIComponent(lastCall[0])).toContain('categoryIds=catA,catB');
});

test('allGroups: a failing /api/category-groups shows an error instead of loading forever', async () => {
  fetchApi.mockResolvedValue(jsonResponse({}, false, 500));
  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new PacingBars({ target, props: { items: [], allGroups: true } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(target.querySelector('[role="alert"]').textContent).toContain('500');
});

test('allGroups with groupIds: only those groups, in that order', async () => {
  fetchApi.mockImplementation(async (url) => {
    if (url === '/api/category-groups') {
      return jsonResponse({
        groups: [
          { id: 'g1', name: 'Bills', categoryIds: ['catA'] },
          { id: 'g2', name: 'Fun', categoryIds: ['catB'] },
          { id: 'g3', name: 'Food', categoryIds: ['catC'] },
        ],
      });
    }
    return jsonResponse({
      daysElapsed: 10,
      daysInMonth: 30,
      categories: ['catA', 'catB', 'catC'].map((id) => ({ id, name: id, groupId: 'x', groupName: 'x', spent: 1, balance: 9 })),
    });
  });
  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new PacingBars({ target, props: { items: [], allGroups: true, groupIds: ['g3', 'g1'] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const names = [...target.querySelectorAll('.pacing-name')].map((n) => n.textContent);
  expect(names).toEqual(['Food', 'Bills']);
});
