import BuilderModal from './BuilderModal.svelte';
import { isReportsPath, watchRoute } from './route-watcher';

// One builder at a time, mounted straight on <body> (not inside Actual's
// toolbar) so no ancestor's transform or overflow can clip or offset the
// full-screen dialog. Both the toolbar button (add a widget) and the edit
// button on a live widget (edit it) open it through here.

let current = null;

/**
 * @param {{ initial?: { widgetId: string, body: unknown, raw: string, mountHost: HTMLElement } }} [options]
 *   `initial` opens the builder on an existing widget, ready to save changes to it.
 */
export function openBuilder(options = {}) {
  if (current) return;
  const previouslyFocused = document.activeElement;
  let unwatch = () => {};

  const close = () => {
    if (!current) return;
    unwatch();
    current.instance.$destroy();
    current = null;
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
  };

  const instance = new BuilderModal({
    target: document.body,
    props: { initial: options.initial ?? null, onclose: close },
  });
  current = { instance, close };

  // Leaving Reports with the dialog open would strand it over another page.
  unwatch = watchRoute(window, (pathname) => {
    if (!isReportsPath(pathname)) close();
  });
}

export function closeBuilder() {
  current?.close();
}
