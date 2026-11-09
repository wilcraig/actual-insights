import ChipmunkShell from './ChipmunkShell.svelte';

// Mounts the shell once into a fixed, full-viewport host above everything
// Actual draws. The host stays in the page (hidden, not destroyed) while the
// person is in Actual via Open Actual, so screens keep their state and come
// back instantly.
export function mountChipmunkShell(doc, win, { openActual }) {
  const host = doc.createElement('div');
  host.setAttribute('data-chipmunk-owned', 'shell');
  host.setAttribute('data-chipmunk-shell', '1');
  // Inline so the cover is complete even before bundle.css has arrived.
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483000;overflow:hidden;color-scheme:light dark;background:Canvas;color:CanvasText';
  doc.body.appendChild(host);

  let app;
  try {
    app = new ChipmunkShell({ target: host, props: { openActual, win, visible: true } });
  } catch (err) {
    host.remove();
    throw err;
  }

  return {
    show() {
      host.style.display = 'block';
      app.$set({ visible: true });
    },
    hide() {
      host.style.display = 'none';
      app.$set({ visible: false });
    },
    destroy() {
      try {
        app.$destroy();
      } catch {
        // Already torn down.
      }
      host.remove();
    },
  };
}
