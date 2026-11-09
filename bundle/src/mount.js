// Finds a placeholder left inside an Actual Reports "Text widget" and mounts
// a real component in its place. The placeholder convention (and the
// TreeWalker technique below) follows Actual Budget Tweaks' own
// `placeholderOf()` helper in `income-breakdown/index.ts`.

const CLOSING = '}}';

// Placeholders are written as `{{INSIGHTS:<widget-id>:<json>}}`. The
// project's original name lives on in `{{ACTUALMINT:...}}`, which is still
// recognized so dashboards created before the rename keep working.
export const PLACEHOLDER_PREFIX = '{{INSIGHTS:';
export const LEGACY_PLACEHOLDER_PREFIX = '{{ACTUALMINT:';

// Every prefix form a widget's placeholder may use, given either form.
function prefixVariants(prefix) {
  for (const [current, other] of [
    [PLACEHOLDER_PREFIX, LEGACY_PLACEHOLDER_PREFIX],
    [LEGACY_PLACEHOLDER_PREFIX, PLACEHOLDER_PREFIX],
  ]) {
    if (prefix.startsWith(current)) return [prefix, other + prefix.slice(current.length)];
  }
  return [prefix];
}

/**
 * Walk the live DOM for a text node whose content starts with `prefix`,
 * parse the JSON between the prefix and the matching closing `}}`, and
 * return the containing element, the text node itself, plus the parsed
 * config.
 *
 * Since mounting no longer removes or clears the placeholder text (it's
 * wrapped and hidden in place instead — see mountWidget below), an
 * already-handled placeholder's text node would otherwise keep matching on
 * every later call. `skip` lets a caller pass in the text nodes it has
 * already handled so the walk continues past them to find the next one.
 *
 * @param {string | string[]} prefix e.g. "{{INSIGHTS:pacing-bars:", or several forms to accept
 * @param {WeakSet<Text>} [skip]
 * @returns {{ node: HTMLElement, textNode: Text, config: unknown } | null}
 */
export function findPlaceholder(prefix, skip) {
  const prefixes = Array.isArray(prefix) ? prefix : [prefix];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

  let textNode;
  // eslint-disable-next-line no-cond-assign
  while ((textNode = walker.nextNode())) {
    if (skip && skip.has(textNode)) continue;

    const text = textNode.nodeValue;
    if (!text) continue;

    let start = -1;
    let matched = null;
    for (const p of prefixes) {
      const at = text.indexOf(p);
      if (at !== -1 && (start === -1 || at < start)) {
        start = at;
        matched = p;
      }
    }
    if (start === -1) continue;

    const jsonStart = start + matched.length;

    // The JSON body can itself be an object ending in `}` (e.g.
    // `{{INSIGHTS:month-end-net:{}}}`), so the first `}}` found isn't
    // necessarily the real closing delimiter. Try each successive `}}`
    // occurrence in turn until one parses as valid JSON.
    let config;
    let parsed = false;
    let searchFrom = jsonStart;
    for (;;) {
      const end = text.indexOf(CLOSING, searchFrom);
      if (end === -1) break;

      const rawConfig = text.slice(jsonStart, end);
      try {
        config = JSON.parse(rawConfig);
        parsed = true;
        break;
      } catch {
        searchFrom = end + 1;
      }
    }
    if (!parsed) continue;

    const host = textNode.parentElement;
    if (!host) continue;

    return { node: host, textNode, config };
  }

  return null;
}

// Class applied to the wrapper we create around the original placeholder
// text node, so it's hidden instead of removed (see mountWidget below).
const HIDDEN_PLACEHOLDER_CLASS = 'actualmint-hidden-placeholder';

const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true };

