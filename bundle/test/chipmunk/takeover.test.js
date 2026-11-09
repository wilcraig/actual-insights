vi.mock('../../src/chipmunk/chipmunk-api', () => ({ getMode: vi.fn(), setMode: vi.fn() }));
import { getMode } from '../../src/chipmunk/chipmunk-api';
import { setChipmunkMode, getChipmunkMode } from '../../src/chipmunk/mode-state';
import { startTakeover, decideTakeover, readCachedMode, writeCachedMode, isBypassed, setBypassed, CACHE_KEY, BYPASS_KEY, OFF_TTL_MS, RETRY_MS } from '../../src/chipmunk/shell/takeover';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const memory = (init = {}) => { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, dump: () => m }; };
const ON = { enabled: true, entitled: true, reason: 'verified' };

// A fake window around jsdom's real document: location/history are plain objects so paths and navigation can be asserted.
function makeWin({ pathname = '/budget', hash = '', local = memory(), session = memory() } = {}) {
  const listeners = {};
  const win = {
    pushed: [],
    location: { pathname, search: '', hash, assign: vi.fn() },
    history: {
      state: null,
      pushState: vi.fn((s, t, url) => { win.pushed.push(url); win.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; }),
      replaceState: vi.fn((s, t, url) => { win.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; }),
    },
    localStorage: local,
    sessionStorage: session,
    addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
    removeEventListener: () => {},
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    PopStateEvent: window.PopStateEvent,
    dispatchEvent: vi.fn((e) => { (listeners[e.type] || []).forEach((f) => f(e)); }),
    emit: (n) => (listeners[n] || []).forEach((f) => f()),
  };
  return win;
}

function fakeShell() {
  const shell = { show: vi.fn(), hide: vi.fn(), destroy: vi.fn() };
  const out = { shell, actual: null };
  out.mountShell = vi.fn(({ actual }) => { out.actual = actual; return shell; });
  return out;
}

let win; let startActual; let startReports; let fake; const live = [];
function run(extra = {}) {
  fake = extra.fake ?? fakeShell();
  const t = startTakeover({ win, doc: document, mountShell: fake.mountShell, startActual, startReports, ...extra.deps });
  live.push(t);
  return t;
}
afterEach(() => { while (live.length) live.pop().dispose(); });

beforeEach(() => {
  vi.resetAllMocks();
  document.body.innerHTML = '<div id="root"><p>Actual</p></div>';
  setChipmunkMode({ enabled: false, entitled: false });
  startActual = vi.fn();
  startReports = vi.fn();
  win = makeWin();
});

describe('decideTakeover', () => {
  const on = { enabled: true, entitled: true };
  test('only an on AND entitled mode that is not bypassed, broken or failed open takes over', () => {
    expect(decideTakeover({ state: on })).toBe(true);
    expect(decideTakeover({ state: { enabled: true, entitled: false } })).toBe(false);
    expect(decideTakeover({ state: { enabled: false, entitled: true } })).toBe(false);
    expect(decideTakeover({ state: null })).toBe(false);
    expect(decideTakeover({ state: on, bypassed: true })).toBe(false);
    expect(decideTakeover({ state: on, broken: true })).toBe(false);
    expect(decideTakeover({ state: on, failedOpen: true })).toBe(false);
  });
});

describe('cache and bypass storage', () => {
  test('round trip; junk and a throwing storage read as nothing', () => {
    const s = memory();
    expect(readCachedMode(s)).toBeNull();
    writeCachedMode(s, { enabled: true, entitled: true }, 1000);
    expect(readCachedMode(s, 5)).toEqual({ enabled: true, entitled: true, at: 1000 });
    s.setItem(CACHE_KEY, '{nope');
    expect(readCachedMode(s)).toBeNull();
    s.setItem(CACHE_KEY, JSON.stringify({ enabled: true, entitled: false }));
    expect(readCachedMode(s).enabled).toBe(false);
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(readCachedMode(throwing)).toBeNull();
    expect(() => writeCachedMode(throwing, ON)).not.toThrow();
    expect(isBypassed(throwing)).toBe(false);
  });
  test('bypass flag', () => {
    const s = memory();
    expect(isBypassed(s)).toBe(false);
    setBypassed(s, true);
    expect(s.dump()[BYPASS_KEY]).toBe('1');
    expect(isBypassed(s)).toBe(true);
    setBypassed(s, false);
    expect(isBypassed(s)).toBe(false);
  });
});

