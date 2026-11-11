// Global text-size control — lets each browser/device independently bump up
// the size of the *entire* page (Actual's own native budget/report UI, not
// just Actual Insights' own widgets), since a phone-sized default is too small
// to read.
//
// Overriding `html`/`body` font-size does NOT work here, even though
// Actual's base stylesheet looks rem/em-driven: many of Actual's own UI
// elements (e.g. the payee/category text inside budget and transaction
// table rows) carry their own literal, hardcoded `font-size: 13px` via
// per-element CSS-in-JS rules that completely bypass inheritance -- a
// font-size override on html/body only grew the surrounding row/cell
// layout (more empty space around icons), confirmed live, while the text
// itself stayed pinned at 13px. CSS `zoom` instead scales the whole
// rendering context the same way native browser zoom does, which affects
// every element regardless of how its own font-size was declared --
// confirmed live to actually enlarge that same hardcoded-13px text.
//
// Persisted per-browser in localStorage (not synced through Actual's own
// data), so a phone and a desktop can each keep their own preferred size.

export const STORAGE_KEY = 'insights:textScalePx';
// Saved under the project's original name; still read so an existing
// choice survives the rename.
export const LEGACY_STORAGE_KEY = 'actualmint:textScalePx';

// Actual's own unmodified root size is 13px -- "Normal" matches that
// exactly, so a user who never touches this control sees no change at all.
export const PRESETS = [
  { id: 'normal', label: 'Normal', px: 13 },
  { id: 'large', label: 'Large', px: 16 },
  { id: 'larger', label: 'Larger', px: 19 },
  { id: 'largest', label: 'Largest', px: 23 },
];

const DEFAULT_PX = PRESETS[0].px;
const STYLE_ELEMENT_ID = 'actualmint-text-scale';

// Reads the saved size from `storage` (a Storage-like object, e.g.
// window.localStorage). Falls back to the default on anything unusable --
// missing key, corrupt value, or a storage access that throws (private
// browsing / blocked site data) -- rather than ever letting a bad stored
// value break the page.
export function loadSavedScale(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY) ?? storage.getItem(LEGACY_STORAGE_KEY);
    const px = Number(raw);
    if (Number.isFinite(px) && px > 0) return px;
  } catch {
    // storage inaccessible -- fall through to default
  }
  return DEFAULT_PX;
}

export function saveScale(storage, px) {
  try {
    storage.setItem(STORAGE_KEY, String(px));
  } catch {
    // storage inaccessible (private browsing, blocked site data) -- the
    // size still applies for this page load via applyScale(), it just
    // won't persist across reloads. Not worth surfacing as an error.
  }
}

// Applies `px` as a zoom level on `html` (relative to Actual's own default
// of 13px, so "Normal" is exactly zoom: 1 -- a user who never touches this
// control sees no change at all) via a single dedicated <style> element
// (created once, updated in place on later calls) rather than writing to
// html.style directly, so this plays nicely alongside any other inline
// styles already on <html> and is trivial to find/remove.
export function applyScale(doc, px) {
  let styleEl = doc.getElementById(STYLE_ELEMENT_ID);
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    doc.head.appendChild(styleEl);
  }
  const zoom = px / DEFAULT_PX;
  styleEl.textContent = `html { zoom: ${zoom}; }${zoom === 1 ? '' : modalViewportRules(zoom)}`;
  if (zoom !== 1) trackViewport(doc);
}

// Actual's modal dialogs (Rules, account and schedule editors, ...) size
// themselves from `--visual-viewport-height` / `--visual-viewport-width`, which
// react-aria sets on each dialog's overlay as the visible viewport in pixels.
// Under `html { zoom }` every pixel is scaled again, so at a text size above
// Normal the dialog came out `zoom` times taller than the screen and its
// buttons (Save) landed below the bottom edge. Dividing the two variables by
// the zoom makes them come out at the real viewport size. They are set inline
// by react-aria, so the override needs !important; the overlay always carries a
// `data-testid` ending in "-modal".
function modalViewportRules(zoom) {
  return ` [data-testid$="-modal"] { --visual-viewport-height: calc(var(--insights-viewport-height) / ${zoom}) !important; --visual-viewport-width: calc(var(--insights-viewport-width) / ${zoom}) !important; }`;
}

// Keeps `--insights-viewport-height/-width` on <html> equal to the visible
// viewport in (unzoomed) pixels, the same measure react-aria uses, updating
// when the window is resized or the on-screen keyboard changes the visual
// viewport. Installed once per document.
const TRACKING_FLAG = '__insightsViewportTracking';
function trackViewport(doc) {
  const win = doc.defaultView;
  if (!win || doc[TRACKING_FLAG]) return;
  doc[TRACKING_FLAG] = true;
  const update = () => {
    const viewport = win.visualViewport;
    doc.documentElement.style.setProperty('--insights-viewport-height', `${viewport?.height ?? win.innerHeight}px`);
    doc.documentElement.style.setProperty('--insights-viewport-width', `${viewport?.width ?? win.innerWidth}px`);
  };
  update();
  win.addEventListener('resize', update);
  win.visualViewport?.addEventListener('resize', update);
}

// The next preset after whichever one's px is closest to `currentPx`,
// wrapping back to the first preset after the last. Used by the control's
// "cycle" click -- a user who has manually tweaked localStorage to an
// off-preset value still lands on a sane next step rather than getting
// stuck.
export function nextPreset(currentPx) {
  let closestIndex = 0;
  let closestDiff = Infinity;
  for (let i = 0; i < PRESETS.length; i++) {
    const diff = Math.abs(PRESETS[i].px - currentPx);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIndex = i;
    }
  }
  return PRESETS[(closestIndex + 1) % PRESETS.length];
}
