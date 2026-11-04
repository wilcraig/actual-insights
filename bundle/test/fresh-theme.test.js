import {
  FRESH_PALETTE,
  FRESH_COLOR_OVERRIDES,
  applyFreshTheme,
  actualThemeIsLight,
  watchActualTheme,
  loadSavedFreshThemeEnabled,
  saveFreshThemeEnabled,
} from '../src/fresh-theme';

function fakeStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
}

beforeEach(() => {
  document.head.innerHTML = '';
});

test('applyFreshTheme(doc, true) creates a style element overriding every palette swatch with !important', () => {
  applyFreshTheme(document, true);
  const styleEl = document.getElementById('insights-fresh-theme');
  expect(styleEl).not.toBeNull();
  for (const [name, value] of Object.entries(FRESH_PALETTE)) {
    expect(styleEl.textContent).toContain(`${name}: ${value} !important;`);
  }
});

test('applyFreshTheme(doc, true) overrides the sidebar colors directly, not just the palette', () => {
  applyFreshTheme(document, true);
  const styleEl = document.getElementById('insights-fresh-theme');
  for (const [name, value] of Object.entries(FRESH_COLOR_OVERRIDES)) {
    expect(styleEl.textContent).toContain(`${name}: ${value} !important;`);
  }
});

test('applyFreshTheme(doc, false) removes the style element', () => {
  applyFreshTheme(document, true);
  applyFreshTheme(document, false);
  expect(document.getElementById('insights-fresh-theme')).toBeNull();
});

test('applyFreshTheme(doc, true) called twice updates the existing element in place', () => {
  applyFreshTheme(document, true);
  applyFreshTheme(document, true);
  expect(document.querySelectorAll('#insights-fresh-theme').length).toBe(1);
});

test('loadSavedFreshThemeEnabled still reads a choice saved before the rename, preferring the new key', () => {
  const legacyOnly = fakeStorage();
  legacyOnly.setItem('actualmint-mint-theme-enabled', 'true');
  expect(loadSavedFreshThemeEnabled(legacyOnly)).toBe(true);

  const both = fakeStorage();
  both.setItem('actualmint-mint-theme-enabled', 'true');
  saveFreshThemeEnabled(both, false);
  expect(loadSavedFreshThemeEnabled(both)).toBe(false);
});

test('loadSavedFreshThemeEnabled defaults to false when nothing is saved', () => {
  expect(loadSavedFreshThemeEnabled(fakeStorage())).toBe(false);
});

test('saveFreshThemeEnabled persists the choice for loadSavedFreshThemeEnabled to read back', () => {
  const storage = fakeStorage();
  saveFreshThemeEnabled(storage, true);
  expect(loadSavedFreshThemeEnabled(storage)).toBe(true);
  saveFreshThemeEnabled(storage, false);
  expect(loadSavedFreshThemeEnabled(storage)).toBe(false);
});

describe('only applies while Actual is on a light theme', () => {
  function setActualBackground(value) {
    document.documentElement.style.setProperty('--color-pageBackground', value);
  }
  afterEach(() => document.documentElement.style.removeProperty('--color-pageBackground'));

  test('does not apply when Actual reports a dark page background', () => {
    setActualBackground('#0c0d14');
    applyFreshTheme(document, true);
    expect(document.getElementById('insights-fresh-theme')).toBeNull();
  });

  test('applies when Actual reports a light page background', () => {
    setActualBackground('rgb(242, 244, 247)');
    applyFreshTheme(document, true);
    expect(document.getElementById('insights-fresh-theme')).not.toBeNull();
  });

  test('removes an applied theme when Actual switches to dark, and restores it on light', async () => {
    setActualBackground('#f2f4f7');
    const stop = watchActualTheme(document, () => true);
    applyFreshTheme(document, true);
    expect(document.getElementById('insights-fresh-theme')).not.toBeNull();

    setActualBackground('#0c0d14');
    const actualStyle = document.createElement('style');
    document.head.appendChild(actualStyle);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('insights-fresh-theme')).toBeNull();

    setActualBackground('#f2f4f7');
    actualStyle.textContent = '/* theme swap */';
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('insights-fresh-theme')).not.toBeNull();
    stop();
  });

  test('actualThemeIsLight reads Actual, not our own override, and leaves our element enabled', () => {
    setActualBackground('#0c0d14');
    const el = document.createElement('style');
    el.id = 'insights-fresh-theme';
    el.textContent = ':root { --color-pageBackground: #ffffff !important; }';
    document.head.appendChild(el);
    expect(actualThemeIsLight(document)).toBe(false);
    expect(el.media).toBe('');
  });
});