/**
 * Watches the DOM for a placeholder matching `prefix` (including after
 * Actual's own client-side navigation) and calls `render(mountHost, config)`
 * exactly once per distinct placeholder text node, hiding (never deleting)
 * the placeholder text first. Errors thrown by `render` are caught, logged,
 * and never propagate.
 *
 * Actual's own React tree owns the placeholder text node (it's the content
 * of a Text widget rendered by React/a markdown renderer). Deleting or
 * reparenting-and-clearing it risks a `NotFoundError` if React's reconciler
 * later tries to update or remove that same node — so instead of clearing
 * the host's content, we wrap the original text node in a new, hidden
 * `<span>` (leaving the text node itself untouched and still present in the
 * DOM) and mount the widget into a brand-new sibling `<div>` we create for
 * that purpose.
 *
 * @param {string} prefix either placeholder form; the other form is accepted too
 * @param {(mountHost: HTMLElement, config: unknown) => void} render
 */
export function mountWidget(prefix, render) {
  const prefixes = prefixVariants(prefix);
  // Keyed by the placeholder text node itself (not the host element it
  // started out in) because wrapping moves the text node under a new
  // parent — tracking by its original parent would make every subsequent
  // scan see it as "not yet mounted" and re-mount it forever. Each entry
  // remembers the text it rendered, because React updates the (moved) text
  // node in place when a Text widget is edited: a node whose text has since
  // changed is rendered again, replacing the old widget.
  const mounted = new WeakMap();
  const handled = {
    has: (node) => {
      const entry = mounted.get(node);
      return Boolean(entry) && entry.value === node.nodeValue;
    },
  };
  let scheduled = false;

  const scan = () => {
    scheduled = false;

    // A mutation callback can still fire after the page (or, in tests, the
    // DOM environment) has gone away; bail out rather than throw.
    if (typeof document === 'undefined') return;

    // `findPlaceholder` only ever returns the first non-`mounted` match it
    // walks into, so a single DOM snapshot can hold several not-yet-mounted
    // placeholders (e.g. two "pacing-bars" widgets on the same report).
    // Loop until a scan turns up nothing new; `mounted` (passed as `skip`)
    // makes each already-handled placeholder's text node invisible to the
    // next call so the walk continues on to find the next one.
    for (;;) {
      const found = findPlaceholder(prefixes, handled);
      if (!found) break;

      const { textNode, config } = found;
      const previous = mounted.get(textNode);

      // Mutating the DOM ourselves (hiding the placeholder, then letting
      // `render` populate a sibling) would otherwise re-trigger this same
      // observer. Disconnect for the duration of our own write, then resume
      // watching for the next placeholder to appear elsewhere in the
      // document.
      observer.disconnect();

      // Hide the original placeholder text non-destructively: wrap it in a
      // span (a raw Text node can't take a style of its own) and hide that
      // span, rather than deleting or clearing a node React created.
      let hiddenWrapper = textNode.parentNode;
      if (!previous) {
        hiddenWrapper = document.createElement('span');
        hiddenWrapper.className = HIDDEN_PLACEHOLDER_CLASS;
        hiddenWrapper.style.display = 'none';
        textNode.parentNode.insertBefore(hiddenWrapper, textNode);
        hiddenWrapper.appendChild(textNode);
      } else {
        // Edited in place: take the old widget down before drawing the new one.
        try {
          previous.instance?.$destroy?.();
        } catch {
          // Already torn down.
        }
        previous.mountHost.remove();
      }
      const host = hiddenWrapper.parentElement;

      // Mount into a new element of our own rather than the (React-owned)
      // host, so we never need to touch host's existing children again.
      const mountHost = document.createElement('div');
      // Lets other modules (the widget builder's edit button) find this widget.
      mountHost.className = 'actualmint-widget-host';
      host.appendChild(mountHost);

      let instance = null;
      try {
        instance = render(mountHost, config) ?? null;
      } catch (error) {
        console.error('[Actual Insights] mountWidget render callback threw:', error);
      } finally {
        mounted.set(textNode, { value: textNode.nodeValue, mountHost, instance });
        observer.observe(document.body, OBSERVE_OPTIONS);
      }
    }
  };

  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(scan);
  });

  observer.observe(document.body, OBSERVE_OPTIONS);

  // Run once immediately in case the placeholder is already present.
  scan();
}
