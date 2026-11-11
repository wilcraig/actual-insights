import { PRESETS, loadSavedScale, saveScale, applyScale, nextPreset, STORAGE_KEY } from '../src/text-scale';

function fakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
    _store: store,
  };
}

test('loadSavedScale returns the default (13px, Actual\'s own unmodified size) when nothing is saved', () => {
  expect(loadSavedScale(fakeStorage())).toBe(13);
});

test('loadSavedScale returns a previously saved value', () => {
  expect(loadSavedScale(fakeStorage({ [STORAGE_KEY]: '19' }))).toBe(19);
});

test('loadSavedScale still reads a size saved before the rename, preferring the new key', () => {
  expect(loadSavedScale(fakeStorage({ 'actualmint:textScalePx': '23' }))).toBe(23);
  expect(loadSavedScale(fakeStorage({ 'actualmint:textScalePx': '23', [STORAGE_KEY]: '16' }))).toBe(16);
});

test('loadSavedScale falls back to the default on a corrupt stored value', () => {
  expect(loadSavedScale(fakeStorage({ [STORAGE_KEY]: 'not-a-number' }))).toBe(13);
});

test('loadSavedScale falls back to the default when storage access throws (private browsing)', () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error('SecurityError');
    },
  };
  expect(loadSavedScale(throwingStorage)).toBe(13);
});

test('saveScale writes the value back out as a string', () => {
  const storage = fakeStorage();
  saveScale(storage, 16);
  expect(storage.getItem(STORAGE_KEY)).toBe('16');
});

test('saveScale does not throw when storage access throws', () => {
  const throwingStorage = {
    setItem: () => {
      throw new Error('SecurityError');
    },
  };
  expect(() => saveScale(throwingStorage, 16)).not.toThrow();
});

test('applyScale creates a style element setting html zoom relative to the 13px default', () => {
  document.head.innerHTML = '';
  applyScale(document, 19);
  const styleEl = document.getElementById('actualmint-text-scale');
  expect(styleEl).not.toBeNull();
  expect(styleEl.textContent).toContain(`zoom: ${19 / 13}`);
});

test('applyScale at the default (13px) produces zoom: 1 -- no visible change', () => {
  // A plain font-size override only grows row/cell layout for elements that
  // hardcode their own font-size (confirmed live on the budget table and
  // transaction register) -- it never touches the text itself. zoom scales
  // the whole rendering context instead, which affects those elements too.
  document.head.innerHTML = '';
  applyScale(document, 13);
  const styleEl = document.getElementById('actualmint-text-scale');
  expect(styleEl.textContent).toContain('zoom: 1');
});

test('applyScale updates the existing style element in place rather than creating a second one', () => {
  document.head.innerHTML = '';
  applyScale(document, 16);
  applyScale(document, 23);
  const styleEls = document.querySelectorAll('#actualmint-text-scale');
  expect(styleEls.length).toBe(1);
  expect(styleEls[0].textContent).toContain(`zoom: ${23 / 13}`);
});

test('nextPreset cycles normal -> large -> larger -> largest -> normal', () => {
  expect(nextPreset(13).id).toBe('large');
  expect(nextPreset(16).id).toBe('larger');
  expect(nextPreset(19).id).toBe('largest');
  expect(nextPreset(23).id).toBe('normal');
});

test('nextPreset snaps an off-preset value to the next preset after its closest match', () => {
  // 14 is closest to the 'normal' preset (13) -> next is 'large'.
  expect(nextPreset(14).id).toBe('large');
});

test('PRESETS starts at Actual\'s own default so a user who never touches the control sees no change', () => {
  expect(PRESETS[0].px).toBe(13);
});

// At a text size above Normal, Actual's modal dialogs (Rules, ...) came out
// taller than the screen because react-aria's pixel viewport variables get
// zoomed a second time.
describe('modal dialogs under zoom', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.documentElement.removeAttribute('style');
    delete document.__insightsViewportTracking;
  });

  test('above Normal, the modal viewport variables are divided by the zoom so dialogs fit the screen', () => {
    applyScale(document, 16);
    const css = document.getElementById('actualmint-text-scale').textContent;
    expect(css).toContain('[data-testid$="-modal"]');
    expect(css).toContain(`--visual-viewport-height: calc(var(--insights-viewport-height) / ${16 / 13}) !important`);
    expect(css).toContain(`--visual-viewport-width: calc(var(--insights-viewport-width) / ${16 / 13}) !important`);
  });

  test('at Normal there is no override, so nothing changes for anyone who never touches the control', () => {
    applyScale(document, 13);
    expect(document.getElementById('actualmint-text-scale').textContent).not.toContain('visual-viewport');
    expect(document.documentElement.style.getPropertyValue('--insights-viewport-height')).toBe('');
  });

  test('going back to Normal from a larger size removes the override', () => {
    applyScale(document, 19);
    applyScale(document, 13);
    expect(document.getElementById('actualmint-text-scale').textContent).not.toContain('visual-viewport');
  });

  test('the real viewport size is published on <html> and follows window resizes', () => {
    applyScale(document, 16);
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--insights-viewport-height')).toBe(`${window.innerHeight}px`);
    expect(root.getPropertyValue('--insights-viewport-width')).toBe(`${window.innerWidth}px`);

    const before = window.innerHeight;
    window.innerHeight = 420;
    window.dispatchEvent(new Event('resize'));
    expect(root.getPropertyValue('--insights-viewport-height')).toBe('420px');
    window.innerHeight = before;
  });

  test('applying a size repeatedly installs the resize tracking only once', () => {
    const add = vi.spyOn(window, 'addEventListener');
    applyScale(document, 16);
    applyScale(document, 19);
    applyScale(document, 23);
    expect(add.mock.calls.filter(([type]) => type === 'resize').length).toBe(1);
    add.mockRestore();
  });
});
