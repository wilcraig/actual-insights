vi.mock('../src/api-client', () => ({
  fetchApi: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}));

import { fetchApi } from '../src/api-client';
import { mountInsightsPage, findContentRegion } from '../src/insights-page/mount-page';
import { TABS } from '../src/insights-page/tabs';
import MobileTab from '../src/insights-page/MobileTab.svelte';
import GeneralTab from '../src/insights-page/GeneralTab.svelte';
import SummariesTab from '../src/insights-page/SummariesTab.svelte';
import ChannelsTab from '../src/insights-page/ChannelsTab.svelte';
import ForecastTab from '../src/insights-page/ForecastTab.svelte';

// A cut-down copy of Actual's main column (docs/insights-page-hosting-notes.md):
// a title bar holding the help button, then the page content. jsdom has no
// layout, so the heights findContentRegion measures are stubbed.
const APP_HTML = `
  <div id="sidebar">sidebar</div>
  <div id="main-column">
    <div id="titlebar"><div><button data-testid="help-menu-button">Help</button></div></div>
    <div id="notifications"></div>
    <div id="content">Budget table</div>
  </div>
`;

function stubHeight(el, height) {
  el.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 300, right: 1300, bottom: height, width: 1000, height });
}

function stubLayout() {
  stubHeight(document.getElementById('main-column'), 900);
  stubHeight(document.getElementById('titlebar'), 48);
  stubHeight(document.querySelector('#titlebar > div'), 28);
  stubHeight(document.getElementById('notifications'), 0);
  stubHeight(document.getElementById('content'), 852);
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let unwatch = null;

beforeEach(() => {
  document.body.innerHTML = APP_HTML;
  stubLayout();
  window.history.replaceState(null, '', '/budget');
});

afterEach(() => {
  unwatch?.();
  unwatch = null;
  document.querySelectorAll('[data-insights-page]').forEach((el) => el.remove());
});

function pageContainer() {
  return document.querySelector('[data-insights-page]');
}

function isShown(el) {
  return el.style.display !== 'none';
}

test('TABS lists General, Summaries, Channels, Forecast, Mobile app with General as the real tab', () => {
  expect(TABS.map((t) => t.id)).toEqual(['general', 'summaries', 'channels', 'forecast', 'mobile']);
  expect(TABS.map((t) => t.label)).toEqual(['General', 'Summaries', 'Channels', 'Forecast', 'Mobile app']);
  expect(TABS[0].component).toBe(GeneralTab);
  expect(TABS[1].component).toBe(SummariesTab);
  expect(TABS[2].component).toBe(ChannelsTab);
  expect(TABS[3].component).toBe(ForecastTab);
  expect(TABS[4].component).toBe(MobileTab);
});

test('findContentRegion finds the tallest sibling after the title bar', () => {
  expect(findContentRegion(document)).toBe(document.getElementById('content'));
});

test('findContentRegion returns null before Actual has rendered its title bar', () => {
  document.body.innerHTML = '<div id="root"></div>';
  expect(findContentRegion(document)).toBeNull();
});

test('the page is hidden at /budget and shown at /budget#actual-insights', async () => {
  unwatch = mountInsightsPage(document, window);
  const container = pageContainer();
  expect(container).not.toBeNull();
  expect(isShown(container)).toBe(false);
  expect(document.getElementById('content').style.visibility).toBe('');

  window.history.pushState(null, '', '/budget#actual-insights');
  await flush();

  expect(isShown(container)).toBe(true);
  expect(container.textContent).toContain('Actual Insights');
  // Actual's own content is hidden underneath, the title bar is not.
  expect(document.getElementById('content').style.visibility).toBe('hidden');
  expect(document.getElementById('titlebar').style.visibility).toBe('');
});

test('a direct load with the hash already set shows the page', async () => {
  window.history.replaceState(null, '', '/budget#actual-insights/channels');
  unwatch = mountInsightsPage(document, window);
  await flush();

  expect(isShown(pageContainer())).toBe(true);
  expect(pageContainer().querySelector('[role="tab"][aria-selected="true"]').textContent.trim()).toBe('Channels');
});

test('#actual-insights/summaries selects the Summaries tab and renders it', async () => {
  unwatch = mountInsightsPage(document, window);
  window.history.pushState(null, '', '/budget#actual-insights/summaries');
  await flush();

  const container = pageContainer();
  const selected = container.querySelector('[role="tab"][aria-selected="true"]');
  expect(selected.textContent.trim()).toBe('Summaries');
  expect(container.querySelector('.actualmint-summaries-tab')).not.toBeNull();
  expect(container.querySelector('.actualmint-general-tab')).toBeNull();
});

test('clicking the Channels tab updates location.hash and shows that tab', async () => {
  unwatch = mountInsightsPage(document, window);
  window.history.pushState(null, '', '/budget#actual-insights');
  await flush();

  const container = pageContainer();
  expect(container.querySelector('.actualmint-general-tab')).not.toBeNull();

  const channels = Array.from(container.querySelectorAll('[role="tab"]')).find(
    (b) => b.textContent.trim() === 'Channels',
  );
  channels.click();
  await flush();

  expect(window.location.pathname).toBe('/budget');
  expect(window.location.hash).toBe('#actual-insights/channels');
  expect(channels.getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('.actualmint-general-tab')).toBeNull();
});

test('a hashchange (typed URL, back button) is picked up too', async () => {
  unwatch = mountInsightsPage(document, window);
  window.location.hash = '#actual-insights/summaries';
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await flush();

  expect(isShown(pageContainer())).toBe(true);
  expect(pageContainer().querySelector('[role="tab"][aria-selected="true"]').textContent.trim()).toBe('Summaries');
});

test('navigating away hides the page and restores Actual content; coming back reuses the same container', async () => {
  unwatch = mountInsightsPage(document, window);
  window.history.pushState(null, '', '/budget#actual-insights/summaries');
  await flush();
  const container = pageContainer();
  const tabBar = container.querySelector('[role="tablist"]');

  window.history.pushState(null, '', '/reports');
  await flush();
  expect(isShown(container)).toBe(false);
  expect(document.getElementById('content').style.visibility).toBe('');

  window.history.pushState(null, '', '/reports#actual-insights/summaries');
  await flush();
  expect(pageContainer()).toBe(container);
  expect(container.querySelector('[role="tablist"]')).toBe(tabBar);
  expect(document.querySelectorAll('[data-insights-page]')).toHaveLength(1);
  expect(isShown(container)).toBe(true);
});

test('dispatches insights:page-shown each time the page opens (so the goals list refetches)', async () => {
  const listener = vi.fn();
  document.addEventListener('insights:page-shown', listener);
  unwatch = mountInsightsPage(document, window);

  window.history.pushState(null, '', '/budget#actual-insights');
  await flush();
  expect(listener).toHaveBeenCalledTimes(1);

  // Switching tabs isn't re-opening.
  window.history.pushState(null, '', '/budget#actual-insights/channels');
  await flush();
  expect(listener).toHaveBeenCalledTimes(1);

  window.history.pushState(null, '', '/budget');
  window.history.pushState(null, '', '/budget#actual-insights');
  await flush();
  expect(listener).toHaveBeenCalledTimes(2);
  document.removeEventListener('insights:page-shown', listener);
});

// The outgoing tab is Forecast because earlier tests leave Summaries and
// Channels instances listening (unmount never destroys the page), and no
// test before this one opens Forecast, so its API calls are this page's own.
test('reopening on a different tab does not reload the outgoing tab, and page-shown still fires', async () => {
  unwatch = mountInsightsPage(document, window);
  window.history.pushState(null, '', '/budget#actual-insights/forecast');
  await flush();
  window.history.pushState(null, '', '/budget');
  await flush();

  const listener = vi.fn();
  document.addEventListener('insights:page-shown', listener);
  fetchApi.mockClear();
  window.history.pushState(null, '', '/budget#actual-insights/channels');
  await flush();
  await flush();
  document.removeEventListener('insights:page-shown', listener);

  expect(listener).toHaveBeenCalledTimes(1);
  const paths = fetchApi.mock.calls.map(([path]) => path);
  expect(paths.filter((p) => p.startsWith('/api/forecast'))).toEqual([]);
  expect(paths).toContain('/api/channels');
  expect(pageContainer().querySelector('[role="tab"][aria-selected="true"]').textContent.trim()).toBe('Channels');
});

test('waits for Actual to render its content region before showing', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, '', '/budget#actual-insights');
  unwatch = mountInsightsPage(document, window);
  await flush();
  expect(isShown(pageContainer())).toBe(false);

  document.getElementById('root').innerHTML = APP_HTML;
  stubLayout();
  await flush();

  expect(isShown(pageContainer())).toBe(true);
  expect(document.getElementById('content').style.visibility).toBe('hidden');
});

