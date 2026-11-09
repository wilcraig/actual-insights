import { WIDGET_MOUNTERS } from '../widget-mounters';

/**
 * Renders a widget into `host` the same way the dashboard does (same mount
 * callback, same parsed body) and returns a function that tears it down again.
 * Never throws: a widget that fails to render leaves the preview empty and logs.
 *
 * @param {HTMLElement} host
 * @param {string} widgetId
 * @param {unknown} body the placeholder's parsed JSON body
 * @returns {() => void}
 */
export function mountPreview(host, widgetId, body) {
  host.replaceChildren();
  const mount = WIDGET_MOUNTERS[widgetId];
  if (!mount) return () => {};

  let instance = null;
  try {
    instance = mount(host, body);
  } catch (error) {
    console.error('[Actual Insights] widget preview failed to render:', error);
  }
  return () => {
    try {
      instance?.$destroy?.();
    } catch {
      // Already torn down; nothing to do.
    }
    host.replaceChildren();
  };
}
