// Showing Actual's own Reports page inside the shell. Actual's React app is
// left alone: its root is given the slot's box (margins and size, no
// transform, so Actual's own modals and the widget builder keep layering above
// everything), and its sidebar(s) and title bar are hidden, so only the page
// content (the Reports header with Add new widget, Widget builder, Edit
// dashboard, and the dashboard grid) shows. Everything is undone on conceal.

const HIDE_ATTR = 'data-cm-hidden';
const TITLEBAR_MAX_HEIGHT = 100;

/**
 * The title bar and the sidebar element(s), found from the one stable hook in
 * Actual's main column ([data-testid=help-menu-button], see
 * docs/insights-page-hosting-notes.md). null when Actual is not showing its
 * app frame (file picker, login).
 */
export function findChrome(doc) {
  const help = doc.querySelector('[data-testid="help-menu-button"]');
  if (!help) return null;
  let bar = help;
  while (bar.parentElement && bar.parentElement !== doc.body && bar.parentElement.getBoundingClientRect().height < TITLEBAR_MAX_HEIGHT) {
    bar = bar.parentElement;
  }
  // The main area: the topmost ancestor that starts right of the sidebar while
  // its parent starts at the left edge. The sidebar is that parent's other child.
  let area = bar.parentElement;
  const root = doc.getElementById('root');
  while (area && area.parentElement && area.parentElement !== doc.body && area.parentElement !== root) {
    const p = area.parentElement;
    if (p.getBoundingClientRect().left <= 0.5 && area.getBoundingClientRect().left > 0.5) break;
    area = p;
  }
  const sidebars = area && area.parentElement ? [...area.parentElement.children].filter((c) => c !== area && !['SCRIPT', 'STYLE', 'LINK'].includes(c.tagName)) : [];
  return { bar, area, sidebars };
}

/**
 * Lays Actual out in `slot` until the returned function is called.
 * @returns {() => void} undo
 */
export function applyActualLayout(doc, win, slot) {
  const root = doc.getElementById('root');
  const rootStyle = root ? root.getAttribute('style') : null;
  const undoers = [];
  let found = null;
  let raf = 0;

  const hide = (el) => {
    if (!el || el.hasAttribute(HIDE_ATTR)) return;
    const prev = el.style.getPropertyValue('display');
    const prio = el.style.getPropertyPriority('display');
    el.setAttribute(HIDE_ATTR, '1');
    el.style.setProperty('display', 'none', 'important');
    undoers.push(() => {
      el.removeAttribute(HIDE_ATTR);
      if (prev) el.style.setProperty('display', prev, prio);
      else el.style.removeProperty('display');
    });
  };

  function place() {
    raf = 0;
    const r = slot.getBoundingClientRect();
    // The text-size setting zooms <html>: rects come back in screen pixels, CSS px are zoomed again.
    const zoom = parseFloat(win.getComputedStyle(doc.documentElement).zoom) || 1;
    if (root) {
      // Offset with position:relative (no z-index: no stacking context, so Actual's modals still
      // layer above everything) and a left margin; a top margin would collapse into <body>'s.
      root.style.setProperty('position', 'relative');
      root.style.setProperty('top', `${r.top / zoom}px`);
      root.style.setProperty('margin', `0 0 0 ${r.left / zoom}px`);
      root.style.setProperty('width', `${r.width / zoom}px`);
      root.style.setProperty('height', `${r.height / zoom}px`);
      root.style.setProperty('overflow', 'hidden');
      root.style.setProperty('box-sizing', 'border-box');
    }
    // Find once (hiding changes the geometry the search relies on); look again
    // only when React has replaced those elements.
    if (!found || !found.bar.isConnected) {
      const next = findChrome(doc);
      if (next) {
        found = next;
        hide(next.bar);
        next.sidebars.forEach(hide);
      }
    }
    // ABT's own "live sidebar".
    doc.querySelectorAll('.sidebar').forEach(hide);
  }

  const schedule = () => {
    if (!raf) raf = win.requestAnimationFrame ? win.requestAnimationFrame(place) : setTimeout(place, 16);
  };

  place();
  const ro = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  ro?.observe(slot);
  const mo = root && win.MutationObserver ? new win.MutationObserver(schedule) : null;
  mo?.observe(root, { childList: true, subtree: true });
  win.addEventListener('resize', schedule);

  return function undo() {
    ro?.disconnect();
    mo?.disconnect();
    win.removeEventListener('resize', schedule);
    if (raf) (win.cancelAnimationFrame || clearTimeout)(raf);
    while (undoers.length) undoers.pop()();
    if (root) {
      if (rootStyle === null) root.removeAttribute('style');
      else root.setAttribute('style', rootStyle);
    }
  };
}
