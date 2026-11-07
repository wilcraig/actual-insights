import { tick } from 'svelte';
import WidgetBuilderPanel from '../../src/widget-builder/WidgetBuilderPanel.svelte';

vi.mock('../../src/api-client', () => ({
  fetchApi: vi.fn(),
}));

// Adds a synthetic widget with a group-multiselect field alongside the real
// registry entries, so this suite can exercise the field type without
// waiting on a real widget (savings-rate gauge, Task 7) to land and without
// editing registry.js as part of this task.
vi.mock('../../src/widget-builder/registry', async () => {
  const actual = await vi.importActual('../../src/widget-builder/registry');
  return {
    WIDGET_REGISTRY: [
      ...actual.WIDGET_REGISTRY,
      {
        id: 'test-group-widget',
        label: 'Test group widget',
        fields: [
          { key: 'groupIds', type: 'group-multiselect', label: 'Groups' },
        ],
      },
    ],
  };
});

import { fetchApi } from '../../src/api-client';

function mount() {
  // Whether/where this is shown in the page is controlled externally by
  // mount-toolbar.js (see mount-toolbar.test.js) -- the component itself
  // just renders its content unconditionally once constructed.
  const target = document.createElement('div');
  document.body.appendChild(target);
  return new WidgetBuilderPanel({ target });
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body };
}

async function flush() {
  // Let pending microtasks (the async loadPickerData fetch/json chain) and
  // Svelte's own reactive updates settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

function open() {
  document.querySelector('.actualmint-wb-toggle').click();
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/reports/custom');
  fetchApi.mockReset();
});

test('closes the dropdown when navigating away from Reports', async () => {
  fetchApi.mockResolvedValueOnce({ ok: false, status: 500 });
  mount();
  await flush();
  open();
  await flush();
  expect(document.querySelector('.actualmint-wb-panel')).not.toBeNull();

  window.history.pushState({}, '', '/budget');
  await flush();

  expect(document.querySelector('.actualmint-wb-panel')).toBeNull();
});

// selectWidget() fetches picker data eagerly at mount time (regardless of
// whether the panel is open yet), so every test's first fetch happens
// during mount() + flush(), before the panel is ever opened.

test('refetches picker data on open after a prior failure, but not after a success', async () => {
  fetchApi.mockResolvedValueOnce({ ok: false, status: 500 }); // initial load at mount
  mount();
  await flush();
  expect(fetchApi).toHaveBeenCalledTimes(1);

  // Opening after a failed load should retry.
  fetchApi.mockResolvedValueOnce({ ok: false, status: 500 });
  open();
  await flush();
  expect(fetchApi).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.actualmint-wb-error')).not.toBeNull();

  // Close, then reopen with a mock queued that succeeds.
  open(); // close
  await flush();
  fetchApi.mockResolvedValueOnce(okJson({ categories: [{ id: 'c1', name: 'Groceries' }] }));
  open(); // reopen after failure -> refetch #3, succeeds
  await flush();
  expect(fetchApi).toHaveBeenCalledTimes(3);
  expect(document.querySelector('.actualmint-wb-error')).toBeNull();

  // Close and reopen again: last attempt succeeded, so no further refetch.
  open();
  await flush();
  open();
  await flush();
  expect(fetchApi).toHaveBeenCalledTimes(3);
});

test('shows an error when the response body has no usable array', async () => {
  fetchApi.mockResolvedValueOnce(okJson({ categories: 'not-an-array' }));
  mount();
  await flush();
  open();
  await flush();

  expect(document.querySelector('.actualmint-wb-loading')).toBeNull();
  expect(document.querySelector('.actualmint-wb-error')).not.toBeNull();
});

