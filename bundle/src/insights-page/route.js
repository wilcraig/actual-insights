// Where the Insights page lives in the URL.
//
// Not a path of its own: Actual's router redirects any path it doesn't
// know (an `/actual-insights` page included) to /budget on a direct load
// or refresh, dropping the hash -- confirmed live, see
// docs/insights-page-hosting-notes.md. So the page lives in the hash
// instead, on whatever real route the user is already on
// (`/budget#actual-insights/summaries`), which survives a refresh. Actual
// keeps rendering that route underneath (react-router never sees a hash
// change made through history.pushState), and leaving is free: every
// Actual nav item pushes a new path without our hash.
//
// Never `/insights/...` either way: that prefix is where insights-proxy
// serves the bundle, and unknown files under it 404.

export const INSIGHTS_PAGE_HASH = '#actual-insights';
export const TAB_IDS = ['general', 'summaries', 'channels', 'forecast', 'mobile'];
const DEFAULT_TAB = 'general';
// Chipmunk mode puts these in front (see docs/chipmunk-mode.md) and makes
// Reports the bare page. Every function below behaves exactly as before
// unless its optional `chipmunk` argument is true.
export const CHIPMUNK_TAB_IDS = ['reports', 'accounts', 'transactions', 'budget'];
export const CHIPMUNK_DEFAULT_TAB = 'reports';

/**
 * True for `#actual-insights` and `#actual-insights/<anything>`.
 * @param {string} hash - `location.hash`
 */
export function isInsightsPageHash(hash) {
  if (typeof hash !== 'string') return false;
  return hash === INSIGHTS_PAGE_HASH || hash.startsWith(`${INSIGHTS_PAGE_HASH}/`);
}

/**
 * The tab named in the hash; an unknown, missing, or non-Insights hash
 * means the General tab.
 * @param {string} hash
 */
export function tabFromHash(hash, chipmunk = false) {
  const fallback = chipmunk ? CHIPMUNK_DEFAULT_TAB : DEFAULT_TAB;
  if (!isInsightsPageHash(hash)) return fallback;
  const tab = hash.slice(INSIGHTS_PAGE_HASH.length + 1);
  if (chipmunk && CHIPMUNK_TAB_IDS.includes(tab)) return tab;
  return TAB_IDS.includes(tab) ? tab : fallback;
}

/**
 * The hash for a tab. General is the bare page hash, so the plain
 * `#actual-insights` a user might type or bookmark is the canonical form.
 * @param {string} [tabId]
 */
export function insightsHash(tabId, chipmunk = false) {
  const fallback = chipmunk ? CHIPMUNK_DEFAULT_TAB : DEFAULT_TAB;
  const id = tabId === undefined ? fallback : tabId;
  const known = TAB_IDS.includes(id) || (chipmunk && CHIPMUNK_TAB_IDS.includes(id));
  if (!known || id === fallback) return INSIGHTS_PAGE_HASH;
  return `${INSIGHTS_PAGE_HASH}/${id}`;
}

/**
 * Opens the page (or switches tab) by pushing the hash onto the current
 * path. history.pushState rather than assigning `location.hash` so
 * watchRoute (which wraps pushState) fires; assigning the hash would only
 * fire `hashchange`. Pushing the hash already showing is a no-op, so a
 * repeated click doesn't stack identical history entries.
 * @param {Window} win
 * @param {string} [tabId]
 */
export function navigateToInsights(win, tabId, chipmunk = false) {
  const hash = insightsHash(tabId, chipmunk);
  const { pathname, search } = win.location;
  if (win.location.hash === hash) return;
  win.history.pushState(win.history.state, '', `${pathname}${search}${hash}`);
}
