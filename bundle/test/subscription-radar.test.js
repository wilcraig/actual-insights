vi.mock('../src/api-client', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../src/api-client';
import SubscriptionRadar from '../src/widgets/SubscriptionRadar.svelte';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function mountWidget(props = {}) {
  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new SubscriptionRadar({ target, props });
  return target;
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

function emptyResponse() {
  return jsonResponse({ items: [] });
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  fetchApi.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('fetches this month, and also next month when the 30-day window crosses the boundary', async () => {
  // Oct 26, 2026 + 30 days = Nov 25, 2026 -- crosses into November.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26));

  fetchApi.mockImplementation(() => Promise.resolve(emptyResponse()));

  mountWidget();
  await flush();

  const urls = fetchApi.mock.calls.map((call) => call[0]);
  expect(urls.some((u) => u.includes('month=2026-10'))).toBe(true);
  expect(urls.some((u) => u.includes('month=2026-11'))).toBe(true);
});

test('does not fetch next month when today + 30 days stays within the current month', async () => {
  // Oct 1, 2026 + 30 days = Oct 31, 2026 -- stays within October.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));

  fetchApi.mockImplementation(() => Promise.resolve(emptyResponse()));

  mountWidget();
  await flush();

  const urls = fetchApi.mock.calls.map((call) => call[0]);
  expect(urls.every((u) => u.includes('month=2026-10'))).toBe(true);
  expect(urls.some((u) => u.includes('month=2026-11'))).toBe(false);
});

test('renders one dot per item within the next 30 days, positioned by date along a single axis', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1)); // Oct 1, 2026

  fetchApi.mockImplementation(() =>
    Promise.resolve(
      jsonResponse({
        items: [
          { scheduleId: 'sched1', payeeName: 'Netflix', date: '2026-10-05', amountCents: -1500, groupName: 'Subscriptions' },
          { scheduleId: 'sched2', payeeName: 'Spotify', date: '2026-10-15', amountCents: -1000, groupName: 'Subscriptions' },
        ],
      })
    )
  );

  const target = mountWidget();
  await flush();

  const dots = target.querySelectorAll('.radar-dot');
  expect(dots).toHaveLength(2);

  const x1 = Number(dots[0].getAttribute('cx'));
  const x2 = Number(dots[1].getAttribute('cx'));
  expect(x2).toBeGreaterThan(x1);
});

test('items beyond 30 days out are excluded even if returned by a fetched month', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26)); // Oct 26, 2026 -- window end Nov 25

  fetchApi.mockImplementation((url) => {
    if (url.includes('month=2026-10')) {
      return Promise.resolve(
        jsonResponse({
          items: [
            { scheduleId: 'in-range', payeeName: 'Netflix', date: '2026-10-30', amountCents: -1500, groupName: null },
          ],
        })
      );
    }
    if (url.includes('month=2026-11')) {
      return Promise.resolve(
        jsonResponse({
          items: [
            { scheduleId: 'within-30', payeeName: 'Spotify', date: '2026-11-20', amountCents: -1000, groupName: null },
            { scheduleId: 'beyond-30', payeeName: 'Rent', date: '2026-11-30', amountCents: -200000, groupName: null },
          ],
        })
      );
    }
    return Promise.resolve(emptyResponse());
  });

  const target = mountWidget();
  await flush();

  const dots = target.querySelectorAll('.radar-dot');
  expect(dots).toHaveLength(2);
  const ids = Array.from(dots).map((dot) => dot.getAttribute('data-schedule-id'));
  expect(ids).toContain('in-range');
  expect(ids).toContain('within-30');
  expect(ids).not.toContain('beyond-30');
});

