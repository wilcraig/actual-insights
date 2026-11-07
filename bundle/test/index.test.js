// A thrown sessionStorage access (e.g. a SecurityError when site storage is
// blocked) must never prevent the pacing-bars widget from mounting - see
// index.js. mountWidget and maybeRedirectToReports are mocked so this test
// exercises only that ordering/guarding, not their own behavior (covered by
// mount.test.js and redirect.test.js).
import { vi, test, expect } from 'vitest';

vi.mock('../src/mount', () => ({ mountWidget: vi.fn() }));
vi.mock('../src/redirect', () => ({
  maybeRedirectToReports: vi.fn(() => {
    throw new DOMException('blocked', 'SecurityError');
  }),
}));
let lastPacingBarsProps = null;
vi.mock('../src/widgets/PacingBars.svelte', () => ({
  default: class {
    constructor({ props }) {
      lastPacingBarsProps = props;
    }
  },
}));
let lastSpendingHeatmapProps = null;
vi.mock('../src/widgets/SpendingHeatmap.svelte', () => ({
  default: class {
    constructor({ props }) {
      lastSpendingHeatmapProps = props;
    }
  },
}));
vi.mock('../src/widget-builder/mount-toolbar', () => ({ mountWidgetBuilderPanel: vi.fn() }));
vi.mock('../src/widget-builder/WidgetBuilderPanel.svelte', () => ({ default: class {} }));
vi.mock('../src/settings-panel/mount-settings', () => ({ mountSettingsSection: vi.fn() }));
vi.mock('../src/settings-panel/SettingsLinkCard.svelte', () => ({ default: class SettingsLinkCardMock {} }));
vi.mock('../src/insights-page/mount-page', () => ({ mountInsightsPage: vi.fn() }));
vi.mock('../src/insights-page/sidebar-entry', () => ({ mountSidebarEntry: vi.fn() }));

test('mountWidget still runs when accessing sessionStorage throws', async () => {
  const { mountWidget } = await import('../src/mount');

  await import('../src/index.js');

  expect(mountWidget).toHaveBeenCalled();
});

test('mountWidgetBuilderPanel is called to mount the widget-builder panel', async () => {
  // Without this, '../src/index.js' would resolve from the module cache
  // populated by the previous test's import, so this test's own import
  // wouldn't actually re-run index.js - the assertion would only pass
  // because the earlier test had already called mountWidgetBuilderPanel.
  vi.resetModules();

  const { mountWidgetBuilderPanel } = await import('../src/widget-builder/mount-toolbar');

  await import('../src/index.js');

  expect(mountWidgetBuilderPanel).toHaveBeenCalled();
});

test('mountSettingsSection is called to mount the settings-page section', async () => {
  vi.resetModules();

  const { mountSettingsSection } = await import('../src/settings-panel/mount-settings');

  await import('../src/index.js');

  expect(mountSettingsSection).toHaveBeenCalled();
});

test('mounts the Insights page and its sidebar entry, and the Settings page gets the link card', async () => {
  vi.resetModules();

  const { mountInsightsPage } = await import('../src/insights-page/mount-page');
  const { mountSidebarEntry } = await import('../src/insights-page/sidebar-entry');
  const { mountSettingsSection } = await import('../src/settings-panel/mount-settings');

  await import('../src/index.js');

  // Identity checks: a deep-equality matcher on `window` walks its
  // properties and trips over Svelte's rune globals.
  expect(mountInsightsPage.mock.lastCall[0]).toBe(document);
  expect(mountInsightsPage.mock.lastCall[1]).toBe(window);
  expect(mountSidebarEntry.mock.lastCall[0]).toBe(document);
  expect(mountSidebarEntry.mock.lastCall[1]).toBe(window);
  expect(mountSettingsSection.mock.lastCall[2].name).toBe('SettingsLinkCardMock');
});

test('a throw while mounting the Insights page never stops the sidebar entry or anything else', async () => {
  vi.resetModules();

  const { mountInsightsPage } = await import('../src/insights-page/mount-page');
  const { mountSidebarEntry } = await import('../src/insights-page/sidebar-entry');
  mountInsightsPage.mockImplementationOnce(() => {
    throw new Error('unexpected markup');
  });
  mountSidebarEntry.mockClear();

  await expect(import('../src/index.js')).resolves.toBeDefined();
  expect(mountSidebarEntry).toHaveBeenCalled();
});

// Regression test for a final-review finding: the widget builder has exactly
// one field for spending-heatmap, so buildPlaceholder's single-field
// convention emits the bare string "year" rather than {"range":"year"} -- the
// mount callback must accept both shapes, not just the object one a human
// hand-typing the placeholder would reach for.
test('spending-heatmap mount callback accepts both a bare range string (builder output) and a {range} object', async () => {
  vi.resetModules();
  lastSpendingHeatmapProps = null;

  const { mountWidget } = await import('../src/mount');
  await import('../src/index.js');

  const heatmapCall = mountWidget.mock.calls.find(
    ([prefix]) => prefix === '{{INSIGHTS:spending-heatmap:',
  );
  const [, callback] = heatmapCall;

  callback(document.createElement('div'), 'year');
  expect(lastSpendingHeatmapProps).toEqual({ range: 'year' });

  callback(document.createElement('div'), { range: 'year' });
  expect(lastSpendingHeatmapProps).toEqual({ range: 'year' });

  callback(document.createElement('div'), {});
  expect(lastSpendingHeatmapProps).toEqual({ range: 'month' });
});

test('pacing-bars mount callback accepts the legacy array and the {categoryIds, allGroups} object', async () => {
  vi.resetModules();
  lastPacingBarsProps = null;

  const { mountWidget } = await import('../src/mount');
  await import('../src/index.js');

  const [, callback] = mountWidget.mock.calls.find(([prefix]) => prefix === '{{INSIGHTS:pacing-bars:');

  callback(document.createElement('div'), ['catA', { title: 'T', budgets: ['catB'] }]);
  expect(lastPacingBarsProps).toEqual({ items: ['catA', { title: 'T', budgets: ['catB'] }], allGroups: false });

  callback(document.createElement('div'), { categoryIds: ['catA'], allGroups: true });
  expect(lastPacingBarsProps).toEqual({ items: ['catA'], allGroups: true });

  callback(document.createElement('div'), { categoryIds: [], allGroups: true, groupIds: ['g2', 'g1'] });
  expect(lastPacingBarsProps).toEqual({ items: [], allGroups: true, groupIds: ['g2', 'g1'] });

  callback(document.createElement('div'), { allGroups: true });
  expect(lastPacingBarsProps).toEqual({ items: [], allGroups: true });

  callback(document.createElement('div'), null);
  expect(lastPacingBarsProps).toEqual({ items: [], allGroups: false });
});
