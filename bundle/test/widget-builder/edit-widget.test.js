import { WIDGET_REGISTRY } from '../../src/widget-builder/registry';
import { placeholderFor } from '../../src/widget-builder/builder-state';
import {
  parsePlaceholderText,
  valuesFromBody,
  applyGroupIds,
  locateDashboardWidget,
  saveWidgetText,
} from '../../src/widget-builder/edit-widget';

const widget = (id) => WIDGET_REGISTRY.find((w) => w.id === id);

describe('parsePlaceholderText', () => {
  test('finds the id, parsed body and exact raw text, with markdown around it', () => {
    const raw = '{{INSIGHTS:account-balance-list:{"accountIds":["a"],"showTotal":true}}}';
    expect(parsePlaceholderText(`### Title\n\n${raw}\n\nmore`)).toEqual({
      widgetId: 'account-balance-list',
      body: { accountIds: ['a'], showTotal: true },
      raw,
    });
  });

  test('accepts the legacy prefix and null / array bodies, and skips text that is not a placeholder', () => {
    expect(parsePlaceholderText('{{ACTUALMINT:month-end-net:null}}')).toMatchObject({ widgetId: 'month-end-net', body: null });
    expect(parsePlaceholderText('{{INSIGHTS:savings-rate-gauge:["g1"]}} and {{INSIGHTS:burn-rate:null}}')).toMatchObject({ widgetId: 'savings-rate-gauge' });
    expect(parsePlaceholderText('hello')).toBeNull();
    expect(parsePlaceholderText('{{INSIGHTS:pacing-bars:not json}}')).toBeNull();
    expect(parsePlaceholderText('{{INSIGHTS:Bad Id:[]}}')).toBeNull();
    expect(parsePlaceholderText(undefined)).toBeNull();
  });
});

describe('valuesFromBody', () => {
  test('is the inverse of the builder for every widget it can build', () => {
    const cases = [
      ['pacing-bars', { categoryIds: ['c1', 'c2'], allGroups: false }],
      ['account-balances', { accountIds: ['a'], labelContent: 'name', chart: 'lines', range: '1Y' }],
      ['account-balance-list', { accountIds: [], showTotal: true }],
      ['savings-goals-thermometers', { categoryIds: ['c1'] }],
      ['savings-rate-gauge', { investmentGroupIds: ['g1'] }],
      ['subscription-radar', { layout: 'vertical', excludeCategoryIds: ['c9'] }],
      ['spending-heatmap', { range: 'year' }],
    ];
    for (const [id, values] of cases) {
      const w = widget(id);
      const text = placeholderFor(w, values);
      const parsed = parsePlaceholderText(text);
      expect(valuesFromBody(w, parsed.body).values).toEqual({ ...values });
    }
  });

  test('pacing bars: the legacy bare array and the {allGroups, groupIds} object', () => {
    const pacing = widget('pacing-bars');
    expect(valuesFromBody(pacing, ['c1'])).toEqual({ values: { categoryIds: ['c1'], allGroups: false }, groupIds: null });
    expect(valuesFromBody(pacing, { categoryIds: ['c1'], allGroups: true, groupIds: ['g2', 'g1'] })).toEqual({
      values: { categoryIds: ['c1'], allGroups: true },
      groupIds: ['g2', 'g1'],
    });
  });

  test('older bare-array account-balances bodies fill the account list and keep the other defaults', () => {
    expect(valuesFromBody(widget('account-balances'), ['a', 'b']).values).toEqual({ accountIds: ['a', 'b'], labelContent: 'both', chart: 'stacked', range: '1M' });
  });

  test('unusable values fall back to defaults instead of breaking the form', () => {
    const w = widget('account-balances');
    const { values } = valuesFromBody(w, { accountIds: 'oops', labelContent: 'sideways', chart: 7, range: null });
    expect(values).toEqual({ accountIds: [], labelContent: 'both', chart: 'stacked', range: '1M' });
    expect(valuesFromBody(widget('month-end-net'), null)).toEqual({ values: {}, groupIds: null });
  });
});

test('applyGroupIds puts the saved groups first, checked and in order, and the rest after, unchecked', () => {
  const rows = [{ id: 'a', name: 'A', checked: true }, { id: 'b', name: 'B', checked: true }, { id: 'c', name: 'C', checked: true }];
  expect(applyGroupIds(rows, ['c', 'a', 'gone'])).toEqual([
    { id: 'c', name: 'C', checked: true },
    { id: 'a', name: 'A', checked: true },
    { id: 'b', name: 'B', checked: false },
  ]);
});

describe('locating and saving the dashboard widget', () => {
  const raw = '{{INSIGHTS:burn-rate:null}}';
  const q = () => ({ select: (x) => x });

  test('finds the Text widget on this dashboard whose content holds the placeholder, parsing string or object meta', async () => {
    const query = async () => ({ data: [
      { id: 'gone', type: 'markdown-card', tombstone: 1, dashboard_page_id: 'd', meta: { content: raw } },
      { id: 'elsewhere', type: 'markdown-card', dashboard_page_id: 'other', meta: { content: raw } },
      { id: 'notes', type: 'markdown-card', dashboard_page_id: 'd', meta: { content: 'no widget here' } },
      { id: 'cash', type: 'cash-flow-card', dashboard_page_id: 'd', meta: { content: raw } },
      { id: 'bad', type: 'markdown-card', dashboard_page_id: 'd', meta: '{oops' },
      { id: 'hit', type: 'markdown-card', dashboard_page_id: 'd', meta: JSON.stringify({ content: `x ${raw}`, text_align: 'center' }) },
    ] });
    expect(await locateDashboardWidget({ query, q, dashboardId: 'd', raw })).toEqual({ id: 'hit', meta: { content: `x ${raw}`, text_align: 'center' } });
    expect(await locateDashboardWidget({ query: async () => ({ data: [] }), q, dashboardId: 'd', raw })).toBeNull();
    expect(await locateDashboardWidget({ query: async () => ({}), q, dashboardId: 'd', raw })).toBeNull();
  });

  test('saveWidgetText swaps only the placeholder, keeps the rest of the meta, and surfaces an error result', async () => {
    const send = vi.fn(async () => ({}));
    await saveWidgetText({ send, widget: { id: 'w', meta: { content: `a ${raw} b $& c`, text_align: 'left' } }, raw, newText: '{{INSIGHTS:burn-rate:{"x":"$&"}}}' });
    expect(send).toHaveBeenCalledWith('dashboard-update-widget', {
      id: 'w',
      meta: { content: 'a {{INSIGHTS:burn-rate:{"x":"$&"}}} b $& c', text_align: 'left' },
    });
    await expect(saveWidgetText({ send: async () => ({ error: { type: 'x' } }), widget: { id: 'w', meta: { content: raw } }, raw, newText: 'y' })).rejects.toThrow();
  });
});
