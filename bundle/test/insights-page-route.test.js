import {
  INSIGHTS_PAGE_HASH,
  TAB_IDS,
  isInsightsPageHash,
  tabFromHash,
  insightsHash,
  navigateToInsights,
} from '../src/insights-page/route';
import { maybeRedirectToReports } from '../src/redirect';

// The page lives in the URL hash, on whatever path the user is on (see
// docs/insights-page-hosting-notes.md: Actual's router redirects any
// unknown path, `/actual-insights` included, to /budget on a refresh).

test('exports the page hash and tab ids', () => {
  expect(INSIGHTS_PAGE_HASH).toBe('#actual-insights');
  expect(TAB_IDS).toEqual(['general', 'summaries', 'channels', 'forecast', 'mobile']);
});

test('isInsightsPageHash matches the bare page hash and any tab under it', () => {
  expect(isInsightsPageHash('#actual-insights')).toBe(true);
  expect(isInsightsPageHash('#actual-insights/')).toBe(true);
  expect(isInsightsPageHash('#actual-insights/summaries')).toBe(true);
  expect(isInsightsPageHash('#actual-insights/bogus')).toBe(true);
  expect(isInsightsPageHash('')).toBe(false);
  expect(isInsightsPageHash('#')).toBe(false);
  expect(isInsightsPageHash('#summaries')).toBe(false);
  expect(isInsightsPageHash('#actual-insightsx')).toBe(false);
  expect(isInsightsPageHash(undefined)).toBe(false);
});

test('tabFromHash reads the tab, defaulting to general', () => {
  expect(tabFromHash('#actual-insights/summaries')).toBe('summaries');
  expect(tabFromHash('#actual-insights/channels')).toBe('channels');
  expect(tabFromHash('#actual-insights/forecast')).toBe('forecast');
  expect(tabFromHash('#actual-insights/general')).toBe('general');
  expect(tabFromHash('#actual-insights')).toBe('general');
  expect(tabFromHash('#actual-insights/bogus')).toBe('general');
  expect(tabFromHash('')).toBe('general');
  expect(tabFromHash('#summaries')).toBe('general');
});

test('insightsHash builds the hash for a tab (general is the bare hash)', () => {
  expect(insightsHash()).toBe('#actual-insights');
  expect(insightsHash('general')).toBe('#actual-insights');
  expect(insightsHash('channels')).toBe('#actual-insights/channels');
  expect(insightsHash('bogus')).toBe('#actual-insights');
});

test('navigateToInsights pushes the hash onto the current path via pushState', () => {
  window.history.replaceState(null, '', '/budget?x=1');
  const pushSpy = vi.spyOn(window.history, 'pushState');

  navigateToInsights(window, 'channels');

  expect(pushSpy).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe('/budget');
  expect(window.location.search).toBe('?x=1');
  expect(window.location.hash).toBe('#actual-insights/channels');
  pushSpy.mockRestore();
});

test('navigateToInsights defaults to the General tab', () => {
  window.history.replaceState(null, '', '/reports/abc');

  navigateToInsights(window);

  expect(window.location.pathname).toBe('/reports/abc');
  expect(window.location.hash).toBe('#actual-insights');
});

test('navigateToInsights does not push a duplicate entry for the same tab', () => {
  window.history.replaceState(null, '', '/budget#actual-insights/summaries');
  const pushSpy = vi.spyOn(window.history, 'pushState');

  navigateToInsights(window, 'summaries');

  expect(pushSpy).not.toHaveBeenCalled();
  pushSpy.mockRestore();
});

test('the once-per-tab Budget -> Reports redirect leaves an Insights page load alone', () => {
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  const location = { pathname: '/budget', hash: '#actual-insights/summaries', href: '' };

  maybeRedirectToReports(location, storage);

  expect(location.href).toBe('');
});