test('follows a theme change (a <style> added to <head>) while open', async () => {
  const column = document.getElementById('main-column');
  column.style.backgroundColor = 'rgb(1, 2, 3)';
  unwatch = mountInsightsPage(document, window);
  window.history.pushState(null, '', '/budget#actual-insights');
  await flush();
  expect(pageContainer().style.backgroundColor).toBe('rgb(1, 2, 3)');

  column.style.backgroundColor = 'rgb(4, 5, 6)';
  const themeStyle = document.createElement('style');
  document.head.appendChild(themeStyle);
  await flush();

  expect(pageContainer().style.backgroundColor).toBe('rgb(4, 5, 6)');
  themeStyle.remove();
});

test('covers the content region exactly, un-zooming its rect under the text-size zoom', async () => {
  const region = document.getElementById('content');
  region.getBoundingClientRect = () => ({ top: 60, left: 400, width: 1000, height: 840, right: 1400, bottom: 900 });
  unwatch = mountInsightsPage(document, window);
  window.history.pushState(null, '', '/budget#actual-insights');
  await flush();
  expect(pageContainer().style.top).toBe('60px');
  expect(pageContainer().style.left).toBe('400px');
  expect(pageContainer().style.width).toBe('1000px');

  // jsdom has no CSS zoom, so report it the way Chromium does.
  const realGetComputedStyle = window.getComputedStyle.bind(window);
  const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
    const computed = realGetComputedStyle(el);
    return el === document.documentElement ? { ...computed, zoom: '2' } : computed;
  });
  try {
    window.dispatchEvent(new Event('resize'));
    await flush();
    expect(pageContainer().style.top).toBe('30px');
    expect(pageContainer().style.left).toBe('200px');
    expect(pageContainer().style.width).toBe('500px');
    // Down to the bottom of the viewport (jsdom's is 768px tall).
    expect(pageContainer().style.height).toBe(`${(Math.min(900, window.innerHeight) - 60) / 2}px`);
  } finally {
    spy.mockRestore();
  }
});