test('filters options by name and group as the user types', async () => {
  fetchApi.mockResolvedValueOnce(
    okJson({
      categories: [
        { id: 'c1', name: 'Groceries', groupName: 'Everyday' },
        { id: 'c2', name: 'Rent', groupName: 'Fixed' },
      ],
    }),
  );
  mount();
  await flush();
  open();
  await flush();

  expect(document.querySelectorAll('.actualmint-wb-options li').length).toBe(2);

  const filterInput = document.querySelector('.actualmint-wb-filter');
  filterInput.value = 'fixed';
  filterInput.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();

  const items = document.querySelectorAll('.actualmint-wb-options li');
  expect(items.length).toBe(1);
  expect(items[0].textContent).toContain('Rent');
});

test('Generate is disabled until a field with options has a selection', async () => {
  fetchApi.mockResolvedValueOnce(
    okJson({ categories: [{ id: 'c1', name: 'Groceries' }] }),
  );
  mount();
  await flush();
  open();
  await flush();

  const generateButton = document.querySelector('.actualmint-wb-generate');
  expect(generateButton.disabled).toBe(true);

  document.querySelector('.actualmint-wb-options input[type="checkbox"]').click();
  await flush();
  expect(generateButton.disabled).toBe(false);
});

test('Generate selects the textarea contents once a selection is made', async () => {
  fetchApi.mockResolvedValueOnce(
    okJson({ categories: [{ id: 'c1', name: 'Groceries' }] }),
  );
  mount();
  await flush();
  open();
  await flush();

  document.querySelector('.actualmint-wb-options input[type="checkbox"]').click();
  await flush();

  const textarea = document.querySelector('.actualmint-wb-textarea');
  const selectSpy = vi.spyOn(textarea, 'select');

  document.querySelector('.actualmint-wb-generate').click();
  await flush();

  expect(selectSpy).toHaveBeenCalled();
  expect(textarea.value).toBe('{{INSIGHTS:pacing-bars:["c1"]}}');
});

test('a zero-field widget (e.g. month-end-net) is immediately generatable, no picker fetch', async () => {
  // pacing-bars (the default-selected widget) fetches its category picker
  // data eagerly at mount time regardless of which widget ends up chosen;
  // give it a clean response so this test's own fetchApi count assertion
  // isn't muddied by an unrelated error path.
  fetchApi.mockResolvedValueOnce(okJson({ categories: [{ id: 'c1', name: 'Groceries' }] }));
  mount();
  await flush();
  open();
  await flush();

  const select = document.querySelector('.actualmint-wb-field select');
  select.value = 'month-end-net';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();

  // Selecting a zero-field widget must not trigger any picker fetch -- the
  // one fetch so far is pacing-bars' own eager load from mount().
  expect(fetchApi).toHaveBeenCalledTimes(1);

  const generateButton = document.querySelector('.actualmint-wb-generate');
  expect(generateButton.disabled).toBe(false);

  generateButton.click();
  await flush();

  expect(document.querySelector('.actualmint-wb-textarea').value).toBe('{{INSIGHTS:month-end-net:{}}}');
});

test('a group-multiselect field fetches from the groups source and lets multiple groups be toggled', async () => {
  fetchApi.mockResolvedValueOnce(okJson({ categories: [{ id: 'c1', name: 'Groceries' }] })); // pacing-bars' eager load at mount
  mount();
  await flush();
  open();
  await flush();

  fetchApi.mockResolvedValueOnce(
    okJson({
      groups: [
        { id: 'g1', name: 'Everyday Expenses' },
        { id: 'g2', name: 'Fixed Costs' },
      ],
    }),
  );
  const widgetSelect = document.querySelector('.actualmint-wb-field select');
  widgetSelect.value = 'test-group-widget';
  widgetSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();

  expect(fetchApi).toHaveBeenLastCalledWith('/api/category-groups');

  const checkboxes = document.querySelectorAll('.actualmint-wb-options input[type="checkbox"]');
  expect(checkboxes.length).toBe(2);

  checkboxes[0].click();
  checkboxes[1].click();
  await flush();

  const generateButton = document.querySelector('.actualmint-wb-generate');
  expect(generateButton.disabled).toBe(false);
  generateButton.click();
  await flush();
  expect(document.querySelector('.actualmint-wb-textarea').value).toBe(
    '{{INSIGHTS:test-group-widget:["g1","g2"]}}',
  );
});

