vi.mock('../src/api-client', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../src/api-client';
import SpendingBreakdownDonut from '../src/widgets/SpendingBreakdownDonut.svelte';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function mountWidget(props = {}) {
  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new SpendingBreakdownDonut({ target, props });
  return target;
}

beforeEach(() => {
  fetchApi.mockReset();
});

test('with a date, fetches that single day; a "Transfers" group is always dropped', async () => {
  fetchApi.mockResolvedValue(
    jsonResponse({
      total: 10500,
      slices: [
        { id: 'g1', label: 'Food', amountCents: 500 },
        { id: 'gx', label: 'Transfers', amountCents: 10000 },
      ],
    }),
  );

  const target = mountWidget({ date: '2026-10-15' });
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));

  const params = new URLSearchParams(fetchApi.mock.calls[0][0].split('?')[1]);
  expect(params.get('date')).toBe('2026-10-15');
  expect(params.has('month')).toBe(false);
  const slices = [...target.querySelectorAll('.donut-slice')].map((s) => s.getAttribute('aria-label'));
  expect(slices).toHaveLength(1);
  expect(slices[0]).toContain('Food');
});

test('fetches the groups-level breakdown on mount, with no groupIds filter by default', async () => {
  fetchApi.mockResolvedValue(jsonResponse({ total: 500, slices: [{ id: 'g1', label: 'Everyday Expenses', amountCents: 500 }] }));

  mountWidget();
  await Promise.resolve();
  await Promise.resolve();

  expect(fetchApi).toHaveBeenCalledTimes(1);
  const url = fetchApi.mock.calls[0][0];
  expect(url).toContain('level=groups');
  expect(url).not.toContain('groupIds=');
});

test('with a groupIds prop, fetches with a comma-joined groupIds filter', async () => {
  fetchApi.mockResolvedValue(jsonResponse({ total: 0, slices: [] }));

  mountWidget({ groupIds: ['group1', 'group2'] });
  await Promise.resolve();
  await Promise.resolve();

  const url = fetchApi.mock.calls[0][0];
  expect(decodeURIComponent(url)).toContain('groupIds=group1,group2');
});

test('renders the donut for the groups-level breakdown and drills in on a slice click', async () => {
  fetchApi
    .mockResolvedValueOnce(jsonResponse({ total: 500, slices: [{ id: 'group1', label: 'Everyday Expenses', amountCents: 500 }] }))
    .mockResolvedValueOnce(
      jsonResponse({ total: 500, slices: [{ id: 'catA', label: 'Groceries', amountCents: 500 }] }),
    );

  const target = mountWidget();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(target.querySelectorAll('path.donut-slice').length).toBe(1);

  target.querySelector('path.donut-slice').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fetchApi.mock.calls[1][0]).toContain('level=categories');
  expect(fetchApi.mock.calls[1][0]).toContain('groupId=group1');
  expect(target.textContent).toContain('Everyday Expenses');
});

test('no Back button at the entry (groups) level', async () => {
  fetchApi.mockResolvedValue(jsonResponse({ total: 0, slices: [] }));

  const target = mountWidget();
  await Promise.resolve();
  await Promise.resolve();

  expect(target.querySelector('button.breakdown-back')).toBeNull();
});

test('drilling into a group, then clicking Back, re-fetches the groups level', async () => {
  fetchApi
    .mockResolvedValueOnce(jsonResponse({ total: 500, slices: [{ id: 'group1', label: 'Everyday Expenses', amountCents: 500 }] }))
    .mockResolvedValueOnce(jsonResponse({ total: 500, slices: [{ id: 'catA', label: 'Groceries', amountCents: 500 }] }))
    .mockResolvedValueOnce(jsonResponse({ total: 500, slices: [{ id: 'group1', label: 'Everyday Expenses', amountCents: 500 }] }));

  const target = mountWidget();
  await new Promise((resolve) => setTimeout(resolve, 0));

  target.querySelector('path.donut-slice').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(target.querySelector('button.breakdown-back')).not.toBeNull();

  target.querySelector('button.breakdown-back').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fetchApi.mock.calls[2][0]).toContain('level=groups');
  expect(target.querySelector('button.breakdown-back')).toBeNull();
});

test('renders the inline error treatment on a non-ok response', async () => {
  fetchApi.mockResolvedValue(jsonResponse(null, false, 500));

  const target = mountWidget();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(target.textContent).toContain('Spending breakdown unavailable (500)');
});

test('renders the inline error treatment when fetch throws', async () => {
  fetchApi.mockRejectedValue(new Error('network down'));

  const target = mountWidget();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(target.textContent).toContain('could not reach insights-api');
});

// ---- month arrows ----

const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const monthOf = (call) => new URLSearchParams(call[0].split('?')[1]).get('month');
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