test('many items close together pack into lanes with no two labels overlapping, and same-day dots stack', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));

  const payees = ['Netflix', 'Hulu', 'Spotify', 'Rocky Mountain Power', 'Mortgage', 'Verizon', 'State Farm Insurance', 'Dep Stayntouch Payroll'];
  const items = Array.from({ length: 20 }, (_, i) => ({
    scheduleId: `s${i}`,
    payeeName: payees[i % payees.length],
    date: `2026-10-${String(5 + Math.floor(i / 4)).padStart(2, '0')}`,
    amountCents: i % 5 === 0 ? 447100 : -(1599 + i * 1000),
    groupName: null,
  }));
  fetchApi.mockImplementation(() => Promise.resolve(jsonResponse({ items })));

  const target = mountWidget();
  await flush();

  const boxes = [...target.querySelectorAll('.radar-label')].map((label) => {
    const text = [...label.querySelectorAll('tspan')].map((t) => t.textContent).join(' ');
    const x = Number(label.getAttribute('x'));
    return { y: label.getAttribute('y'), x0: x, x1: x + text.length * 6.2 };
  });
  expect(boxes).toHaveLength(20);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[i].y !== boxes[j].y) continue;
      const overlap = boxes[i].x0 < boxes[j].x1 && boxes[j].x0 < boxes[i].x1;
      expect(overlap).toBe(false);
    }
  }

  // Four items share each date: their dots sit at four different heights.
  const sameDayDots = [...target.querySelectorAll('.radar-dot')].slice(0, 4).map((d) => d.getAttribute('cy'));
  expect(new Set(sameDayDots).size).toBe(4);
});

test('deposits are labeled with a + and bills without a sign', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));
  fetchApi.mockImplementation(() =>
    Promise.resolve(
      jsonResponse({
        items: [
          { scheduleId: 'pay', payeeName: 'Payroll', date: '2026-10-10', amountCents: 447100, groupName: null },
          { scheduleId: 'nf', payeeName: 'Netflix', date: '2026-10-12', amountCents: -1549, groupName: null },
        ],
      }),
    ),
  );

  const target = mountWidget();
  await flush();

  const amounts = [...target.querySelectorAll('.radar-label-amount')].map((a) => a.textContent);
  expect(amounts).toEqual(['+$4,471', '$15.49']);
});

test('two items on the same date both render without visually overlapping', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));

  fetchApi.mockImplementation(() =>
    Promise.resolve(
      jsonResponse({
        items: [
          { scheduleId: 'sched1', payeeName: 'Netflix', date: '2026-10-10', amountCents: -1500, groupName: null },
          { scheduleId: 'sched2', payeeName: 'Hulu', date: '2026-10-10', amountCents: -1200, groupName: null },
        ],
      })
    )
  );

  const target = mountWidget();
  await flush();

  const dots = target.querySelectorAll('.radar-dot');
  expect(dots).toHaveLength(2);

  const labels = target.querySelectorAll('.radar-label');
  expect(labels).toHaveLength(2);
  // Staggered/alternating placement: the two same-date labels must not sit
  // at the same y position, or they'd render on top of each other.
  const y1 = labels[0].getAttribute('y');
  const y2 = labels[1].getAttribute('y');
  expect(y1).not.toBe(y2);
});

test('colors dots by category group', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));

  fetchApi.mockImplementation(() =>
    Promise.resolve(
      jsonResponse({
        items: [
          { scheduleId: 'sched1', payeeName: 'Netflix', date: '2026-10-05', amountCents: -1500, groupName: 'Subscriptions' },
          { scheduleId: 'sched2', payeeName: 'Gym', date: '2026-10-10', amountCents: -4000, groupName: 'Health' },
          { scheduleId: 'sched3', payeeName: 'Spotify', date: '2026-10-15', amountCents: -1000, groupName: 'Subscriptions' },
          { scheduleId: 'sched4', payeeName: 'Unknown', date: '2026-10-20', amountCents: -500, groupName: null },
        ],
      })
    )
  );

  const target = mountWidget();
  await flush();

  const dots = target.querySelectorAll('.radar-dot');
  expect(dots).toHaveLength(4);

  const fillById = {};
  dots.forEach((dot) => {
    fillById[dot.getAttribute('data-schedule-id')] = dot.getAttribute('fill');
  });

  // Same group shares a color.
  expect(fillById.sched1).toBe(fillById.sched3);
  // Different groups get different colors.
  expect(fillById.sched1).not.toBe(fillById.sched2);
  // The ungrouped item uses a distinct neutral color, not shared with a real group.
  expect(fillById.sched4).not.toBe(fillById.sched1);
  expect(fillById.sched4).not.toBe(fillById.sched2);
});

