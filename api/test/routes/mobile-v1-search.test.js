const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-route-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/mobile/v1/reports', () => ({ buildReports: jest.fn(), buildReportList: jest.fn() }));

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const { buildReports, buildReportList } = require('../../src/mobile/v1/reports');
const { HttpError } = require('../../src/mobile/v1/common');
const store = require('../../src/mobile-tokens-store');
const { expectValid, isValid, examples, makeFakeActual } = require('../helpers/native-v1');

const NOW = new Date('2026-11-12T15:00:00.000Z');
const AUDIT = path.join(DATA_DIR, 'mobile-audit.log');

let client;

async function withServer(fn) {
  require('../../src/routes/mobile-v1').resetMobileV1State();
  require('../../src/routes/mobile-summary').resetMobileSummaryState();
  const app = require('../../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const V1 = '/api/mobile/v1';
const call = (base, token, method, url, body, extra = {}) =>
  fetch(`${base}${V1}${url}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (base, token, url) => call(base, token, 'GET', url);

async function newToken(scope = 'read', label = 'phone') {
  return store.createToken(label, DATA_DIR, { scope });
}

async function json(res, definition) {
  const body = await res.json();
  if (definition) expectValid(definition, body);
  return body;
}

const auditLines = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(async () => {
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  fs.rmSync(AUDIT, { force: true });
  validateToken.mockReset();
  validateToken.mockResolvedValue(false);
  client = makeFakeActual();
  getActualClient.mockReset();
  getActualClient.mockImplementation(async () => client);
  syncIfDue.mockReset();
  syncIfDue.mockResolvedValue(undefined);
  buildReports.mockReset();
  buildReports.mockImplementation(async () => JSON.parse(JSON.stringify(examples.reportsResponse)));
  buildReportList.mockReset();
  buildReportList.mockImplementation(async () => JSON.parse(JSON.stringify(examples.reportListResponse)));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });
});

afterEach(() => {
  console.error.mockRestore();
  jest.useRealTimers();
});


const ids = (body) => body.transactions.map((t) => t.id);

describe('GET /transactions search and combined filters', () => {
  async function run(url, token) {
    return withServer(async (base) => get(base, token, url));
  }

  test('payees alone: any of the ids (OR), ids deduped', async () => {
    const { token } = await newToken();
    const one = await json(await run('/transactions?payees=p-hw', token), 'transactionsResponse');
    expect(ids(one)).toEqual(['t-03', 't-02']);
    const both = await json(await run('/transactions?payees=p-hw,p-hw,p-grocer&limit=100', token), 'transactionsResponse');
    expect(ids(both)).toEqual(expect.arrayContaining(['t-01', 't-02', 't-10']));
    expect(ids(both)).not.toContain('t-04');
  });

  test('categories alone: any of them, and the legacy category still works', async () => {
    const { token } = await newToken();
    const many = await json(await run('/transactions?categories=c-groc,c-fuel', token), 'transactionsResponse');
    expect(ids(many)).toEqual(['t-01', 't-10', 't-11']);
    const fuel = await json(await run('/transactions?categories=c-fuel', token), 'transactionsResponse');
    expect(ids(fuel)).toEqual(['t-10', 't-11']);
    const legacy = await json(await run('/transactions?category=c-fuel', token), 'transactionsResponse');
    expect(ids(legacy)).toEqual(['t-10', 't-11']);
  });

  test('q alone matches payee name, category name and notes, case-insensitively', async () => {
    const { token } = await newToken();
    const payee = await json(await run('/transactions?q=HARDWARE', token), 'transactionsResponse');
    expect(ids(payee)).toEqual(['t-03', 't-02']);
    const category = await json(await run('/transactions?q=fuel', token), 'transactionsResponse');
    expect(ids(category)).toEqual(['t-10', 't-11']);
    const notes = await json(await run('/transactions?q=%23DIY', token), 'transactionsResponse');
    expect(ids(notes)).toEqual(['t-02']);
    const trimmed = await json(await run('/transactions?q=%20%20fuel%20', token), 'transactionsResponse');
    expect(ids(trimmed)).toEqual(['t-10', 't-11']);
  });

  test('q matches % ? _ and backslash literally', async () => {
    client.state.transactions.push(
      { id: 't-p1', date: '2026-11-04', account: 'a-chk', payee: 'p-grocer', category: null, amount: -1, notes: '100% organic', cleared: true },
      { id: 't-p2', date: '2026-11-04', account: 'a-chk', payee: 'p-grocer', category: null, amount: -1, notes: '100 percent', cleared: true },
      { id: 't-p3', date: '2026-11-03', account: 'a-chk', payee: 'p-grocer', category: null, amount: -1, notes: 'a_b', cleared: true },
      { id: 't-p4', date: '2026-11-03', account: 'a-chk', payee: 'p-grocer', category: null, amount: -1, notes: 'axb', cleared: true },
      { id: 't-p5', date: '2026-11-02', account: 'a-chk', payee: 'p-grocer', category: null, amount: -1, notes: 'what?', cleared: true },
      { id: 't-p6', date: '2026-11-02', account: 'a-chk', payee: 'p-grocer', category: null, amount: -1, notes: 'whatx', cleared: true },
      { id: 't-p7', date: '2026-11-01', account: 'a-chk', payee: 'p-grocer', category: null, amount: -1, notes: 'c:\\tmp', cleared: true },
    );
    const { token } = await newToken();
    const q = async (text) => ids(await json(await run(`/transactions?q=${encodeURIComponent(text)}`, token)));
    expect(await q('100%')).toEqual(['t-p1']);
    expect(await q('%')).toEqual(['t-p1']);
    expect(await q('a_b')).toEqual(['t-p3']);
    expect(await q('_')).toEqual(['t-p3']);
    expect(await q('what?')).toEqual(['t-p5']);
    expect(await q('\\tmp')).toEqual(['t-p7']);
    expect(await q('\\')).toEqual(['t-p7']);
  });

  test('kinds AND together, values within a kind OR', async () => {
    const { token } = await newToken();
    const r = await json(await run('/transactions?payees=p-grocer&categories=c-groc,c-fuel', token), 'transactionsResponse');
    expect(ids(r)).toEqual(['t-01', 't-10', 't-11']);
    const none = await json(await run('/transactions?payees=p-hw&categories=c-fuel', token), 'transactionsResponse');
    expect(ids(none)).toEqual([]);
    const withQ = await json(await run('/transactions?payees=p-grocer&categories=c-groc,c-fuel&q=fuel', token), 'transactionsResponse');
    expect(ids(withQ)).toEqual(['t-10', 't-11']);
    const withAccount = await json(await run('/transactions?payees=p-grocer&account=a-sav', token), 'transactionsResponse');
    expect(ids(withAccount)).toEqual([]);
    const withGroup = await json(await run('/transactions?group=g-usual&payees=p-grocer&q=groceries', token), 'transactionsResponse');
    expect(ids(withGroup)).toEqual(['t-01']);
    const withUncat = await json(await run('/transactions?uncategorized=1&payees=p-hw&q=screws', token), 'transactionsResponse');
    expect(ids(withUncat)).toEqual(['t-02']);
  });

  test('pagination keeps working with the new filters', async () => {
    const { token } = await newToken();
    const first = await json(await run('/transactions?payees=p-grocer&limit=2', token), 'transactionsResponse');
    expect(first.nextCursor).not.toBeNull();
    const second = await json(await run(`/transactions?payees=p-grocer&limit=2&cursor=${first.nextCursor}`, token), 'transactionsResponse');
    expect(second.uncategorizedCount).toBeUndefined();
    expect(ids(first).filter((id) => ids(second).includes(id))).toEqual([]);
  });

  test('uncategorizedCount ignores the new filters', async () => {
    const { token } = await newToken();
    const plain = await json(await run('/transactions', token));
    const filtered = await json(await run('/transactions?payees=p-hw&q=screws&categories=c-fuel', token));
    expect(filtered.uncategorizedCount).toBe(plain.uncategorizedCount);
  });

  test('hidden accounts stay invisible and the flag behaviour is unchanged', async () => {
    const { token } = await newToken();
    // t-07 is a Retirement (off-budget, open) row: shown. t-08 is closed: never.
    const r = await json(await run('/transactions?payees=p-grocer&limit=100', token));
    expect(ids(r)).toContain('t-07');
    expect(ids(r)).not.toContain('t-08');
    const { scopeClient } = require('../../src/mobile/v1/hidden');
    const { buildTransactions } = require('../../src/mobile/v1/read');
    const scoped = scopeClient(client, ['a-ret']);
    const body = await buildTransactions(scoped, { payees: ['p-grocer'], limit: 100 }, NOW);
    expect(body.transactions.map((t) => t.id)).not.toContain('t-07');
  });

  test.each([
    ['uncategorized=1&group=g-usual'],
    ['uncategorized=1&categories=c-groc'],
    ['uncategorized=1&category=c-groc'],
    ['group=g-usual&categories=c-groc'],
    ['group=g-usual&category=c-groc'],
    ['category=c-groc&categories=c-groc'],
    ['payees='],
    ['payees=p-hw,'],
    ['payees=,p-hw'],
    ['payees=p-hw,,p-grocer'],
    ['payees=bad%20id'],
    ['payees=p-hw&payees=p-grocer'],
    ['categories='],
    ['categories=c-groc,'],
    ['categories=bad%2Fid'],
    [`payees=${Array.from({ length: 21 }, (_, i) => `p${i}`).join(',')}`],
    [`categories=${Array.from({ length: 21 }, (_, i) => `c${i}`).join(',')}`],
    ['q='],
    ['q=%20%20'],
    [`q=${'x'.repeat(101)}`],
    ['q=a&q=b'],
    ['q[]=a'],
  ])('400: %s', async (qs) => {
    const { token } = await newToken();
    const res = await run(`/transactions?${qs}`, token);
    expect(res.status).toBe(400);
    expect(await json(res, 'error')).toEqual({ error: 'bad_request' });
  });

  test('exactly 20 ids and exactly 100 characters are accepted, and 20 duplicates dedupe', async () => {
    const { token } = await newToken();
    const twenty = Array.from({ length: 20 }, (_, i) => `p${i}`).join(',');
    expect((await run(`/transactions?payees=${twenty}`, token)).status).toBe(200);
    expect((await run(`/transactions?categories=${twenty}`, token)).status).toBe(200);
    expect((await run(`/transactions?q=${'y'.repeat(100)}`, token)).status).toBe(200);
    expect((await run(`/transactions?q=${'y'.repeat(98)}%20%20%20%20`, token)).status).toBe(200);
  });

  test('every new parameter gets its own cache entry', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const urls = ['/transactions', '/transactions?payees=p-hw', '/transactions?payees=p-grocer', '/transactions?payees=p-grocer,p-hw', '/transactions?categories=c-fuel', '/transactions?categories=c-groc', '/transactions?q=fuel', '/transactions?q=hardware', '/transactions?q=a|b', '/transactions?q=a'];
      const seen = [];
      for (const url of urls) seen.push(ids(await json(await get(base, token, url))));
      const before = client.aqlQuery.mock.calls.length;
      // The same URLs again are served from the cache, with identical bodies.
      for (const [i, url] of urls.entries()) expect(ids(await json(await get(base, token, url)))).toEqual(seen[i]);
      expect(client.aqlQuery.mock.calls.length).toBe(before);
      expect(seen[1]).not.toEqual(seen[2]);
      expect(seen[4]).not.toEqual(seen[5]);
      expect(seen[6]).not.toEqual(seen[7]);
    });
  });

  test('payees in a different order share one result', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const a = ids(await json(await get(base, token, '/transactions?payees=p-grocer,p-hw')));
      const calls = client.aqlQuery.mock.calls.length;
      const b = ids(await json(await get(base, token, '/transactions?payees=p-hw,p-grocer')));
      expect(b).toEqual(a);
      expect(client.aqlQuery.mock.calls.length).toBe(calls);
    });
  });
});

describe('GET /transactions month filter', () => {
  async function run(url, token) {
    return withServer(async (base) => get(base, token, url));
  }
  const edge = (id, date, extra = {}) => ({ id, date, account: 'a-chk', payee: 'p-grocer', category: 'c-groc', amount: -100, notes: null, cleared: true, ...extra });

  test('month alone keeps only that calendar month', async () => {
    const { token } = await newToken();
    const all = ids(await json(await run('/transactions?limit=100', token)));
    const nov = await json(await run('/transactions?month=2026-11&limit=100', token), 'transactionsResponse');
    expect(ids(nov)).toEqual(all);
    expect((await json(await run('/transactions?month=2026-10', token), 'transactionsResponse')).transactions).toEqual([]);
  });

  test('boundaries: first and last day in, neighbours out, December rolls the year', async () => {
    const { token } = await newToken();
    client.state.transactions.push(
      edge('e-sep30', '2026-09-30'), edge('e-oct01', '2026-10-01'), edge('e-oct31', '2026-10-31'), edge('e-nov01', '2026-11-01'), edge('e-nov30', '2026-11-30'),
      edge('e-dec31', '2025-12-31'), edge('e-jan01', '2026-01-01'), edge('e-dec01', '2025-12-01'), edge('e-nov30b', '2025-11-30')
    );
    const oct = ids(await json(await run('/transactions?month=2026-10&limit=100', token)));
    expect(oct.sort()).toEqual(['e-oct01', 'e-oct31']);
    const nov = ids(await json(await run('/transactions?month=2026-11&limit=100', token)));
    expect(nov).toEqual(expect.arrayContaining(['e-nov01', 'e-nov30', 't-01']));
    expect(nov).not.toContain('e-oct31');
    expect(nov).not.toContain('e-jan01');
    const dec = ids(await json(await run('/transactions?month=2025-12&limit=100', token)));
    expect(dec.sort()).toEqual(['e-dec01', 'e-dec31']);
    const jan = ids(await json(await run('/transactions?month=2026-01&limit=100', token)));
    expect(jan).toEqual(['e-jan01']);
  });

  test('is not moved by the server time zone', async () => {
    const { token } = await newToken();
    client.state.transactions.push(edge('e-oct31', '2026-10-31'), edge('e-nov01', '2026-11-01'));
    const original = process.env.TZ;
    try {
      for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
        process.env.TZ = tz;
        const oct = ids(await json(await run('/transactions?month=2026-10&limit=100', token)));
        expect(oct).toEqual(['e-oct31']);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test('ANDs with category, categories, payees, q, account, group and uncategorized', async () => {
    const { token } = await newToken();
    client.state.transactions.push(edge('e-oct-groc', '2026-10-15'), edge('e-oct-fuel', '2026-10-16', { category: 'c-fuel', payee: 'p-hw' }), edge('e-oct-none', '2026-10-17', { category: null, payee: 'p-hw', notes: 'bolts' }));
    const q = async (qs) => ids(await json(await run(`/transactions?${qs}&limit=100`, token), 'transactionsResponse')).sort();
    expect(await q('month=2026-10&category=c-groc')).toEqual(['e-oct-groc']);
    expect(await q('month=2026-10&categories=c-groc,c-fuel')).toEqual(['e-oct-fuel', 'e-oct-groc']);
    expect(await q('month=2026-10&payees=p-hw')).toEqual(['e-oct-fuel', 'e-oct-none']);
    expect(await q('month=2026-10&payees=p-hw&categories=c-fuel')).toEqual(['e-oct-fuel']);
    expect(await q('month=2026-10&q=bolts')).toEqual(['e-oct-none']);
    expect(await q('month=2026-10&account=a-sav')).toEqual([]);
    expect(await q('month=2026-10&group=g-usual')).toEqual(['e-oct-fuel', 'e-oct-groc']);
    expect(await q('month=2026-10&uncategorized=1')).toEqual(['e-oct-none']);
    expect(await q('month=2026-11&categories=c-fuel&payees=p-grocer')).toEqual(['t-10', 't-11']);
    expect(await q('month=2026-11&uncategorized=1')).not.toContain('e-oct-none');
  });

  test('cursor paging within a month: no repeats, no gaps, no other month', async () => {
    const { token } = await newToken();
    for (let i = 1; i <= 5; i += 1) client.state.transactions.push(edge(`e-oct-${i}`, `2026-10-${String(i + 10)}`));
    client.state.transactions.push(edge('e-sep', '2026-09-30'), edge('e-nov', '2026-11-01'));
    const seen = [];
    let url = '/transactions?month=2026-10&limit=2';
    for (let guard = 0; guard < 5; guard += 1) {
      const page = await json(await run(url, token), 'transactionsResponse');
      seen.push(...ids(page));
      if (!page.nextCursor) break;
      url = `/transactions?month=2026-10&limit=2&cursor=${page.nextCursor}`;
    }
    expect(seen).toEqual(['e-oct-5', 'e-oct-4', 'e-oct-3', 'e-oct-2', 'e-oct-1']);
    // A cursor from another list is just a position: the month filter still applies.
    const nov = await json(await run('/transactions?month=2026-11&limit=2', token));
    const cross = await json(await run(`/transactions?month=2026-10&limit=100&cursor=${nov.nextCursor}`, token));
    expect(ids(cross)).toEqual(['e-oct-5', 'e-oct-4', 'e-oct-3', 'e-oct-2', 'e-oct-1']);
  });

  test('uncategorized + month; uncategorizedCount ignores the month', async () => {
    const { token } = await newToken();
    client.state.transactions.push(edge('e-oct-none', '2026-10-17', { category: null }));
    const plain = await json(await run('/transactions', token));
    const oct = await json(await run('/transactions?month=2026-10&uncategorized=1', token));
    expect(ids(oct)).toEqual(['e-oct-none']);
    const octOnly = await json(await run('/transactions?month=2026-10', token));
    expect(octOnly.uncategorizedCount).toBe(plain.uncategorizedCount);
    expect(oct.uncategorizedCount).toBe(plain.uncategorizedCount);
  });

  test('current month is allowed, window edges too, and it has its own cache entry', async () => {
    const { token } = await newToken();
    expect((await run('/transactions?month=2026-11', token)).status).toBe(200);
    expect((await run('/transactions?month=2021-11', token)).status).toBe(200);
    await withServer(async (base) => {
      const a = ids(await json(await get(base, token, '/transactions?limit=100')));
      const b = ids(await json(await get(base, token, '/transactions?limit=100&month=2026-10')));
      const c = ids(await json(await get(base, token, '/transactions?limit=100')));
      expect(b).toEqual([]);
      expect(c).toEqual(a);
    });
  });

  test('rejects anything but one YYYY-MM inside the window and not in the future', async () => {
    const { token } = await newToken();
    for (const value of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', '2026-11-', '2026/11', 'nov', '2026-11%20', '2026-12', '2027-01', '2999-01', '2021-10', '1900-01']) {
      expect([value, (await run(`/transactions?month=${value}`, token)).status]).toEqual([value, 400]);
    }
    expect((await run('/transactions?month=', token)).status).toBe(400);
    expect((await run('/transactions?month=2026-10&month=2026-11', token)).status).toBe(400);
    expect((await run('/transactions?month[]=2026-10', token)).status).toBe(400);
  });
});

describe('GET /transactions/suggest', () => {
  const suggest = (url, token) => withServer(async (base) => get(base, token, url));

  beforeEach(() => {
    Object.assign(client.state.payees, {
      'p-ex2': { name: 'zed example' },
      'p-ex3': { name: 'The Example Shop' },
      'p-ex4': { name: 'Example Bakery' },
      'p-blank': { name: '  ' },
    });
  });

  test('401 without a token', async () => {
    const res = await suggest('/transactions/suggest?q=a', undefined);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('startsWith first, then alphabetical case-insensitively; matches anywhere; schema valid', async () => {
    const { token } = await newToken();
    const body = await json(await suggest('/transactions/suggest?q=EXAMPLE', token), 'transactionSuggestResponse');
    expect(body.merchants.map((m) => m.name)).toEqual(['Example Bakery', 'Example Grocer', 'Example Hardware', 'The Example Shop', 'zed example']);
    expect(body.merchants[0]).toEqual({ id: 'p-ex4', name: 'Example Bakery' });
    expect(body.categories).toEqual([]);
  });

  test('categories carry the group name; hidden categories and hidden groups are left out', async () => {
    const { token } = await newToken();
    const all = await json(await suggest('/transactions/suggest?q=', token), 'transactionSuggestResponse');
    expect(all.categories).toEqual([
      { id: 'c-fuel', name: 'Fuel', groupName: 'Usual Expenses' },
      { id: 'c-groc', name: 'Groceries', groupName: 'Usual Expenses' },
      { id: 'c-pay', name: 'Paycheck', groupName: 'Income' },
    ]);
    const hid = await json(await suggest('/transactions/suggest?q=hobby', token));
    expect(hid.categories).toEqual([]);
    const gone = await json(await suggest('/transactions/suggest?q=gone', token));
    expect(gone.categories).toEqual([]);
    const sub = await json(await suggest('/transactions/suggest?q=oc', token));
    expect(sub.categories.map((c) => c.name)).toEqual(['Groceries']);
  });

  test('startsWith beats alphabetical for categories too', async () => {
    client.state.groups[0].categories.push({ id: 'c-aaa', name: 'Dog food', is_income: false, hidden: false }, { id: 'c-zzz', name: 'Food', is_income: false, hidden: false });
    const { token } = await newToken();
    const body = await json(await suggest('/transactions/suggest?q=foo', token), 'transactionSuggestResponse');
    expect(body.categories.map((c) => c.name)).toEqual(['Food', 'Dog food']);
  });

  test('empty q (absent or blank) lists alphabetically; transfer and blank-named payees never appear', async () => {
    const { token } = await newToken();
    for (const url of ['/transactions/suggest', '/transactions/suggest?q=', '/transactions/suggest?q=%20%20']) {
      const body = await json(await suggest(url, token), 'transactionSuggestResponse');
      expect(body.merchants.map((m) => m.name)).toEqual(['Example Bakery', 'Example Grocer', 'Example Hardware', 'The Example Shop', 'zed example']);
    }
    const xfer = await json(await suggest('/transactions/suggest?q=checking', token));
    expect(xfer.merchants).toEqual([]);
  });

  test('limit: default 8, applies to each list, 1..25', async () => {
    for (let i = 0; i < 30; i += 1) {
      client.state.payees[`p-m${String(i).padStart(2, '0')}`] = { name: `Merchant ${String(i).padStart(2, '0')}` };
      client.state.groups[0].categories.push({ id: `c-n${String(i).padStart(2, '0')}`, name: `Cat ${String(i).padStart(2, '0')}`, is_income: false, hidden: false });
    }
    const { token } = await newToken();
    const dflt = await json(await suggest('/transactions/suggest?q=', token), 'transactionSuggestResponse');
    expect([dflt.merchants.length, dflt.categories.length]).toEqual([8, 8]);
    const three = await json(await suggest('/transactions/suggest?q=m&limit=3', token), 'transactionSuggestResponse');
    expect(three.merchants.map((m) => m.name)).toEqual(['Merchant 00', 'Merchant 01', 'Merchant 02']);
    const max = await json(await suggest('/transactions/suggest?q=&limit=25', token), 'transactionSuggestResponse');
    expect([max.merchants.length, max.categories.length]).toEqual([25, 25]);
  });

  test('long names are clipped to the schema maximum', async () => {
    client.state.payees['p-long'] = { name: `Long ${'x'.repeat(300)}` };
    const { token } = await newToken();
    const body = await json(await suggest('/transactions/suggest?q=long', token), 'transactionSuggestResponse');
    expect(body.merchants[0].name.length).toBe(200);
  });

  test.each([
    ['limit=0'], ['limit=26'], ['limit=-1'], ['limit=abc'], ['limit=08'], ['limit='], ['limit=1&limit=2'], ['q=a&q=b'], [`q=${'x'.repeat(101)}`], ['other=1'], ['q=a&account=a-chk'],
  ])('400: %s', async (qs) => {
    const { token } = await newToken();
    const res = await suggest(`/transactions/suggest?${qs}`, token);
    expect(res.status).toBe(400);
    expect(await json(res, 'error')).toEqual({ error: 'bad_request' });
  });

  test('q of exactly 100 characters is accepted; suggest is not captured by /transactions/:id', async () => {
    const { token } = await newToken();
    expect((await suggest(`/transactions/suggest?q=${'x'.repeat(100)}`, token)).status).toBe(200);
    const res = await suggest('/transactions/suggest', token);
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(['categories', 'merchants', 'schema']);
  });

  test('cache entries differ per q and limit, and share the read rate limit', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const a = await json(await get(base, token, '/transactions/suggest?q=example'));
      const b = await json(await get(base, token, '/transactions/suggest?q=hardware'));
      const c = await json(await get(base, token, '/transactions/suggest?q=example&limit=2'));
      expect(b.merchants).toHaveLength(1);
      expect(a.merchants.length).toBeGreaterThan(c.merchants.length);
      const calls = client.getPayees.mock.calls.length;
      await get(base, token, '/transactions/suggest?q=example');
      expect(client.getPayees.mock.calls.length).toBe(calls);
      let limited;
      for (let i = 0; i < 70 && !limited; i += 1) {
        const res = await get(base, token, `/transactions/suggest?q=${i}`);
        if (res.status === 429) limited = res;
      }
      expect(limited).toBeDefined();
      expect(await json(limited, 'error')).toEqual({ error: 'rate_limited' });
    });
  });
});
