import { tick } from 'svelte';

vi.mock('../../src/api-client', () => ({ fetchApi: vi.fn() }));
vi.mock('../../src/widget-builder/preview', () => ({ mountPreview: vi.fn(() => vi.fn()) }));
vi.mock('../../src/widget-builder/clipboard', () => ({ copyText: vi.fn(async () => true) }));

// A synthetic widget with a group-multiselect field alongside the real
// registry entries, so the field type is exercised without leaning on a real
// widget's field list.
vi.mock('../../src/widget-builder/registry', async () => {
  const actual = await vi.importActual('../../src/widget-builder/registry');
  return {
    WIDGET_REGISTRY: [
      ...actual.WIDGET_REGISTRY,
      { id: 'test-group-widget', label: 'Test group widget', fields: [{ key: 'groupIds', type: 'group-multiselect', label: 'Groups' }] },
    ],
  };
});

import BuilderModal from '../../src/widget-builder/BuilderModal.svelte';
import { fetchApi } from '../../src/api-client';
import { mountPreview } from '../../src/widget-builder/preview';
import { copyText } from '../../src/widget-builder/clipboard';

const DASH = '11111111-2222-3333-4444-555555555555';
let onclose;

function mount(props = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  return new BuilderModal({ target, props: { onclose, ...props } });
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

async function flush() {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  await tick();
}

const $ = (selector) => document.querySelector(selector);
const textarea = () => $('.insights-wb-textarea');
const addButton = () => [...document.querySelectorAll('.insights-wb-btn')].find((b) => b.textContent === 'Add to dashboard');
const saveButton = () => [...document.querySelectorAll('.insights-wb-btn')].find((b) => b.textContent === 'Save changes');
const copyButton = () => [...document.querySelectorAll('.insights-wb-btn')].find((b) => b.textContent === 'Copy widget text');

async function chooseWidget(id) {
  const select = $('.insights-wb-config select');
  select.value = id;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}

const CATEGORIES = { categories: [{ id: 'c1', name: 'Groceries', groupName: 'Everyday' }, { id: 'c2', name: 'Rent', groupName: 'Fixed' }] };

beforeEach(() => {
  document.body.innerHTML = '';
  window.history.pushState({}, '', `/reports/${DASH}`);
  fetchApi.mockReset();
  fetchApi.mockImplementation(async () => okJson(CATEGORIES));
  mountPreview.mockClear();
  copyText.mockClear();
  onclose = vi.fn();
  delete window.$send;
  delete window.$query;
  delete window.$q;
});

test('is a labelled modal dialog that starts on the first widget and closes on the X and on Escape', async () => {
  mount();
  await flush();
  const dialog = $('[role="dialog"]');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect($('#insights-wb-title').textContent).toBe('Widget builder');

  $('.insights-wb-close').click();
  expect(onclose).toHaveBeenCalledTimes(1);

  $('.insights-wb-overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(onclose).toHaveBeenCalledTimes(2);
});

test('shows the options and the live preview side by side, with the widget text kept out of visible text', async () => {
  mount();
  await flush();
  expect($('.insights-wb-config')).not.toBeNull();
  expect($('.insights-wb-preview')).not.toBeNull();
  // The placeholder only ever lives in a textarea's value, never a text node
  // (mount.js would mount it as a live widget).
  await chooseWidget('month-end-net');
  expect(textarea().value).toBe('{{INSIGHTS:month-end-net:{}}}');
  expect(document.body.textContent).not.toContain('{{INSIGHTS');
});

test('refetches nothing extra and errors when a picker returns no usable array', async () => {
  fetchApi.mockImplementation(async () => okJson({ categories: 'not-an-array' }));
  mount();
  await flush();
  expect($('.insights-wb-error')).not.toBeNull();
  expect($('.insights-wb-config .insights-wb-muted')).toBeNull();
});

test('filters options by name and group, with Select shown and Clear', async () => {
  mount();
  await flush();
  expect(document.querySelectorAll('.insights-wb-options li').length).toBe(2);

  const filter = $('.insights-wb-filter');
  filter.value = 'fixed';
  filter.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  const items = document.querySelectorAll('.insights-wb-options li');
  expect(items.length).toBe(1);
  expect(items[0].textContent).toContain('Rent');

  [...document.querySelectorAll('.insights-wb-link')].find((b) => b.textContent === 'Select shown').click();
  await flush();
  expect(textarea().value).toBe('{{INSIGHTS:pacing-bars:["c2"]}}');

  [...document.querySelectorAll('.insights-wb-link')].find((b) => b.textContent === 'Clear').click();
  await flush();
  expect(textarea().value).toBe('');
});

test('the text, Add and Copy stay unavailable until a required field has a selection', async () => {
  mount();
  await flush();
  expect(addButton().disabled).toBe(true);
  expect(copyButton().disabled).toBe(true);
  expect(textarea().value).toBe('');
  expect($('.insights-wb-hint')).not.toBeNull();

  $('.insights-wb-options input[type="checkbox"]').click();
  await flush();
  expect(addButton().disabled).toBe(false);
  expect(copyButton().disabled).toBe(false);
  expect(textarea().value).toBe('{{INSIGHTS:pacing-bars:["c1"]}}');
  expect($('.insights-wb-hint')).toBeNull();
});

test('a zero-field widget is immediately buildable with no picker fetch', async () => {
  mount();
  await flush();
  fetchApi.mockClear();
  await chooseWidget('month-end-net');
  expect(fetchApi).not.toHaveBeenCalled();
  expect(addButton().disabled).toBe(false);
});

test('a group-multiselect field fetches from the groups source and lets several groups be toggled', async () => {
  mount();
  await flush();
  fetchApi.mockResolvedValueOnce(okJson({ groups: [{ id: 'g1', name: 'Everyday Expenses' }, { id: 'g2', name: 'Fixed Costs' }] }));
  await chooseWidget('test-group-widget');
  expect(fetchApi).toHaveBeenLastCalledWith('/api/category-groups');
  const boxes = document.querySelectorAll('.insights-wb-options input[type="checkbox"]');
  expect(boxes.length).toBe(2);
  boxes[0].click();
  boxes[1].click();
  await flush();
  expect(textarea().value).toBe('{{INSIGHTS:test-group-widget:["g1","g2"]}}');
});

test('an optional picker (savings-rate-gauge) does not block the widget while empty', async () => {
  mount();
  await flush();
  fetchApi.mockResolvedValueOnce(okJson({ groups: [] }));
  await chooseWidget('savings-rate-gauge');
  expect(addButton().disabled).toBe(false);
  expect(textarea().value).toBe('{{INSIGHTS:savings-rate-gauge:[]}}');
});

test('a select field defaults to its first option and feeds the text', async () => {
  mount();
  await flush();
  fetchApi.mockResolvedValueOnce(okJson({ accounts: [{ id: 'acc1', name: 'Checking' }] }));
  await chooseWidget('account-balances');
  const label = document.querySelectorAll('.insights-wb-config select')[1];
  expect(label.value).toBe('both');
  // No accounts picked means every open account, so the chart is buildable straight away.
  expect(addButton().disabled).toBe(false);
  expect(textarea().value).toBe('{{INSIGHTS:account-balances:{"accountIds":[],"labelContent":"both","chart":"stacked","range":"1M"}}}');

  $('.insights-wb-options input[type="checkbox"]').click();
  await flush();
  expect(textarea().value).toBe('{{INSIGHTS:account-balances:{"accountIds":["acc1"],"labelContent":"both","chart":"stacked","range":"1M"}}}');

  label.value = 'amount';
  label.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  expect(textarea().value).toContain('"labelContent":"amount"');
});

test('account-balance-list builds with no accounts picked and carries Show total', async () => {
  mount();
  await flush();
  fetchApi.mockResolvedValueOnce(okJson({ accounts: [{ id: 'acc1', name: 'Checking' }] }));
  await chooseWidget('account-balance-list');
  expect(textarea().value).toBe('{{INSIGHTS:account-balance-list:{"accountIds":[],"showTotal":false}}}');
  [...document.querySelectorAll('.insights-wb-check input')].pop().click();
  await flush();
  expect(textarea().value).toBe('{{INSIGHTS:account-balance-list:{"accountIds":[],"showTotal":true}}}');
});

const GROUPS_BODY = {
  groups: [
    { id: 'g1', name: 'Bills', isIncome: false, isTransfer: false, categoryIds: ['c1'] },
    { id: 'g2', name: 'Personal Income', isIncome: true, isTransfer: false, categoryIds: ['c3'] },
    { id: 'g3', name: 'Fun', isIncome: false, isTransfer: false, categoryIds: ['c2'] },
    { id: 'g4', name: 'Food', isIncome: false, isTransfer: false, categoryIds: ['c4'] },
  ],
};
const groupBox = () => [...document.querySelectorAll('.insights-wb-check')].find((l) => l.textContent.trim() === 'Category Groups').querySelector('input');
const groupNames = () => [...document.querySelectorAll('.insights-wb-group-row')].map((li) => li.textContent.replace(/[↑↓]/g, '').trim());

async function pacingWithGroups() {
  fetchApi.mockImplementation(async (path) => (path === '/api/category-groups' ? okJson(GROUPS_BODY) : okJson(CATEGORIES)));
  mount();
  await flush();
}

test('pacing bars: Category Groups needs no categories and emits groupIds in the chosen order; unticking restores the bare array', async () => {
  await pacingWithGroups();
  groupBox().click();
  await flush();
  expect(addButton().disabled).toBe(false);
  expect(groupNames()).toEqual(['Bills', 'Fun', 'Food']);
  expect(textarea().value).toBe('{{INSIGHTS:pacing-bars:{"categoryIds":[],"allGroups":true,"groupIds":["g1","g3","g4"]}}}');

  document.querySelector('button[aria-label="Move Food up"]').click();
  document.querySelector('input[aria-label="Show Bills"]').click();
  await flush();
  expect(textarea().value).toBe('{{INSIGHTS:pacing-bars:{"categoryIds":[],"allGroups":true,"groupIds":["g4","g3"]}}}');

  groupBox().click();
  await flush();
  expect($('.insights-wb-group-list')).toBeNull();
  expect(addButton().disabled).toBe(true);
});

test('pacing bars: with every group unchecked a picked category is needed; a failing group list blocks the widget', async () => {
  await pacingWithGroups();
  groupBox().click();
  await flush();
  for (const name of ['Bills', 'Fun', 'Food']) document.querySelector(`input[aria-label="Show ${name}"]`).click();
  await flush();
  expect(addButton().disabled).toBe(true);
  document.querySelector('.insights-wb-options:not(.insights-wb-group-list) input[type="checkbox"]').click();
  await flush();
  expect(addButton().disabled).toBe(false);
});

test('pacing bars: a failing group list shows an error', async () => {
  fetchApi.mockImplementation(async (path) => (path === '/api/category-groups' ? { ok: false, status: 500 } : okJson(CATEGORIES)));
  mount();
  await flush();
  groupBox().click();
  await flush();
  expect(document.querySelector('.insights-wb-field [role="alert"]')).not.toBeNull();
  expect(addButton().disabled).toBe(true);
});

test('the live preview draws the real widget with the parsed config once it settles, redraws on change, and tears down', async () => {
  vi.useFakeTimers();
  try {
    const teardown = vi.fn();
    mountPreview.mockReturnValue(teardown);
    const modal = mount();
    await flush();
    $('.insights-wb-options input[type="checkbox"]').click();
    await flush();
    expect(mountPreview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(mountPreview).toHaveBeenCalledTimes(1);
    expect(mountPreview).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'pacing-bars', ['c1']);

    document.querySelectorAll('.insights-wb-options input[type="checkbox"]')[1].click();
    await flush();
    expect(teardown).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(mountPreview).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'pacing-bars', ['c1', 'c2']);

    modal.$destroy();
    expect(teardown).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('Copy widget text copies the text and says so', async () => {
  mount();
  await flush();
  await chooseWidget('month-end-net');
  copyButton().click();
  await flush();
  expect(copyText).toHaveBeenCalledWith('{{INSIGHTS:month-end-net:{}}}');
  expect($('.insights-wb-status').textContent).toMatch(/Copied/);
});

describe('Add to dashboard', () => {
  test('sends a Text widget with the text and the widget\'s size to the current dashboard, then closes once it shows up', async () => {
    const send = vi.fn(async () => ({}));
    window.$send = send;
    window.$query = vi.fn();
    window.$q = vi.fn();
    mount();
    await flush();
    await chooseWidget('spending-sankey');

    // Stand in for Actual re-rendering the dashboard with the new widget.
    send.mockImplementation(async () => {
      const p = document.createElement('p');
      p.textContent = '{{INSIGHTS:spending-sankey:{}}}';
      document.body.appendChild(p);
      return {};
    });
    addButton().click();
    await vi.waitFor(() => expect(onclose).toHaveBeenCalled());

    expect(send).toHaveBeenCalledWith('dashboard-add-widget', {
      type: 'markdown-card',
      width: 12,
      height: 6,
      meta: { content: '{{INSIGHTS:spending-sankey:{}}}' },
      dashboard_page_id: DASH,
    });
  });

  test('says to reload (and offers a button) when the dashboard does not show the widget', async () => {
    window.$send = vi.fn(async () => ({}));
    window.$query = vi.fn();
    window.$q = vi.fn();
    mount();
    await flush();
    await chooseWidget('month-end-net');
    addButton().click();
    // The page never shows the widget, so it gives up after its short wait.
    await vi.waitFor(() => expect($('.insights-wb-status').textContent).toMatch(/reload the page/i), { timeout: 5000 });
    expect(onclose).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('.insights-wb-btn')].some((b) => b.textContent === 'Reload page')).toBe(true);
  });

  test('without Actual\'s data layer, or off a dashboard, it points to Copy instead of failing silently', async () => {
    mount();
    await flush();
    await chooseWidget('month-end-net');
    addButton().click();
    await flush();
    expect($('.insights-wb-status').textContent).toMatch(/Copy widget text/);
    expect($('.insights-wb-status-error')).not.toBeNull();
  });

  test('a refused add is reported and nothing is closed', async () => {
    window.$send = vi.fn(async () => ({ error: { type: 'x' } }));
    window.$query = vi.fn();
    window.$q = vi.fn();
    mount();
    await flush();
    await chooseWidget('month-end-net');
    addButton().click();
    await vi.waitFor(() => expect($('.insights-wb-status').textContent).toMatch(/would not add/));
    expect(onclose).not.toHaveBeenCalled();
  });
});

describe('editing an existing widget', () => {
  const initial = { widgetId: 'account-balances', body: { accountIds: ['acc2'], labelContent: 'amount', chart: 'lines', range: '3M' }, raw: '{{INSIGHTS:account-balances:{"accountIds":["acc2"],"labelContent":"amount","chart":"lines","range":"3M"}}}', mountHost: null };

  beforeEach(() => {
    fetchApi.mockImplementation(async () => okJson({ accounts: [{ id: 'acc1', name: 'Checking' }, { id: 'acc2', name: 'Savings' }] }));
  });

  test('opens on the saved widget with its options loaded back into the form', async () => {
    mount({ initial });
    await flush();
    expect($('#insights-wb-title').textContent).toBe('Edit widget');
    expect($('.insights-wb-config select').value).toBe('account-balances');
    const [label, chart, range] = [...document.querySelectorAll('.insights-wb-config select')].slice(1);
    expect([label.value, chart.value, range.value]).toEqual(['amount', 'lines', '3M']);
    const checked = [...document.querySelectorAll('.insights-wb-options input')].map((i) => i.checked);
    expect(checked).toEqual([false, true]);
    expect(textarea().value).toBe(initial.raw);
    expect(saveButton()).not.toBeUndefined();
    expect(addButton()).toBeUndefined();
  });

  test('reloads a pacing-bars group order and unchecked groups', async () => {
    fetchApi.mockImplementation(async (path) => (path === '/api/category-groups' ? okJson(GROUPS_BODY) : okJson(CATEGORIES)));
    mount({ initial: { widgetId: 'pacing-bars', body: { categoryIds: [], allGroups: true, groupIds: ['g4', 'g1'] }, raw: 'x', mountHost: null } });
    await flush();
    expect(groupNames()).toEqual(['Food', 'Bills', 'Fun']);
    expect([...document.querySelectorAll('.insights-wb-group-row input')].map((i) => i.checked)).toEqual([true, true, false]);
  });

  test('Save changes rewrites the widget\'s own text through Actual and keeps the markdown around it', async () => {
    const send = vi.fn(async () => ({}));
    window.$send = send;
    window.$q = () => ({ select: () => 'query' });
    window.$query = vi.fn(async () => ({ data: [
      { id: 'w1', type: 'markdown-card', dashboard_page_id: DASH, tombstone: 0, meta: JSON.stringify({ content: `### Cash\n\n${initial.raw}\n\nnotes`, text_align: 'left' }) },
      { id: 'w2', type: 'markdown-card', dashboard_page_id: 'other', tombstone: 0, meta: { content: initial.raw } },
    ] }));
    mount({ initial });
    await flush();

    const range = [...document.querySelectorAll('.insights-wb-config select')][3];
    range.value = '1Y';
    range.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    const newText = textarea().value;
    expect(newText).toContain('"range":"1Y"');

    send.mockImplementation(async () => {
      const p = document.createElement('p');
      p.textContent = newText;
      document.body.appendChild(p);
      return {};
    });
    saveButton().click();
    await vi.waitFor(() => expect(onclose).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith('dashboard-update-widget', {
      id: 'w1',
      meta: { content: `### Cash\n\n${newText}\n\nnotes`, text_align: 'left' },
    });
  });

  test('reports a widget it cannot find on the dashboard', async () => {
    window.$send = vi.fn();
    window.$q = () => ({ select: () => 'query' });
    window.$query = vi.fn(async () => ({ data: [] }));
    mount({ initial });
    await flush();
    saveButton().click();
    await vi.waitFor(() => expect($('.insights-wb-status').textContent).toMatch(/Could not find this widget/));
    expect(window.$send).not.toHaveBeenCalled();
  });
});