test('shows a clean "nothing upcoming" message when there are zero items in range', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));

  fetchApi.mockImplementation(() => Promise.resolve(emptyResponse()));

  const target = mountWidget();
  await flush();

  expect(target.textContent).toContain('Nothing upcoming in the next 30 days.');
});

test('renders the inline error treatment on a non-ok response', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));

  fetchApi.mockImplementation(() => Promise.resolve(jsonResponse({}, false, 500)));

  const target = mountWidget();
  await flush();

  const error = target.querySelector('[role="alert"]');
  expect(error).not.toBeNull();
  expect(error.textContent).toContain('500');
});

test('renders the inline error treatment when fetch throws', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));

  fetchApi.mockImplementation(() => Promise.reject(new Error('network down')));

  const target = mountWidget();
  await flush();

  const error = target.querySelector('[role="alert"]');
  expect(error).not.toBeNull();
});

test('excludeCategoryIds hides those renewals; an item with an unknown category stays', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));
  fetchApi.mockImplementation(() => Promise.resolve(jsonResponse({ items: [
    { scheduleId: 's1', payeeName: 'Gym', date: '2026-10-05', amountCents: -5000, groupName: null, categoryId: 'cA' },
    { scheduleId: 's2', payeeName: 'Music', date: '2026-10-06', amountCents: -1000, groupName: null, categoryId: 'cB' },
    { scheduleId: 's3', payeeName: 'Mystery', date: '2026-10-07', amountCents: -700, groupName: null, categoryId: null },
  ] })));
  const target = mountWidget({ excludeCategoryIds: ['cA'] });
  await flush();
  const ids = [...target.querySelectorAll('.radar-dot')].map((d) => d.getAttribute('data-schedule-id'));
  expect(ids).toEqual(['s2', 's3']);
});

test('vertical layout draws a dot per renewal on one axis plus a list equivalent, and the svg is hidden from AT', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));
  fetchApi.mockImplementation(() => Promise.resolve(jsonResponse({ items: [
    { scheduleId: 's1', payeeName: 'Gym', date: '2026-10-05', amountCents: -5000, groupName: null, categoryId: null },
    { scheduleId: 's2', payeeName: 'Music', date: '2026-10-05', amountCents: -1000, groupName: null, categoryId: null },
  ] })));
  const target = mountWidget({ layout: 'vertical' });
  await flush();
  const dots = [...target.querySelectorAll('.radar-dot')];
  expect(dots).toHaveLength(2);
  expect(new Set(dots.map((d) => d.getAttribute('cx'))).size).toBe(1);
  expect(new Set(dots.map((d) => d.getAttribute('cy'))).size).toBe(1);
  expect(target.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  const items = [...target.querySelectorAll('ol.radar-list li')].map((li) => li.textContent);
  expect(items).toHaveLength(2);
  expect(items[0]).toContain('Gym');
  expect(items[0]).toContain('2026-10-05');
});

test('horizontal layout is unchanged: no list, svg labelled', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1));
  fetchApi.mockImplementation(() => Promise.resolve(jsonResponse({ items: [
    { scheduleId: 's1', payeeName: 'Gym', date: '2026-10-05', amountCents: -5000, groupName: null },
  ] })));
  const target = mountWidget();
  await flush();
  expect(target.querySelector('ol.radar-list')).toBeNull();
  expect(target.querySelector('svg').getAttribute('role')).toBe('img');
});
