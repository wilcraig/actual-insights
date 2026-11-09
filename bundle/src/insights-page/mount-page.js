import { tick } from 'svelte';
import InsightsPage from './InsightsPage.svelte';
import { isInsightsPageHash, tabFromHash } from './route';
import { watchRoute } from '../widget-builder/route-watcher';

// Shows the Insights page over Actual's main content region whenever the
// URL hash is `#actual-insights[/tab]` (see route.js for why it's a hash).
//
// Actual has no plugin API for adding a page, and its router redirects
// any path it doesn't know, so instead of a route of its own the page is
// an overlay: Actual keeps rendering whatever route the user was on, the
// overlay covers just the content region (sidebar and title bar stay
// usable), and Actual's content underneath is set `visibility: hidden` so
// it can't be tabbed into or read out by a screen reader while covered.
//
// Same lifecycle as mount-settings.js: the component is created exactly
// once into one persistent container and never destroyed -- only shown,
// hidden, and handed a new tab -- so anything typed in a tab survives
// leaving the page and coming back.

const TITLEBAR_MAX_HEIGHT = 100;

// The content region, found from the one stable hook in Actual's main
// column (docs/insights-page-hosting-notes.md): the help button lives in
// the title bar, the title bar is the tallest ancestor of it that's still
// bar-sized, and the page content is the title bar's tallest following
// sibling (the others are a notifications layer and an empty strip, both
// 0px tall). Emotion's hashed class names change between Actual releases,
// so none are used.
function locate(doc) {
  const help = doc.querySelector('[data-testid="help-menu-button"]');
  if (!help) return null;

  let bar = help;
  while (
    bar.parentElement &&
    bar.parentElement !== doc.body &&
    bar.parentElement.getBoundingClientRect().height < TITLEBAR_MAX_HEIGHT
  ) {
    bar = bar.parentElement;
  }

  let region = null;
  let regionHeight = -1;
  for (let el = bar.nextElementSibling; el; el = el.nextElementSibling) {
    const { height } = el.getBoundingClientRect();
    if (height >= regionHeight) {
      region = el;
      regionHeight = height;
    }
  }
  return region ? { bar, region } : null;
}

export function findContentRegion(doc) {
  return locate(doc)?.region ?? null;
}