// Seen live on Actual's long Settings page: the main column scrolls, so
// the content region's rect starts far above the viewport. The overlay
// must cover what's visible below the title bar, not the region's full
// scrolled-away box (which left the page's content off-screen).
test('covers only the visible part of a scrolled content region, below the title bar', async () => {
  const region = document.getElementById('content');
  region.getBoundingClientRect = () => ({ top: -4000, left: 300, width: 1000, height: 9000, right: 1300, bottom: 5000 });
  document.getElementById('titlebar').getBoundingClientRect = () => ({ top: 0, left: 300, width: 1000, height: 48, right: 1300, bottom: 48 });
  unwatch = mountInsightsPage(document, window);
  window.history.pushState(null, '', '/settings#actual-insights');
  await flush();

  const visibleBottom = Math.min(900, window.innerHeight);
  expect(pageContainer().style.top).toBe('48px');
  expect(pageContainer().style.height).toBe(`${visibleBottom - 48}px`);
  expect(pageContainer().style.left).toBe('300px');
  expect(pageContainer().style.width).toBe('1000px');
});

test('#actual-insights/forecast selects the Forecast tab and renders it', async () => {
  unwatch = mountInsightsPage(document, window);
  window.history.pushState(null, '', '/budget#actual-insights/forecast');
  await flush();

  const container = pageContainer();
  expect(container.querySelector('[role="tab"][aria-selected="true"]').textContent.trim()).toBe('Forecast');
  expect(container.querySelector('.actualmint-forecast-tab')).not.toBeNull();
});