describe('mode off (the default): nothing changes', () => {
  test('Actual starts synchronously, no shell, and the check is not awaited', () => {
    getMode.mockReturnValue(new Promise(() => {})); // never answers
    run();
    expect(startActual).toHaveBeenCalledTimes(1);
    expect(fake.mountShell).not.toHaveBeenCalled();
    expect(document.getElementById('root').hasAttribute('inert')).toBe(false);
  });
  test('server says off: stays Actual, caches the answer', async () => {
    getMode.mockResolvedValue({ enabled: false, entitled: true });
    run();
    await flush();
    expect(fake.mountShell).not.toHaveBeenCalled();
    expect(JSON.parse(win.localStorage.getItem(CACHE_KEY))).toMatchObject({ enabled: false, entitled: true });
  });
  test('a recent cached off is trusted: no request at all; an old one is re-checked', async () => {
    writeCachedMode(win.localStorage, { enabled: false, entitled: true }, Date.now() - 1000);
    getMode.mockResolvedValue({ enabled: false, entitled: true });
    run();
    await flush();
    expect(getMode).not.toHaveBeenCalled();
    win = makeWin();
    writeCachedMode(win.localStorage, { enabled: false, entitled: true }, Date.now() - OFF_TTL_MS - 1000);
    run();
    await flush();
    expect(getMode).toHaveBeenCalledTimes(1);
  });
  test('server says on but not entitled: no shell', async () => {
    getMode.mockResolvedValue({ enabled: true, entitled: false });
    run();
    await flush();
    expect(fake.mountShell).not.toHaveBeenCalled();
  });
});