export function mountInsightsPage(doc, win) {
  const container = doc.createElement('div');
  container.setAttribute('data-insights-page', '1');
  container.className = 'actualmint-insights-page-host';
  const style = container.style;
  style.display = 'none';
  style.position = 'fixed';
  // Above buttons other add-ons float over Actual's pages (ABT's own
  // "Insights" template-drawer button on Budget sits at 50 and would
  // otherwise show through), below Actual's own chrome and overlays
  // (sidebar, title bar, menus, modals, toasts: 100 and up), all
  // measured live.
  style.zIndex = '60';
  style.overflowY = 'auto';
  style.boxSizing = 'border-box';
  doc.body.appendChild(container);

  const page = new InsightsPage({
    target: container,
    props: { tabId: tabFromHash(win.location.hash) },
  });

  let open = false;
  let covered = null; // the content region we hid, and its own visibility
  let coveredVisibility = '';
  let observer = null;
  let rootObserver = null;
  let resizeObserver = null;

  function uncover() {
    if (covered) {
      covered.style.visibility = coveredVisibility;
      covered = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
  }

  // Matches the overlay to the content region's box, and Actual's own
  // colors and font, read from the live region every time so it follows
  // the theme (Light, Dark, Midnight, Fresh, an ABT theme) and the
  // sidebar's width (ABT's accounts panel can be collapsed).
  function place() {
    const found = locate(doc);
    if (!found) {
      style.display = 'none';
      return;
    }
    const { bar, region } = found;
    if (region !== covered) {
      uncover();
      covered = region;
      coveredVisibility = region.style.visibility;
      if (win.ResizeObserver) {
        resizeObserver = new win.ResizeObserver(() => place());
        resizeObserver.observe(region);
      }
    }
    // The text-size setting zooms <html> (text-scale.js). Under CSS zoom
    // the region's rect comes back in on-screen pixels while the
    // overlay's own px get zoomed again, so un-zoom them first (confirmed
    // live: at 1.23x the overlay otherwise ran off the right edge).
    //
    // Only the region's visible part, below the title bar: on long pages
    // (Settings) Actual scrolls the whole main column, so the region's
    // own box can start thousands of px above the viewport (confirmed
    // live: covering that box left the page's content off-screen).
    const zoom = parseFloat(win.getComputedStyle(doc.documentElement).zoom) || 1;
    const rect = region.getBoundingClientRect();
    const top = Math.max(rect.top, bar.getBoundingClientRect().bottom);
    const bottom = Math.min(
      rect.bottom,
      bar.parentElement.getBoundingClientRect().bottom,
      win.innerHeight,
    );
    style.top = `${top / zoom}px`;
    style.left = `${rect.left / zoom}px`;
    style.width = `${rect.width / zoom}px`;
    style.height = `${Math.max(0, bottom - top) / zoom}px`;
    const regionStyle = win.getComputedStyle(region);
    style.backgroundColor = opaqueBackground(region) || 'Canvas';
    style.color = regionStyle.color;
    style.fontFamily = regionStyle.fontFamily;
    style.display = 'block';
    region.style.visibility = 'hidden';
  }

  // The nearest non-transparent background at or above the region, since
  // Actual paints its page background on an ancestor, not the region.
  function opaqueBackground(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const bg = win.getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return null;
  }

  // While the page is open, keep re-placing on DOM changes: on a direct
  // load the bundle runs before React has rendered anything, and Actual
  // can swap its content region out from under us. Watches the whole
  // document, <head> included, so a theme change (the Fresh theme and the
  // text size inject <style> tags there; ABT and Actual switch an
  // attribute on <html>) recolors and re-sizes the overlay at once.
  // childList, plus attributes on <html> alone, so our own style writes
  // on the overlay and the region never re-trigger it.
  function startObserving() {
    if (observer) return;
    const replace = () => {
      if (open) place();
    };
    // Two observers: observe() on the same node twice would replace the
    // first options rather than add to them.
    observer = new win.MutationObserver(replace);
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    rootObserver = new win.MutationObserver(replace);
    rootObserver.observe(doc.documentElement, { attributes: true });
  }

  function stopObserving() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (rootObserver) {
      rootObserver.disconnect();
      rootObserver = null;
    }
  }

  function onWindowResize() {
    if (open) place();
  }

  // Lets tabs refresh their data each time the page is opened, not only on
  // first mount (e.g. GoalsList picking up a category whose carryover was
  // just turned on elsewhere in Actual). Waits for the tabId set above to
  // flush: dispatched at once, a tab being swapped out by the new hash would
  // still be listening and reload just as it's torn down. Errors stay here
  // so they can't break the route watcher.
  async function announceShown() {
    try {
      await tick();
      if (open) doc.dispatchEvent(new win.CustomEvent('insights:page-shown'));
    } catch (err) {
      console.error('insights page: page-shown failed:', err);
    }
  }

  function update() {
    const shouldOpen = isInsightsPageHash(win.location.hash);
    if (shouldOpen) {
      page.$set({ tabId: tabFromHash(win.location.hash) });
      const opening = !open;
      open = true;
      startObserving();
      place();
      if (opening) announceShown();
    } else if (open) {
      open = false;
      stopObserving();
      uncover();
      style.display = 'none';
    }
  }

  win.addEventListener('hashchange', update);
  win.addEventListener('resize', onWindowResize);
  const unwatch = watchRoute(win, update);

  return function unmount() {
    unwatch();
    win.removeEventListener('hashchange', update);
    win.removeEventListener('resize', onWindowResize);
    stopObserving();
    uncover();
  };
}