describe('month arrows', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 8));
  });
  afterEach(() => vi.useRealTimers());

  const groups = (extra = {}) => jsonResponse({ total: 500, slices: [{ id: 'g1', label: 'Food', amountCents: 500 }], ...extra });

  test('header shows the month, next is disabled at the current month, labels are accessible', async () => {
    fetchApi.mockResolvedValue(groups({ earliestMonth: '2026-09' }));
    const target = mountWidget();
    await tick();

    expect(target.querySelector('.month-label').textContent).toBe('November 2026');
    expect(target.querySelector('.month-label').getAttribute('aria-live')).toBe('polite');
    const prev = target.querySelector('button.month-prev');
    const next = target.querySelector('button.month-next');
    expect(prev.getAttribute('aria-label')).toBe('Previous month, October 2026');
    expect(next.getAttribute('aria-label')).toBe('Next month, December 2026');
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);
  });

  test('stepping back re-fetches the same drill state for the earlier month, and stops at earliestMonth', async () => {
    fetchApi.mockResolvedValue(groups({ earliestMonth: '2026-09' }));
    const target = mountWidget();
    await tick();

    // drill into the Food group first
    click(target.querySelector('path.donut-slice'));
    await tick();
    expect(fetchApi.mock.calls[1][0]).toContain('level=categories');
    expect(monthOf(fetchApi.mock.calls[1])).toBe('2026-11');

    click(target.querySelector('button.month-prev'));
    await tick();
    const last = fetchApi.mock.calls.at(-1);
    expect(monthOf(last)).toBe('2026-10');
    expect(last[0]).toContain('level=categories');
    expect(last[0]).toContain('groupId=g1');
    expect(target.querySelector('.month-label').textContent).toBe('October 2026');

    click(target.querySelector('button.month-prev'));
    await tick();
    expect(target.querySelector('.month-label').textContent).toBe('September 2026');
    expect(target.querySelector('button.month-prev').disabled).toBe(true);
    expect(target.querySelector('button.month-next').disabled).toBe(false);

    // Back keeps the shown month
    click(target.querySelector('button.breakdown-back'));
    await tick();
    expect(monthOf(fetchApi.mock.calls.at(-1))).toBe('2026-09');
    expect(fetchApi.mock.calls.at(-1)[0]).toContain('level=groups');
  });

  test('without earliestMonth, allows 24 months back and no further', async () => {
    fetchApi.mockResolvedValue(groups());
    const target = mountWidget();
    await tick();
    for (let i = 0; i < 30; i++) {
      const prev = target.querySelector('button.month-prev');
      if (prev.disabled) break;
      click(prev);
      await tick(2);
    }
    expect(target.querySelector('.month-label').textContent).toBe('November 2024');
  });

  test('an empty month shows a note and the arrows keep working', async () => {
    fetchApi
      .mockResolvedValueOnce(groups({ earliestMonth: '2026-01' }))
      .mockResolvedValueOnce(jsonResponse({ total: 0, slices: [], earliestMonth: '2026-01' }));
    const target = mountWidget();
    await tick();
    click(target.querySelector('button.month-prev'));
    await tick();

    expect(target.textContent).toContain('No spending in October 2026');
    expect(target.querySelector('.donut-slice')).toBeNull();
    expect(target.querySelector('button.month-prev').disabled).toBe(false);
    expect(target.querySelector('button.month-next').disabled).toBe(false);
  });

  test('a slow earlier response never overwrites a newer month', async () => {
    let resolveSlow;
    fetchApi
      .mockResolvedValueOnce(groups({ earliestMonth: '2026-01' }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve; }))
      .mockResolvedValueOnce(jsonResponse({ total: 700, slices: [{ id: 'g2', label: 'Housing', amountCents: 700 }] }));
    const target = mountWidget();
    await tick();

    click(target.querySelector('button.month-prev')); // October (slow)
    await tick(1);
    click(target.querySelector('button.month-prev')); // September (fast)
    await tick();
    resolveSlow(jsonResponse({ total: 1, slices: [{ id: 'g3', label: 'Stale', amountCents: 1 }] }));
    await tick();

    const labels = [...target.querySelectorAll('.donut-slice')].map((s) => s.getAttribute('aria-label')).join('|');
    expect(labels).toContain('Housing');
    expect(labels).not.toContain('Stale');
  });

  test('monthNav=false and the date prop show no arrows', async () => {
    fetchApi.mockResolvedValue(groups());
    const off = mountWidget({ monthNav: false });
    await tick();
    expect(off.querySelector('.breakdown-month-nav')).toBeNull();
    expect(monthOf(fetchApi.mock.calls[0])).toBe('2026-11');

    const dated = mountWidget({ date: '2026-10-15' });
    await tick();
    expect(dated.querySelector('.breakdown-month-nav')).toBeNull();
  });
});
