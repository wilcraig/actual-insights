import { getMode } from '../chipmunk-api';
import { getChipmunkMode, setChipmunkMode, subscribeChipmunkMode } from '../mode-state';
import { isShellHash } from './routes';

// Whole-app Chipmunk mode: decides, on every page load, whether the Chipmunk
// shell covers Actual, and runs the escape hatches (Open Actual for this
// browser session, fail open, fall back when the shell throws).
//
// The decision for the first paint comes from the last answer cached in
// localStorage, so a person with the mode on never sees Actual flash first.
// A server check (non-blocking) then confirms; any doubt (request fails, not
// signed in, not entitled) means plain Actual.

export const CACHE_KEY = 'insights:chipmunk:mode';
export const BYPASS_KEY = 'insights:chipmunk:bypass';
// A cached "off" is trusted this long before asking the server again, so a
// browser that never uses the mode adds at most one background request a minute.
export const OFF_TTL_MS = 60_000;
export const RETRY_MS = 30_000;

const guard = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export function readCachedMode(storage, now = Date.now()) {
  const raw = guard(() => JSON.parse(storage.getItem(CACHE_KEY)));
  if (!raw || typeof raw !== 'object') return null;
  const entitled = raw.entitled === true;
  return { enabled: raw.enabled === true && entitled, entitled, at: Number.isFinite(raw.at) ? raw.at : now };
}

export function writeCachedMode(storage, state, now = Date.now()) {
  guard(() => storage.setItem(CACHE_KEY, JSON.stringify({ enabled: state.enabled === true, entitled: state.entitled === true, at: now })));
}

export const isBypassed = (session) => guard(() => session.getItem(BYPASS_KEY) === '1', false);
export function setBypassed(session, on) {
  guard(() => (on ? session.setItem(BYPASS_KEY, '1') : session.removeItem(BYPASS_KEY)));
}

/** The one rule: the shell shows only for a mode that is on AND entitled, not bypassed, not broken. */
export function decideTakeover({ state, bypassed = false, broken = false, failedOpen = false }) {
  return !!state && state.enabled === true && state.entitled === true && !bypassed && !broken && !failedOpen;
}

const OWNED = 'data-chipmunk-owned';

function inertTargets(doc) {
  return [...doc.body.children].filter(
    (el) => !el.hasAttribute(OWNED) && !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName),
  );
}

/**
 * @param {{ win: Window, doc: Document, mountShell: Function, startActual: Function,
 *           getModeFn?: Function, now?: () => number }} deps
 *   mountShell({ openActual }) returns { show(), hide(), destroy() } or throws.
 *   startActual() runs everything Actual-side (once).
 */