test('an optional group-multiselect field (e.g. savings-rate-gauge\'s investmentGroupIds) does not block Generate while empty', async () => {
  fetchApi.mockResolvedValueOnce(okJson({ categories: [{ id: 'c1', name: 'Groceries' }] })); // pacing-bars' eager load at mount
  mount();
  await flush();
  open();
  await flush();

  fetchApi.mockResolvedValueOnce(okJson({ groups: [] }));
  const widgetSelect = document.querySelector('.actualmint-wb-field select');
  widgetSelect.value = 'savings-rate-gauge';
  widgetSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();

  const generateButton = document.querySelector('.actualmint-wb-generate');
  expect(generateButton.disabled).toBe(false);

  generateButton.click();
  await flush();
  expect(document.querySelector('.actualmint-wb-textarea').value).toBe(
    '{{INSIGHTS:savings-rate-gauge:[]}}',
  );
});

test('a select-type field (account-balances\' labelContent) defaults to its first option and is included in the generated object', async () => {
  fetchApi.mockResolvedValueOnce(okJson({ categories: [{ id: 'c1', name: 'Groceries' }] })); // pacing-bars' eager load at mount
  mount();
  await flush();
  open();
  await flush();

  fetchApi.mockResolvedValueOnce(okJson({ accounts: [{ id: 'acc1', name: 'Checking' }] }));
  const widgetSelect = document.querySelector('.actualmint-wb-field select');
  widgetSelect.value = 'account-balances';
  widgetSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();

  const labelSelect = document.querySelectorAll('.actualmint-wb-field select')[1];
  expect(labelSelect.value).toBe('both');

  // Still blocked on the account-multiselect field, which has no default.
  expect(document.querySelector('.actualmint-wb-generate').disabled).toBe(true);

  document.querySelector('.actualmint-wb-options input[type="checkbox"]').click();
  await flush();

  const generateButton = document.querySelector('.actualmint-wb-generate');
  expect(generateButton.disabled).toBe(false);
  generateButton.click();
  await flush();
  expect(document.querySelector('.actualmint-wb-textarea').value).toBe(
    '{{INSIGHTS:account-balances:{"accountIds":["acc1"],"labelContent":"both"}}}',
  );

  labelSelect.value = 'amount';
  labelSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  generateButton.click();
  await flush();
  expect(document.querySelector('.actualmint-wb-textarea').value).toBe(
    '{{INSIGHTS:account-balances:{"accountIds":["acc1"],"labelContent":"amount"}}}',
  );
});

const GROUPS_BODY = {
  groups: [
    { id: 'g1', name: 'Bills', isIncome: false, isTransfer: false, categoryIds: ['c1'] },
    { id: 'g2', name: 'Personal Income', isIncome: true, isTransfer: false, categoryIds: ['c3'] },
    { id: 'g3', name: 'Fun', isIncome: false, isTransfer: false, categoryIds: ['c2'] },
    { id: 'g4', name: 'Food', isIncome: false, isTransfer: false, categoryIds: ['c4'] },
  ],
};

function groupBox() {
  return [...document.querySelectorAll('.actualmint-wb-checkbox')].find((l) => l.textContent.trim() === 'Category Groups').querySelector('input');
}

async function setUpPacingWithGroups() {
  fetchApi.mockImplementation(async (path) => (path === '/api/category-groups' ? okJson(GROUPS_BODY) : okJson({ categories: [{ id: 'c1', name: 'Groceries' }, { id: 'c2', name: 'Fuel' }] })));
  mount();
  await flush();
  open();
  await flush();
}

const groupNames = () => [...document.querySelectorAll('.actualmint-wb-group-row')].map((li) => li.textContent.replace(/[\u2191\u2193]/g, '').trim());

