// Adds a Text widget carrying a placeholder to the dashboard being viewed, by
// calling the same Actual backend handler its own "Add new widget -> Text
// widget" menu item does (`dashboard-add-widget`). Actual exposes that call to
// the page as `window.$send`. There is no plugin API for this, so every step
// fails soft: the builder keeps a Copy button as the fallback.

const DASHBOARD_PATH = /^\/reports\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** The dashboard id in a `/reports/<id>` path, or null (not on a dashboard). */
export function dashboardIdFromPath(pathname) {
  const match = DASHBOARD_PATH.exec(pathname ?? '');
  return match ? match[1] : null;
}

/**
 * @param {{send: Function, dashboardId: string, text: string, size: {w: number, h: number}}} args
 * @throws when Actual refuses the widget
 */
export async function addTextWidget({ send, dashboardId, text, size }) {
  const result = await send('dashboard-add-widget', {
    type: 'markdown-card',
    width: size.w,
    height: size.h,
    meta: { content: text },
    dashboard_page_id: dashboardId,
  });
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    throw new Error('Actual could not add the widget.');
  }
}

/** How many text nodes on the page carry `text` (a placeholder already in use counts). */
export function countText(doc, text) {
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  let count = 0;
  let node;
  // eslint-disable-next-line no-cond-assign
  while ((node = walker.nextNode())) {
    if (node.nodeValue && node.nodeValue.includes(text)) count += 1;
  }
  return count;
}

/**
 * Nudges Actual's dashboard to re-read its widgets after a direct add (it only
 * refreshes on its own after adds made through its own UI): announces the tab
 * as visible again, which makes its data layer refetch, then waits for one more
 * copy of the placeholder than `before` to show up. Resolves true if it did.
 */
export async function refreshUntilVisible({ doc, win, text, before, waitMs = 2500, stepMs = 150 }) {
  win.dispatchEvent(new win.Event('visibilitychange'));
  doc.dispatchEvent(new win.Event('visibilitychange'));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (countText(doc, text) > before) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return countText(doc, text) > before;
}
