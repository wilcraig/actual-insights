import { parsePlaceholderText } from './edit-widget';

// Puts a small "edit" button on every live Actual Insights widget. mount.js
// tags each widget's host element and hides the placeholder text next to it;
// this reads that text back, so the button knows which widget and config to
// open the builder on.

const HOST_CLASS = 'actualmint-widget-host';
const BUTTON_CLASS = 'insights-edit-widget';
const STYLE_ID = 'insights-edit-widget-style';

const CSS = `
.${HOST_CLASS} { position: relative; }
.${BUTTON_CLASS} {
  position: absolute; top: 4px; right: 4px; z-index: 5;
  width: 1.75rem; height: 1.75rem; padding: 0; line-height: 1;
  border-radius: 0.375rem; cursor: pointer; font: inherit; font-size: 1rem;
  border: 1px solid var(--color-buttonNormalBorder, #ccc);
  background: var(--color-buttonNormalBackground, #fff);
  color: var(--color-buttonNormalText, #222);
  opacity: 0; transition: opacity 0.12s;
}
.${HOST_CLASS}:hover .${BUTTON_CLASS},
.${HOST_CLASS}:focus-within .${BUTTON_CLASS},
.${BUTTON_CLASS}:focus-visible { opacity: 1; }
@media (hover: none) { .${BUTTON_CLASS} { opacity: 0.85; } }
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

// The hidden wrapper mount.js leaves around a widget's original placeholder
// text, in the same parent as the host we mounted into.
function placeholderTextFor(mountHost) {
  const wrapper = mountHost.parentElement?.querySelector('.actualmint-hidden-placeholder');
  return wrapper ? wrapper.textContent : null;
}

/**
 * @param {Document} doc
 * @param {Window} win
 * @param {(info: { widgetId: string, body: unknown, raw: string, mountHost: HTMLElement }) => void} onEdit
 * @returns {() => void} stop watching
 */
export function watchEditableWidgets(doc, win, onEdit) {
  ensureStyle(doc);

  const wire = () => {
    for (const mountHost of doc.querySelectorAll(`.${HOST_CLASS}`)) {
      if (mountHost.querySelector(`:scope > .${BUTTON_CLASS}`)) continue;
      const parsed = parsePlaceholderText(placeholderTextFor(mountHost));
      if (!parsed) continue;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = BUTTON_CLASS;
      button.textContent = '✎';
      button.title = 'Edit in widget builder';
      button.setAttribute('aria-label', 'Edit in widget builder');
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        onEdit({ ...parsed, mountHost });
      });
      mountHost.appendChild(button);
    }
  };

  let scheduled = false;
  const observer = new win.MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      wire();
    });
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  wire();
  return () => observer.disconnect();
}