describe('mode on', () => {
  test('cached on: the shell covers Actual at once (before any answer), Actual is hidden but not destroyed', () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockReturnValue(new Promise(() => {}));
    run();
    expect(fake.mountShell).toHaveBeenCalledTimes(1);
    expect(fake.shell.show).toHaveBeenCalled();
    expect(startActual).not.toHaveBeenCalled();
    const root = document.getElementById('root');
    expect(root.hasAttribute('inert')).toBe(true);
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.style.visibility).toBe('hidden');
    expect(root.textContent).toBe('Actual'); // still there
  });
  test('first ever visit (no cache): Actual loads, then the server check brings the shell', async () => {
    getMode.mockResolvedValue(ON);
    run();
    expect(startActual).toHaveBeenCalledTimes(1);
    await flush();
    expect(fake.mountShell).toHaveBeenCalledTimes(1);
    expect(document.getElementById('root').hasAttribute('inert')).toBe(true);
    expect(JSON.parse(win.localStorage.getItem(CACHE_KEY))).toMatchObject({ enabled: true, entitled: true });
    expect(startActual).toHaveBeenCalledTimes(1);
  });
  test('cached on and the server confirms: stays covered', async () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue(ON);
    run();
    await flush();
    expect(fake.shell.hide).not.toHaveBeenCalled();
    expect(startActual).not.toHaveBeenCalled();
  });
  test('cached on but the server now says off or not entitled: fail open to Actual and cache it', async () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue({ enabled: true, entitled: false });
    run();
    await flush();
    expect(fake.shell.hide).toHaveBeenCalled();
    expect(startActual).toHaveBeenCalledTimes(1);
    expect(document.getElementById('root').hasAttribute('inert')).toBe(false);
    expect(document.getElementById('root').style.visibility).toBe('');
    expect(JSON.parse(win.localStorage.getItem(CACHE_KEY))).toMatchObject({ enabled: false, entitled: false });
  });
  test('the check fails (network, 401, junk): Actual shows, the cached answer is kept for next time', async () => {
    for (const failure of [() => Promise.reject(new Error('down')), () => Promise.resolve([]), () => Promise.resolve({ enabled: 'yes' })]) {
      document.body.innerHTML = '<div id="root"></div>';
      win = makeWin();
      startActual = vi.fn();
      writeCachedMode(win.localStorage, { enabled: true, entitled: true }, 42);
      getMode.mockImplementation(failure);
      setChipmunkMode({ enabled: false, entitled: false });
      const t = run();
      await flush();
      expect(startActual).toHaveBeenCalledTimes(1);
      expect(fake.shell.hide).toHaveBeenCalled();
      expect(t.state()).toMatchObject({ showing: false, failedOpen: true });
      expect(JSON.parse(win.localStorage.getItem(CACHE_KEY)).enabled).toBe(true);
    }
  });
  test('after a failed check it looks again when the user moves, at most every RETRY_MS', async () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockRejectedValueOnce(new Error('down'));
    let t0 = 1_000_000;
    run({ deps: { now: () => t0 } });
    await flush();
    getMode.mockResolvedValue(ON);
    win.emit('popstate');
    await flush();
    expect(getMode).toHaveBeenCalledTimes(1); // too soon
    t0 += RETRY_MS + 1;
    win.emit('popstate');
    await flush();
    expect(getMode).toHaveBeenCalledTimes(2);
    expect(fake.shell.show).toHaveBeenCalledTimes(2); // first paint, then back after recovery
  });
  test("Actual's sign-in page is never hidden behind the shell", async () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    win = makeWin({ pathname: '/login', local: win.localStorage });
    getMode.mockResolvedValue(ON);
    run();
    await flush();
    expect(fake.mountShell).not.toHaveBeenCalled();
    expect(startActual).toHaveBeenCalledTimes(1);
    // signing in moves Actual off /login: look again, take over
    win.location.pathname = '/budget';
    win.history.pushState(null, '', '/budget');
    await flush();
    expect(fake.mountShell).toHaveBeenCalledTimes(1);
  });
  test('Actual navigating to /login while covered drops the shell', async () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue(ON);
    run();
    await flush();
    win.location.pathname = '/login';
    win.history.replaceState(null, '', '/login');
    expect(fake.shell.hide).toHaveBeenCalled();
    expect(startActual).toHaveBeenCalledTimes(1);
  });
  test('turning the mode off or on later (Settings / General tab) acts at once and updates the cache', async () => {
    getMode.mockResolvedValue({ enabled: false, entitled: true });
    run();
    await flush();
    setChipmunkMode(ON);
    expect(fake.mountShell).toHaveBeenCalledTimes(1);
    expect(JSON.parse(win.localStorage.getItem(CACHE_KEY)).enabled).toBe(true);
    setChipmunkMode({ enabled: false, entitled: true });
    expect(fake.shell.hide).toHaveBeenCalled();
    expect(document.getElementById('root').hasAttribute('inert')).toBe(false);
    expect(JSON.parse(win.localStorage.getItem(CACHE_KEY)).enabled).toBe(false);
    setChipmunkMode(ON);
    expect(fake.shell.show).toHaveBeenCalledTimes(2);
    expect(fake.mountShell).toHaveBeenCalledTimes(1); // the same shell, state kept
  });
  test('turning it off from the shell drops the shell hash but keeps an Insights page hash', async () => {
    win = makeWin({ hash: '#/chipmunk/settings', local: win.localStorage });
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue(ON);
    run();
    await flush();
    setChipmunkMode({ enabled: false, entitled: true });
    expect(win.location.hash).toBe('');
    win.location.hash = '#actual-insights/forecast';
    setChipmunkMode(ON);
    setChipmunkMode({ enabled: false, entitled: true });
    expect(win.location.hash).toBe('#actual-insights/forecast');
  });
});

describe('Open Actual (bypass for this browser session)', () => {
  async function covered() {
    win = makeWin({ hash: '#/chipmunk/budget', local: win.localStorage });
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue(ON);
    const t = run();
    await flush();
    return t;
  }
  test('hides the shell, starts Actual, sets the session flag, leaves the mode on, shows a way back', async () => {
    const t = await covered();
    t.openActual();
    expect(fake.shell.hide).toHaveBeenCalled();
    expect(startActual).toHaveBeenCalledTimes(1);
    expect(document.getElementById('root').hasAttribute('inert')).toBe(false);
    expect(isBypassed(win.sessionStorage)).toBe(true);
    expect(getChipmunkMode().enabled).toBe(true);
    expect(JSON.parse(win.localStorage.getItem(CACHE_KEY)).enabled).toBe(true);
    expect(win.location.hash).toBe('');
    const pill = document.querySelector('[data-chipmunk-owned="pill"]');
    expect(pill.textContent).toContain('Back to Chipmunk');
  });
  test('the pill brings the shell back at the screen the person left', async () => {
    const t = await covered();
    t.openActual();
    document.querySelector('[data-chipmunk-owned="pill"]').click();
    expect(fake.shell.show).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-chipmunk-owned="pill"]')).toBeNull();
    expect(isBypassed(win.sessionStorage)).toBe(false);
    expect(win.location.hash).toBe('#/chipmunk/budget');
    expect(document.getElementById('root').hasAttribute('inert')).toBe(true);
  });
  test('a reload within the session stays in Actual with the pill; shell is mounted only when asked for', async () => {
    setBypassed(win.sessionStorage, true);
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue(ON);
    run();
    await flush();
    expect(fake.mountShell).not.toHaveBeenCalled();
    expect(startActual).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-chipmunk-owned="pill"]')).not.toBeNull();
    document.querySelector('[data-chipmunk-owned="pill"]').click();
    expect(fake.mountShell).toHaveBeenCalledTimes(1);
  });
  test('no pill when the mode is off (a stale flag means nothing)', async () => {
    setBypassed(win.sessionStorage, true);
    getMode.mockResolvedValue({ enabled: false, entitled: true });
    run();
    await flush();
    expect(document.querySelector('[data-chipmunk-owned="pill"]')).toBeNull();
  });
  test('turning the mode on explicitly clears the bypass', async () => {
    setBypassed(win.sessionStorage, true);
    getMode.mockResolvedValue({ enabled: false, entitled: true });
    run();
    await flush();
    setChipmunkMode(ON);
    expect(isBypassed(win.sessionStorage)).toBe(false);
    expect(fake.mountShell).toHaveBeenCalledTimes(1);
  });
  test('a path (widget builder) loads that Actual page in this session', async () => {
    const t = await covered();
    t.openActual({ path: '/reports' });
    expect(isBypassed(win.sessionStorage)).toBe(true);
    expect(win.location.assign).toHaveBeenCalledWith('/reports');
  });
});