export function startTakeover({ win, doc, mountShell, startActual, getModeFn = getMode, now = () => Date.now() }) {
  const local = guard(() => win.localStorage);
  const session = guard(() => win.sessionStorage);
  let bypassed = session ? isBypassed(session) : false;
  let broken = false;
  let failedOpen = false;
  let actualStarted = false;
  let shell = null;
  let showing = false;
  let pill = null;
  let notice = null;
  let covered = []; // [{ el, inert, ariaHidden, visibility }]
  let lastCheck = 0;
  let checking = false;
  let lastShellHash = null;

  const cached = local ? readCachedMode(local, now()) : null;
  if (cached) setChipmunkMode(cached);

  function ensureActual() {
    if (actualStarted) return;
    actualStarted = true;
    startActual();
  }

  function cover() {
    uncover();
    covered = inertTargets(doc).map((el) => ({
      el,
      inert: el.hasAttribute('inert'),
      ariaHidden: el.getAttribute('aria-hidden'),
      visibility: el.style.visibility,
    }));
    for (const { el } of covered) {
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
      el.style.visibility = 'hidden';
    }
  }

  function uncover() {
    for (const c of covered) {
      c.el.toggleAttribute('inert', c.inert);
      if (c.ariaHidden === null) c.el.removeAttribute('aria-hidden');
      else c.el.setAttribute('aria-hidden', c.ariaHidden);
      c.el.style.visibility = c.visibility;
    }
    covered = [];
  }

  // Leaving for Actual on purpose (Open Actual) drops any shell address, the
  // Insights one included; turning the mode off keeps `#actual-insights`, so the
  // person lands on the same page in Actual's own overlay.
  let stripAny = false;
  function dropShellHash() {
    const strip = stripAny ? win.location.hash !== '' : isShellHash(win.location.hash);
    stripAny = false;
    if (strip) {
      guard(() => win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`));
    }
  }

  function showNotice(text) {
    if (notice) return;
    notice = doc.createElement('div');
    notice.setAttribute(OWNED, 'notice');
    notice.setAttribute('role', 'status');
    notice.style.cssText =
      'position:fixed;left:16px;bottom:16px;z-index:2147483600;max-width:calc(100vw - 32px);display:flex;gap:10px;align-items:center;' +
      'padding:10px 14px;border-radius:10px;font:14px system-ui,sans-serif;background:#1f2937;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    const span = doc.createElement('span');
    span.textContent = text;
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'border:0;background:transparent;color:inherit;font-size:18px;cursor:pointer;line-height:1';
    close.addEventListener('click', () => {
      notice?.remove();
      notice = null;
    });
    notice.append(span, close);
    doc.body.appendChild(notice);
  }

  function showPill(on) {
    if (!on) {
      pill?.remove();
      pill = null;
      return;
    }
    if (pill) return;
    pill = doc.createElement('button');
    pill.type = 'button';
    pill.setAttribute(OWNED, 'pill');
    pill.textContent = '← Back to Chipmunk';
    pill.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483500;padding:9px 16px;border-radius:999px;border:0;cursor:pointer;' +
      'font:600 14px system-ui,sans-serif;background:#2563eb;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.35)';
    pill.addEventListener('click', backToChipmunk);
    doc.body.appendChild(pill);
  }

  function fail(err) {
    console.error('chipmunk shell failed, showing Actual:', err);
    broken = true;
    try {
      shell?.destroy();
    } catch {
      // Already broken; nothing more to clean.
    }
    shell = null;
    showing = false;
    uncover();
    dropShellHash();
    ensureActual();
    showNotice('The Chipmunk view could not load, so Actual is shown instead.');
  }

  function showShell() {
    if (showing) return;
    try {
      if (!shell) shell = mountShell({ openActual });
      cover();
      shell.show();
      showing = true;
      showPill(false);
    } catch (err) {
      fail(err);
    }
  }

  function hideShell() {
    if (showing) {
      lastShellHash = win.location.hash;
      guard(() => shell.hide());
      showing = false;
      uncover();
      dropShellHash();
    }
    stripAny = false;
    ensureActual();
    showPill(bypassed && !broken && getChipmunkMode().enabled);
  }

  function render() {
    if (disposed) return;
    const want = decideTakeover({ state: getChipmunkMode(), bypassed, broken, failedOpen });
    if (want) showShell();
    else hideShell();
  }

  /** Drop to Actual for this browser session; `path` (e.g. '/reports') loads that Actual page. */
  function openActual({ path } = {}) {
    bypassed = true;
    stripAny = true;
    if (session) setBypassed(session, true);
    if (path && win.location.pathname !== path) {
      win.location.assign(path);
      return;
    }
    render();
    showPill(true);
  }

  function backToChipmunk() {
    bypassed = false;
    if (session) setBypassed(session, false);
    showPill(false);
    if (lastShellHash && win.location.hash === '') {
      guard(() => win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}${lastShellHash}`));
    }
    render();
  }

  async function check() {
    if (checking) return;
    checking = true;
    lastCheck = now();
    try {
      const answer = await getModeFn();
      if (!answer || typeof answer.enabled !== 'boolean' || typeof answer.entitled !== 'boolean') throw new Error('unusable answer');
      failedOpen = false;
      const state = { enabled: answer.enabled && answer.entitled, entitled: answer.entitled };
      if (local) writeCachedMode(local, state, now());
      if (state.enabled === getChipmunkMode().enabled && state.entitled === getChipmunkMode().entitled) render();
      else setChipmunkMode(answer); // the subscription below renders
    } catch {
      failedOpen = true;
      render();
    } finally {
      checking = false;
    }
  }

  // Turned on or off from the Settings screen or the General tab: act at once.
  let wasEnabled = getChipmunkMode().enabled;
  let disposed = false;
  const unsubscribe = subscribeChipmunkMode((state) => {
    if (disposed) return;
    if (local) writeCachedMode(local, state, now());
    failedOpen = false;
    if (state.enabled && !wasEnabled) {
      bypassed = false;
      if (session) setBypassed(session, false);
      showPill(false);
    }
    wasEnabled = state.enabled;
    render();
  });

  const isAuthPath = (p) => /^\/(login|bootstrap)(\/|$)/.test(p || '');
  let sawAuth = isAuthPath(win.location.pathname);
  if (sawAuth) failedOpen = true;

  // First paint: from the cache (shell at once) or plain Actual, as before.
  render();

  // Server check. A cached "on" is always confirmed; a recent cached "off" is trusted briefly.
  const recentOff = cached && !cached.enabled && now() - cached.at < OFF_TTL_MS;
  if (!recentOff && !failedOpen) check();

  // Actual's own sign-in page must never sit behind the shell: if Actual
  // moves to /login (session ended) fail open, and look again once it leaves.
  // After any other failed check, retry as the user moves around, at most every RETRY_MS.
  const onRoute = () => {
    if (disposed) return;
    const authNow = isAuthPath(win.location.pathname);
    if (authNow) {
      sawAuth = true;
      if (!failedOpen) {
        failedOpen = true;
        render();
      }
      return;
    }
    if (sawAuth) {
      sawAuth = false;
      check();
      return;
    }
    if (failedOpen && now() - lastCheck > RETRY_MS) check();
  };
  win.addEventListener('popstate', onRoute);
  win.addEventListener('focus', onRoute);
  for (const method of ['pushState', 'replaceState']) {
    const original = win.history[method];
    win.history[method] = function (...args) {
      const r = original.apply(this, args);
      onRoute();
      return r;
    };
  }

  // Stops reacting (tests; the page itself never disposes it).
  const dispose = () => {
    disposed = true;
    unsubscribe();
  };

  return { dispose, openActual, backToChipmunk, check, state: () => ({ showing, bypassed, broken, failedOpen, actualStarted }) };
}
