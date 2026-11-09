// A hover tooltip (`use:tip={'Groceries: $95.00 (77%)'}`): a small label that
// follows the pointer over a chart slice, bar or row. One element is shared by
// every user; it never takes the pointer and is gone when the pointer leaves.
let el = null;

function ensure(doc) {
  if (el && el.ownerDocument === doc && el.isConnected) return el;
  el = doc.createElement('div');
  el.setAttribute('role', 'tooltip');
  el.setAttribute('data-chipmunk-owned', 'tip');
  el.style.cssText =
    'position:fixed;z-index:2147483400;pointer-events:none;padding:5px 9px;border-radius:7px;font:12px/1.3 system-ui,sans-serif;' +
    'background:#111827;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.35);max-width:260px;display:none;white-space:pre-line';
  doc.body.appendChild(el);
  return el;
}

export function tip(node, text) {
  let current = text;
  const place = (e) => {
    if (!el) return;
    const pad = 12;
    const w = el.offsetWidth || 0;
    const x = Math.min(e.clientX + pad, (node.ownerDocument.defaultView?.innerWidth ?? 9999) - w - 8);
    el.style.left = `${Math.max(4, x)}px`;
    el.style.top = `${e.clientY + pad + 4}px`;
  };
  const show = (e) => {
    if (!current) return;
    const t = ensure(node.ownerDocument);
    t.textContent = current;
    t.style.display = 'block';
    place(e);
  };
  const hide = () => {
    if (el) el.style.display = 'none';
  };
  node.setAttribute('data-tip', current ?? '');
  node.addEventListener('mouseenter', show);
  node.addEventListener('mousemove', place);
  node.addEventListener('mouseleave', hide);
  return {
    update(next) {
      current = next;
      node.setAttribute('data-tip', current ?? '');
      if (el && el.style.display === 'block') el.textContent = current;
    },
    destroy() {
      node.removeEventListener('mouseenter', show);
      node.removeEventListener('mousemove', place);
      node.removeEventListener('mouseleave', hide);
      hide();
    },
  };
}