describe('the shell throws', () => {
  test('on mount: Actual is shown, nothing stays covered, a dismissible notice appears, and it is not retried', async () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue(ON);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mountShell = vi.fn(() => { throw new Error('boom'); });
    const t = run({ fake: { mountShell, shell: {} } });
    expect(startActual).toHaveBeenCalledTimes(1);
    expect(document.getElementById('root').hasAttribute('inert')).toBe(false);
    const notice = document.querySelector('[data-chipmunk-owned="notice"]');
    expect(notice.textContent).toContain('Actual is shown instead');
    notice.querySelector('button').click();
    expect(document.querySelector('[data-chipmunk-owned="notice"]')).toBeNull();
    await flush();
    setChipmunkMode({ enabled: false, entitled: true });
    setChipmunkMode(ON);
    expect(mountShell).toHaveBeenCalledTimes(1);
    expect(t.state().broken).toBe(true);
    err.mockRestore();
  });
  test('when show() throws the half-built shell is destroyed', () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockReturnValue(new Promise(() => {}));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shell = { show: vi.fn(() => { throw new Error('nope'); }), hide: vi.fn(), destroy: vi.fn() };
    run({ fake: { mountShell: () => shell, shell } });
    expect(shell.destroy).toHaveBeenCalled();
    expect(startActual).toHaveBeenCalledTimes(1);
    expect(document.getElementById('root').hasAttribute('inert')).toBe(false);
    err.mockRestore();
  });
});

describe('blocked storage', () => {
  test('throwing localStorage and sessionStorage behave like mode off', async () => {
    const throwing = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    win = makeWin({ local: throwing, session: throwing });
    getMode.mockResolvedValue({ enabled: false, entitled: false });
    run();
    await flush();
    expect(startActual).toHaveBeenCalledTimes(1);
    expect(fake.mountShell).not.toHaveBeenCalled();
  });
});

