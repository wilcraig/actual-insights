import { TAB_IDS, isInsightsPageHash, tabFromHash, insightsHash } from '../../insights-page/route';

// Routes inside the Chipmunk shell. They live in the URL hash so any Actual
// path serves them and the bundle never fights Actual's own (path-based)
// router:
//   #/chipmunk/<reports|accounts|transactions|budget|settings>
//   #actual-insights[/<tab>]   the existing Insights page, shown in the shell
//   #/chipmunk/insights[/<tab>] alias of the line above
// Anything else means Reports, the app's home.

export const CHIPMUNK_PREFIX = '#/chipmunk/';
export const SCREENS = [
  { id: 'reports', label: 'Reports', shortcut: '1' },
  { id: 'accounts', label: 'Accounts', shortcut: '2' },
  { id: 'transactions', label: 'Transactions', shortcut: '3' },
  { id: 'budget', label: 'Budget', shortcut: '4' },
];
const OWN_SCREENS = [...SCREENS.map((s) => s.id), 'settings'];
export const DEFAULT_SCREEN = 'reports';

export const INSIGHTS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'summaries', label: 'Summaries' },
  { id: 'channels', label: 'Channels' },
  { id: 'forecast', label: 'Forecast' },
  { id: 'mobile', label: 'Mobile app' },
];

/** @returns {{ screen: string, tab?: string }} */
export function parseHash(hash) {
  const h = typeof hash === 'string' ? hash : '';
  if (isInsightsPageHash(h)) return { screen: 'insights', tab: tabFromHash(h) };
  if (h.startsWith(CHIPMUNK_PREFIX)) {
    const rest = h.slice(CHIPMUNK_PREFIX.length);
    if (OWN_SCREENS.includes(rest)) return { screen: rest };
    if (rest === 'insights' || rest.startsWith('insights/')) {
      const tab = rest.slice('insights/'.length);
      return { screen: 'insights', tab: TAB_IDS.includes(tab) ? tab : 'general' };
    }
  }
  return { screen: DEFAULT_SCREEN };
}

export function hashFor(screen, tab) {
  if (screen === 'insights') return insightsHash(tab);
  return OWN_SCREENS.includes(screen) ? `${CHIPMUNK_PREFIX}${screen}` : `${CHIPMUNK_PREFIX}${DEFAULT_SCREEN}`;
}

/** True for a hash the shell itself owns (so leaving the shell can drop it). */
export const isShellHash = (hash) => typeof hash === 'string' && hash.startsWith('#/chipmunk');

/** Cmd/Ctrl-1..4 (and Alt-1..4, which browsers do not reserve) pick a screen; Cmd/Ctrl-, is Settings. */
export function shortcutTarget(event) {
  const mod = event.metaKey || event.ctrlKey;
  if (event.shiftKey) return null;
  if (mod && !event.altKey && event.key === ',') return 'settings';
  if (!(mod || event.altKey) || (mod && event.altKey)) return null;
  return SCREENS.find((s) => s.shortcut === event.key)?.id ?? null;
}

/** Cmd/Ctrl-K opens the command palette. */
export const isPaletteKey = (event) => !!(event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'k';

/** Palette matching: every word typed must appear in the item's label (case-insensitive). */
export function paletteMatch(label, query) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const l = String(label).toLowerCase();
  return words.every((w) => l.includes(w));
}