test('pacing bars: ticking Category Groups allows Generate with no categories and emits the object with groupIds; unticked keeps the bare array', async () => {
  await setUpPacingWithGroups();
  const generate = document.querySelector('.actualmint-wb-generate');
  const textarea = document.querySelector('.actualmint-wb-textarea');
  expect(document.querySelector('.actualmint-wb-group-list')).toBeNull();
  expect(generate.disabled).toBe(true);

  groupBox().click();
  await flush();
  expect(generate.disabled).toBe(false);
  expect(groupNames()).toEqual(['Bills', 'Fun', 'Food']);
  expect(document.body.textContent).toMatch(/created later will not appear until the widget is regenerated/);
  generate.click();
  await flush();
  expect(textarea.value).toBe('{{INSIGHTS:pacing-bars:{"categoryIds":[],"allGroups":true,"groupIds":["g1","g3","g4"]}}}');

  document.querySelector('.actualmint-wb-options:not(.actualmint-wb-group-list) input[type="checkbox"]').click();
  await flush();
  generate.click();
  await flush();
  expect(textarea.value).toBe('{{INSIGHTS:pacing-bars:{"categoryIds":["c1"],"allGroups":true,"groupIds":["g1","g3","g4"]}}}');

  groupBox().click();
  await flush();
  expect(document.querySelector('.actualmint-wb-group-list')).toBeNull();
  generate.click();
  await flush();
  expect(textarea.value).toBe('{{INSIGHTS:pacing-bars:["c1"]}}');

  document.querySelector('.actualmint-wb-options input[type="checkbox"]').click();
  await flush();
  expect(generate.disabled).toBe(true);
});

test('pacing bars: groups can be unchecked and moved with labelled up/down buttons; groupIds follow the chosen order', async () => {
  await setUpPacingWithGroups();
  groupBox().click();
  await flush();

  const btn = (label) => document.querySelector(`button[aria-label="${label}"]`);
  expect(btn('Move Bills up').disabled).toBe(true);
  expect(btn('Move Food down').disabled).toBe(true);

  btn('Move Food up').click();
  await flush();
  expect(groupNames()).toEqual(['Bills', 'Food', 'Fun']);
  btn('Move Bills down').click();
  await flush();
  expect(groupNames()).toEqual(['Food', 'Bills', 'Fun']);

  document.querySelector('input[aria-label="Show Fun"]').click();
  await flush();

  document.querySelector('.actualmint-wb-generate').click();
  await flush();
  expect(document.querySelector('.actualmint-wb-textarea').value).toBe('{{INSIGHTS:pacing-bars:{"categoryIds":[],"allGroups":true,"groupIds":["g4","g1"]}}}');
});

test('pacing bars: with every group unchecked, Generate needs a picked category', async () => {
  await setUpPacingWithGroups();
  groupBox().click();
  await flush();
  for (const name of ['Bills', 'Fun', 'Food']) document.querySelector(`input[aria-label="Show ${name}"]`).click();
  await flush();
  const generate = document.querySelector('.actualmint-wb-generate');
  expect(generate.disabled).toBe(true);

  document.querySelector('.actualmint-wb-options:not(.actualmint-wb-group-list) input[type="checkbox"]').click();
  await flush();
  expect(generate.disabled).toBe(false);
  generate.click();
  await flush();
  expect(document.querySelector('.actualmint-wb-textarea').value).toBe('{{INSIGHTS:pacing-bars:{"categoryIds":["c1"],"allGroups":true,"groupIds":[]}}}');
});

test('pacing bars: a failing group list shows an error and blocks Generate', async () => {
  fetchApi.mockImplementation(async (path) => (path === '/api/category-groups' ? { ok: false, status: 500 } : okJson({ categories: [{ id: 'c1', name: 'Groceries' }] })));
  mount();
  await flush();
  open();
  await flush();
  groupBox().click();
  await flush();
  expect(document.querySelector('.actualmint-wb-groups [role="alert"]')).not.toBeNull();
  expect(document.querySelector('.actualmint-wb-generate').disabled).toBe(true);
});