describe('the Reports screen shows Actual in its slot', () => {
  const slotAt = (box = { left: 248, top: 53, width: 1192, height: 847 }) => Object.assign(document.createElement('div'), { getBoundingClientRect: () => box });
  async function covered() {
    win = makeWin({ pathname: '/budget', hash: '#/chipmunk/reports', local: win.localStorage });
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue(ON);
    const t = run();
    await flush();
    return t;
  }
  const root = () => document.getElementById('root');

  test('covered by default; reveal un-hides Actual, starts only the Reports parts and lays it out in the slot', async () => {
    await covered();
    expect(root().hasAttribute('inert')).toBe(true);
    expect(startReports).not.toHaveBeenCalled();
    fake.actual.reveal(slotAt());
    expect(startReports).toHaveBeenCalledTimes(1);
    expect(startActual).not.toHaveBeenCalled(); // the full Actual-side start waits for Open Actual
    expect(root().hasAttribute('inert')).toBe(false);
    expect(root().getAttribute('aria-hidden')).toBeNull();
    expect(root().style.visibility).toBe('');
    expect(root().style.width).toBe('1192px');
    expect(root().style.top).toBe('53px');
  });
  test('a slot registered while the shell mounts is applied when the shell shows', () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockReturnValue(new Promise(() => {}));
    const f = fakeShell();
    f.mountShell = vi.fn(({ actual }) => { f.actual = actual; actual.reveal(slotAt()); return f.shell; });
    run({ fake: f });
    expect(root().hasAttribute('inert')).toBe(false);
    expect(root().style.width).toBe('1192px');
  });
  test('conceal covers Actual again and clears the layout', async () => {
    await covered();
    fake.actual.reveal(slotAt());
    fake.actual.conceal();
    expect(root().hasAttribute('inert')).toBe(true);
    expect(root().style.visibility).toBe('hidden');
    expect(root().style.width).toBe('');
    expect(root().style.top).toBe('');
  });
  test('Open Actual from the Reports screen leaves Actual whole (no leftover layout or inert)', async () => {
    const t = await covered();
    fake.actual.reveal(slotAt());
    t.openActual();
    expect(root().getAttribute('style') ?? '').toBe('');
    expect(root().hasAttribute('inert')).toBe(false);
    expect(startActual).toHaveBeenCalledTimes(1);
    // and back: the shell shows again and Actual returns to its slot
    document.querySelector('[data-chipmunk-owned="pill"]').click();
    expect(root().style.width).toBe('1192px');
  });
  test('failure of the shell never leaves Actual laid out in a slot', async () => {
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockReturnValue(new Promise(() => {}));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeShell();
    f.shell.show = vi.fn(() => { throw new Error('x'); });
    f.mountShell = vi.fn(({ actual }) => { f.actual = actual; actual.reveal(slotAt()); return f.shell; });
    run({ fake: f });
    expect(root().getAttribute('style') ?? '').toBe('');
    expect(root().hasAttribute('inert')).toBe(false);
    err.mockRestore();
  });
  test('turning the mode off from the shell restores Actual', async () => {
    await covered();
    fake.actual.reveal(slotAt());
    setChipmunkMode({ enabled: false, entitled: true });
    expect(root().getAttribute('style') ?? '').toBe('');
    expect(startActual).toHaveBeenCalledTimes(1);
  });
  test('navigate moves Actual with pushState + popstate, keeps the shell hash, and is a no-op on the same path', async () => {
    await covered();
    let popped = 0;
    win.addEventListener('popstate', () => { popped += 1; });
    fake.actual.navigate('/reports/abc');
    expect(win.pushed).toEqual(['/reports/abc#/chipmunk/reports']);
    expect(popped).toBe(1);
    win.location.pathname = '/reports/abc';
    fake.actual.navigate('/reports/abc');
    expect(popped).toBe(1);
  });
  test('path listeners hear Actual moving; Actual leaving Reports for its app (after a file loads) is brought back, throttled', async () => {
    let t0 = 1_000_000;
    win = makeWin({ pathname: '/', hash: '#/chipmunk/reports', local: win.localStorage });
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue(ON);
    run({ deps: { now: () => t0 } });
    await flush();
    fake.actual.reveal(slotAt());
    const seen = [];
    const off = fake.actual.onPath((p) => seen.push(p));
    fake.actual.navigate('/reports/d1');
    win.location.pathname = '/budget'; // the budget file finished loading
    win.emit('popstate');
    expect(seen).toContain('/budget');
    expect(win.pushed.at(-1)).toBe('/reports/d1#/chipmunk/reports');
    const pushes = win.pushed.length;
    win.emit('popstate'); // within the throttle: no second push
    expect(win.pushed.length).toBe(pushes);
    t0 += 2000;
    win.emit('popstate');
    expect(win.pushed.length).toBe(pushes + 1);
    off();
    win.location.pathname = '/reports/d1';
    win.emit('popstate');
    expect(seen.at(-1)).not.toBe('/reports/d1');
  });
  test("Actual's file picker (path /) is left alone so the budget can be opened", async () => {
    win = makeWin({ pathname: '/', hash: '#/chipmunk/reports', local: win.localStorage });
    writeCachedMode(win.localStorage, { enabled: true, entitled: true });
    getMode.mockResolvedValue(ON);
    run();
    await flush();
    fake.actual.reveal(slotAt());
    fake.actual.navigate('/reports/d1');
    const pushes = win.pushed.length;
    win.emit('popstate');
    expect(win.pushed.length).toBe(pushes);
  });
});
