import { parseHash, hashFor, isShellHash, shortcutTarget, isPaletteKey, paletteMatch, SCREENS } from '../../src/chipmunk/shell/routes';
import { tabFromHash, insightsHash, TAB_IDS } from '../../src/insights-page/route';
import { TABS } from '../../src/insights-page/tabs';

describe('shell routes', () => {
  test('own screens parse from #/chipmunk/<screen>', () => {
    for (const id of ['reports', 'accounts', 'transactions', 'budget', 'settings']) {
      expect(parseHash(`#/chipmunk/${id}`)).toEqual({ screen: id });
      expect(hashFor(id)).toBe(`#/chipmunk/${id}`);
    }
  });
  test('anything else is Reports, the home screen', () => {
    for (const h of ['', '#', '#/chipmunk/', '#/chipmunk/nope', '#/budget', undefined, null]) {
      expect(parseHash(h)).toEqual({ screen: 'reports' });
    }
  });
  test('the Insights page keeps its own hashes and the shell shows it as the insights screen', () => {
    expect(parseHash('#actual-insights')).toEqual({ screen: 'insights', tab: 'general' });
    expect(parseHash('#actual-insights/forecast')).toEqual({ screen: 'insights', tab: 'forecast' });
    expect(parseHash('#actual-insights/bogus')).toEqual({ screen: 'insights', tab: 'general' });
    expect(parseHash('#/chipmunk/insights/mobile')).toEqual({ screen: 'insights', tab: 'mobile' });
    expect(parseHash('#/chipmunk/insights')).toEqual({ screen: 'insights', tab: 'general' });
    expect(hashFor('insights', 'summaries')).toBe('#actual-insights/summaries');
    expect(hashFor('insights', 'general')).toBe('#actual-insights');
  });
  test('shell hashes are recognised so leaving the shell can drop them', () => {
    expect(isShellHash('#/chipmunk/budget')).toBe(true);
    expect(isShellHash('#actual-insights')).toBe(false);
    expect(isShellHash('')).toBe(false);
  });
  test('Cmd/Ctrl-1..4 and Alt-1..4 pick screens, Cmd/Ctrl-comma is Settings', () => {
    expect(shortcutTarget({ metaKey: true, key: '1' })).toBe('reports');
    expect(shortcutTarget({ ctrlKey: true, key: '2' })).toBe('accounts');
    expect(shortcutTarget({ altKey: true, key: '3' })).toBe('transactions');
    expect(shortcutTarget({ metaKey: true, key: '4' })).toBe('budget');
    expect(shortcutTarget({ metaKey: true, key: ',' })).toBe('settings');
    expect(shortcutTarget({ key: '1' })).toBeNull();
    expect(shortcutTarget({ metaKey: true, key: '5' })).toBeNull();
    expect(shortcutTarget({ metaKey: true, shiftKey: true, key: '1' })).toBeNull();
    expect(shortcutTarget({ metaKey: true, altKey: true, key: '1' })).toBeNull();
    expect(SCREENS.map((s) => s.shortcut)).toEqual(['1', '2', '3', '4']);
  });
});

describe('command palette helpers', () => {
  test('Cmd/Ctrl-K only', () => {
    expect(isPaletteKey({ metaKey: true, key: 'k' })).toBe(true);
    expect(isPaletteKey({ ctrlKey: true, key: 'K' })).toBe(true);
    expect(isPaletteKey({ key: 'k' })).toBe(false);
    expect(isPaletteKey({ ctrlKey: true, shiftKey: true, key: 'k' })).toBe(false);
  });
  test('every typed word must match', () => {
    expect(paletteMatch('Transactions in Everyday Checking', 'every check')).toBe(true);
    expect(paletteMatch('Report: Main', 'budget')).toBe(false);
    expect(paletteMatch('anything', '  ')).toBe(true);
  });
});

describe('the old Insights page is exactly as before', () => {
  test('its routing ignores Chipmunk entirely', () => {
    expect(TAB_IDS).toEqual(['general', 'summaries', 'channels', 'forecast', 'mobile']);
    expect(tabFromHash('#actual-insights/reports')).toBe('general');
    expect(insightsHash('budget')).toBe('#actual-insights');
    expect(TABS.map((t) => t.id)).toEqual(TAB_IDS);
  });
});
