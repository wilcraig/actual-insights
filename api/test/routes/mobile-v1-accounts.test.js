const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-accounts-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/mobile/v1/reports', () => ({ buildReports: jest.fn(), buildReportList: jest.fn() }));

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const tokens = require('../../src/mobile-tokens-store');
const settingsStore = require('../../src/mobile-account-settings-store');
const hiddenStore = require('../../src/mobile-hidden-accounts-store');
const { buildHistory, makeTrend, sampleDates } = require('../../src/mobile/v1/accounts');
const { expectValid, examples, makeFakeActual } = require('../helpers/native-v1');

const AUDIT = path.join(DATA_DIR, 'mobile-audit.log');
const SETTINGS = path.join(DATA_DIR, settingsStore.FILE_NAME);
let client;
let aqlCalls;

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ago = (n) => {
  const t = new Date();
  return fmt(new Date(t.getFullYear(), t.getMonth(), t.getDate() - n));
};
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// The fake client's AQL has no groupBy, $oneof or $lte: evaluate just what the
// account history/trend queries use, over state.rows (live rows, the way
// Actual's default 'inline' splits give them: no split parents).
function evalMatch(row, expr) {
  return Object.entries(expr).every(([k, v]) => {
    if (k === '$and') return v.every((e) => evalMatch(row, e));
    if (k === '$or') return v.some((e) => evalMatch(row, e));
    const actual = row[k] ?? null;
    if (v !== null && typeof v === 'object') {
      if ('$oneof' in v) return v.$oneof.includes(actual);
      if ('$ne' in v) return actual !== v.$ne;
      if ('$lte' in v) return actual <= v.$lte;
      if ('$gte' in v) return actual >= v.$gte;
      throw new Error('test AQL: unsupported operator');
    }
    return actual === v;
  });
}
function installAql(c, rows) {
  const original = c.aqlQuery.getMockImplementation();
  c.aqlQuery.mockImplementation(async (query) => {
    const s = query.serialize();
    if (s.table !== 'transactions' || s.groupExpressions.length === 0) return original(query);
    aqlCalls += 1;
    let live = rows.filter((r) => !r.tombstone && !r.is_parent);
    for (const f of s.filterExpressions) live = live.filter((r) => evalMatch(r, f));
    const key = s.groupExpressions[0];
    const sums = new Map();
    for (const r of live) sums.set(r[key], (sums.get(r[key]) || 0) + r.amount);
    return { data: [...sums].map(([k, amount]) => ({ [key]: k, amount, count: 1 })) };
  });
}

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
const call = (base, token, method, url, body) =>
  fetch(`${base}/api/mobile/v1${url}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (base, token, url) => call(base, token, 'GET', url);
const put = (base, token, url, body) => call(base, token, 'PUT', url, body);
async function json(res, definition) {
  const body = await res.json();
  if (definition) expectValid(definition, body);
  return body;
}
const newToken = (scope = 'read') => tokens.createToken('phone', DATA_DIR, { scope });
const auditLines = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const row = (account, daysAgo, amount, extra = {}) => ({ id: `t-${account}-${daysAgo}-${amount}`, date: ago(daysAgo), account, amount, tombstone: false, ...extra });

beforeEach(async () => {
  for (const t of await tokens.listTokens(DATA_DIR)) await tokens.revokeToken(t.id, DATA_DIR);
  fs.rmSync(AUDIT, { force: true });
  fs.rmSync(SETTINGS, { force: true });
  fs.rmSync(path.join(DATA_DIR, hiddenStore.FILE_NAME), { force: true });
  validateToken.mockReset();
  validateToken.mockResolvedValue(false);
  client = makeFakeActual();
  // a-ret: 10,000.00 opened 400 days ago, +500 45 days ago, +200 ten days ago, -50 three days ago.
  const rows = [
    row('a-ret', 400, 1000000),
    row('a-ret', 45, 50000),
    row('a-ret', 10, 20000),
    row('a-ret', 3, -5000),
    row('a-ret', 2, 999, { tombstone: true }),
    row('a-chk', 100, 312450),
  ];
  client.state.accounts.find((a) => a.id === 'a-ret').balance = 1065000;
  aqlCalls = 0;
  installAql(client, rows);
  getActualClient.mockReset();
  getActualClient.mockImplementation(async () => client);
  syncIfDue.mockReset();
  syncIfDue.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

test('the contract examples validate', () => {
  expectValid('accountsResponse', examples.accountsResponse);
  expectValid('accountDetailResponse', examples.accountDetailResponse);
  expectValid('accountSettingsRequest', examples.accountSettingsRequest);
});

describe('makeTrend', () => {
  const now = 1000000;
  test('up, down, flat within 0.5% of the start, both zero, zero start', () => {
    expect(makeTrend(1065000, 1050000)).toEqual({ direction: 'up', change: 15000, percent: 1.4, days: 30 });
    expect(makeTrend(950000, 1000000)).toEqual({ direction: 'down', change: -50000, percent: -5, days: 30 });
    expect(makeTrend(1005000, 1000000)).toMatchObject({ direction: 'flat', change: 5000, percent: 0.5 });
    expect(makeTrend(1005001, 1000000).direction).toBe('up');
    expect(makeTrend(995000, 1000000).direction).toBe('flat');
    expect(makeTrend(995000 - 1, 1000000).direction).toBe('down');
    expect(makeTrend(0, 0)).toEqual({ direction: 'flat', change: 0, percent: null, days: 30 });
    expect(makeTrend(now, 0)).toEqual({ direction: 'up', change: now, percent: null, days: 30 });
    expect(makeTrend(-500, -1000)).toMatchObject({ direction: 'up', change: 500, percent: 50 });
  });
});

describe('PUT /accounts/<id>/settings', () => {
  test('a read token is refused, no token is 401, nothing is written', async () => {
    await withServer(async (base) => {
      const { token } = await newToken('read');
      const res = await put(base, token, '/accounts/a-ret/settings', { investment: true });
      expect(res.status).toBe(403);
      expect((await put(base, null, '/accounts/a-ret/settings', { investment: true })).status).toBe(401);
      expect(fs.existsSync(SETTINGS)).toBe(false);
    });
  });

  test('marks and unmarks, answers okResponse, audits before/after (never the token), and /accounts follows', async () => {
    const { token, id } = await newToken('write');
    await withServer(async (base) => {
      const before = await json(await get(base, token, '/accounts'), 'accountsResponse');
      expect(before.accounts.every((a) => a.investment === false && a.trend === null)).toBe(true);

      const res = await put(base, token, '/accounts/a-ret/settings', { investment: true });
      expect(res.status).toBe(200);
      expect(await json(res, 'okResponse')).toEqual({ schema: 1, ok: true });
      expect(JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))).toEqual({ investmentIds: ['a-ret'] });

      const after = await json(await get(base, token, '/accounts'), 'accountsResponse');
      const ret = after.accounts.find((a) => a.id === 'a-ret');
      expect(ret.investment).toBe(true);
      expect(ret.trend).toEqual({ direction: 'up', change: 15000, percent: 1.4, days: 30 });
      expect(after.accounts.filter((a) => a.id !== 'a-ret').every((a) => a.investment === false && a.trend === null)).toBe(true);

      expect((await put(base, token, '/accounts/a-ret/settings', { investment: false })).status).toBe(200);
      const gone = await json(await get(base, token, '/accounts'), 'accountsResponse');
      expect(gone.accounts.find((a) => a.id === 'a-ret')).toMatchObject({ investment: false, trend: null });

      const lines = auditLines();
      expect(lines.map((l) => [l.op, l.ids, l.before, l.after])).toEqual([
        ['account.settings', { account: 'a-ret' }, { investment: false }, { investment: true }],
        ['account.settings', { account: 'a-ret' }, { investment: true }, { investment: false }],
      ]);
      expect(lines.every((l) => l.tokenId === id)).toBe(true);
      expect(fs.readFileSync(AUDIT, 'utf8')).not.toContain(token);
    });
  });

  test('an investment account with a zero starting balance has percent null', async () => {
    client.state.accounts.find((a) => a.id === 'a-chk').balance = 312450;
    await settingsStore.writeInvestmentIds(['a-chk'], DATA_DIR);
    const { token } = await newToken('read');
    await withServer(async (base) => {
      // a-chk's only row is 100 days old: balance 30 days ago = the full 312450.
      const chk = (await json(await get(base, token, '/accounts'), 'accountsResponse')).accounts.find((a) => a.id === 'a-chk');
      expect(chk.trend).toEqual({ direction: 'flat', change: 0, percent: 0, days: 30 });
    });
  });

  test('strict: unknown keys, wrong types, empty or extra bodies are 400; bad ids 400; unknown or hidden account 404', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const bad = [
        { investment: 'yes' },
        { investment: 1 },
        {},
        { investment: true, extra: 1 },
        [],
        'null',
      ];
      for (const body of bad) expect([JSON.stringify(body), (await put(base, token, '/accounts/a-ret/settings', body)).status]).toEqual([JSON.stringify(body), 400]);
      expect((await put(base, token, '/accounts/bad.id/settings', { investment: true })).status).toBe(400);
      expect((await put(base, token, '/accounts/nope/settings', { investment: true })).status).toBe(404);
      await hiddenStore.writeHiddenIds(['a-sav'], DATA_DIR);
      expect((await put(base, token, '/accounts/a-sav/settings', { investment: true })).status).toBe(404);
      expect(fs.existsSync(SETTINGS)).toBe(false);
      expect(auditLines()).toEqual([]);
    });
  });

  test('at most 200 ids', async () => {
    await settingsStore.writeInvestmentIds(Array.from({ length: 300 }, (_, i) => `x${i}`), DATA_DIR);
    expect(await settingsStore.readInvestmentIds(DATA_DIR)).toHaveLength(200);
    const { token } = await newToken('write');
    await withServer(async (base) => {
      expect((await put(base, token, '/accounts/a-ret/settings', { investment: true })).status).toBe(400);
    });
  });
});

describe('the settings store', () => {
  test('a missing or corrupt file means none; odd ids are dropped', async () => {
    expect(await settingsStore.readInvestmentIds(DATA_DIR)).toEqual([]);
    fs.writeFileSync(SETTINGS, '{broken');
    expect(await settingsStore.readInvestmentIds(DATA_DIR)).toEqual([]);
    fs.writeFileSync(SETTINGS, JSON.stringify({ investmentIds: ['ok', 'ok', 5, 'bad id', '../x', null, 'also-ok'] }));
    expect(await settingsStore.readInvestmentIds(DATA_DIR)).toEqual(['ok', 'also-ok']);
  });

  test('GET /accounts tolerates a corrupt file', async () => {
    fs.writeFileSync(SETTINGS, '{broken');
    const { token } = await newToken('read');
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/accounts'), 'accountsResponse');
      expect(body.accounts.every((a) => a.investment === false && a.trend === null)).toBe(true);
    });
  });
});

describe('trend', () => {
  test('hidden accounts stay hidden even when marked', async () => {
    await settingsStore.writeInvestmentIds(['a-ret', 'a-sav'], DATA_DIR);
    await hiddenStore.writeHiddenIds(['a-sav'], DATA_DIR);
    const { token } = await newToken('read');
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/accounts'), 'accountsResponse');
      expect(body.accounts.map((a) => a.id)).toEqual(['a-chk', 'a-sav', 'a-ret'].filter((id) => id !== 'a-sav'));
      expect(body.accounts.find((a) => a.id === 'a-ret').trend.direction).toBe('up');
    });
  });

  test('a falling account is down; an unknown balance has no trend; one trend query serves all investment accounts', async () => {
    await settingsStore.writeInvestmentIds(['a-ret', 'a-chk'], DATA_DIR);
    client.state.accounts.find((a) => a.id === 'a-ret').balance = 900000;
    client.getAccountBalance.mockImplementation(async (id) => {
      if (id === 'a-chk') throw new Error('boom');
      return client.state.accounts.find((a) => a.id === id).balance;
    });
    const { token } = await newToken('read');
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/accounts'), 'accountsResponse');
      expect(body.accounts.find((a) => a.id === 'a-ret').trend).toMatchObject({ direction: 'down', change: -150000 });
      expect(body.accounts.find((a) => a.id === 'a-chk')).toMatchObject({ balance: null, investment: true, trend: null });
      expect(aqlCalls).toBe(1);
    });
  });
});

describe('GET /accounts/<id>', () => {
  test('default range is 1y; the account matches /accounts; history ends with today and starts at the window start', async () => {
    await settingsStore.writeInvestmentIds(['a-ret'], DATA_DIR);
    const { token } = await newToken('read');
    await withServer(async (base) => {
      const accounts = await json(await get(base, token, '/accounts'), 'accountsResponse');
      const body = await json(await get(base, token, '/accounts/a-ret'), 'accountDetailResponse');
      expect(body.range).toBe('1y');
      expect(body.account).toEqual(accounts.accounts.find((a) => a.id === 'a-ret'));
      expect(body.account.investment).toBe(true);
      expect(body.history.length).toBeLessThanOrEqual(400);
      const last = body.history[body.history.length - 1];
      expect(last).toEqual({ date: ago(0), balance: 1065000 - 0 });
      // The window starts a year back with the balance the account then had (opened 400 days ago).
      expect(body.history[0].balance).toBe(1000000);
      const dates = body.history.map((p) => p.date);
      expect([...dates].sort()).toEqual(dates);
      expect(new Set(dates).size).toBe(dates.length);
      // The three-day-ago spend and the tombstone: balance 3 days ago is after the -50.00, 4 days ago is not.
      expect(body.history.find((p) => p.date === ago(4)).balance).toBe(1070000);
      expect(body.history.find((p) => p.date === ago(3)).balance).toBe(1065000);
      expect(body.history.find((p) => p.date === ago(2)).balance).toBe(1065000);
    });
  });

  test('ranges cut the window: 3m starts ~3 months back, all starts at the first transaction', async () => {
    const { token } = await newToken('read');
    await withServer(async (base) => {
      const three = await json(await get(base, token, '/accounts/a-ret?range=3m'), 'accountDetailResponse');
      expect(three.range).toBe('3m');
      expect(daysBetween(three.history[0].date, ago(0))).toBeGreaterThanOrEqual(89);
      expect(daysBetween(three.history[0].date, ago(0))).toBeLessThanOrEqual(92);
      const six = await json(await get(base, token, '/accounts/a-ret?range=6m'), 'accountDetailResponse');
      expect(daysBetween(six.history[0].date, ago(0))).toBeGreaterThanOrEqual(180);
      const all = await json(await get(base, token, '/accounts/a-ret?range=all'), 'accountDetailResponse');
      expect(all.history[0]).toEqual({ date: ago(400), balance: 1000000 });
      expect(all.history.length).toBeLessThanOrEqual(400);
    });
  });

  test('an account with no transactions has a single point today', async () => {
    const { token } = await newToken('read');
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/accounts/a-sav?range=all'), 'accountDetailResponse');
      expect(body.history).toEqual([{ date: ago(0), balance: 0 }]);
    });
  });

  test('invalid or repeated range, extra params, bad id: 400; unknown, closed or hidden account: 404', async () => {
    const { token } = await newToken('read');
    await withServer(async (base) => {
      for (const url of ['/accounts/a-ret?range=2y', '/accounts/a-ret?range=', '/accounts/a-ret?range=1Y', '/accounts/a-ret?x=1', '/accounts/a-ret?range=3m&range=6m', '/accounts/bad.id']) {
        expect([url, (await get(base, token, url)).status]).toEqual([url, 400]);
      }
      for (const id of ['nope', 'a-old']) expect([id, (await get(base, token, `/accounts/${id}`)).status]).toEqual([id, 404]);
      await hiddenStore.writeHiddenIds(['a-sav'], DATA_DIR);
      const res = await get(base, token, '/accounts/a-sav?range=3m');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });
  });

  test('hidden accounts transactions are never read for another account (history uses the scoped client)', async () => {
    await hiddenStore.writeHiddenIds(['a-chk'], DATA_DIR);
    const { token } = await newToken('read');
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/accounts/a-ret?range=all'), 'accountDetailResponse');
      expect(body.history[0].balance).toBe(1000000);
    });
  });

  test('one AQL query per request, cached 15 s per id and range, cleared by a write', async () => {
    const reader = await newToken('read');
    const writer = await newToken('write');
    await withServer(async (base) => {
      await get(base, reader.token, '/accounts/a-ret?range=3m');
      expect(aqlCalls).toBe(1);
      await get(base, reader.token, '/accounts/a-ret?range=3m');
      expect(aqlCalls).toBe(1);
      await get(base, reader.token, '/accounts/a-ret?range=6m');
      expect(aqlCalls).toBe(2);
      expect((await put(base, writer.token, '/accounts/a-ret/settings', { investment: true })).status).toBe(200);
      const body = await json(await get(base, reader.token, '/accounts/a-ret?range=3m'), 'accountDetailResponse');
      expect(body.account.investment).toBe(true);
      // The write cleared the cache; investment trend adds one more query for the account list.
      expect(aqlCalls).toBeGreaterThan(2);
    });
  });
});

describe('buildHistory', () => {
  const now = new Date(2026, 10, 7, 12, 0, 0);
  const d = (s, amount) => [s, { amount, count: 1 }];

  test('daily for the last 60 days, weekly beyond, monthly past a year; ends today; at most 400', () => {
    const daily = new Map([d('2020-01-01', 100), d('2026-11-01', 50)]);
    const points = buildHistory(daily, 'all', now);
    expect(points.length).toBeLessThanOrEqual(400);
    expect(points[0]).toEqual({ date: '2020-01-01', balance: 100 });
    expect(points[points.length - 1]).toEqual({ date: '2026-11-07', balance: 150 });
    const dates = points.map((p) => p.date);
    // Last 60 days: every day.
    const recent = dates.filter((x) => x > '2026-09-08');
    expect(recent).toHaveLength(60);
    // Between 60 days and a year: 7 days apart.
    const weekly = dates.filter((x) => x <= '2026-09-08' && x >= '2025-11-30');
    for (let i = 1; i < weekly.length; i += 1) expect(daysBetween(weekly[i - 1], weekly[i])).toBe(7);
    // Older than a year: roughly monthly.
    const old = dates.filter((x) => x < '2025-11-07');
    for (let i = 2; i < old.length - 1; i += 1) expect(daysBetween(old[i - 1], old[i])).toBeGreaterThanOrEqual(28);
  });

  test('a history longer than 400 sampled points is thinned and still ends today', () => {
    const points = buildHistory(new Map([d('1900-01-05', 1)]), 'all', now);
    expect(points.length).toBeLessThanOrEqual(400);
    expect(points[points.length - 1].date).toBe('2026-11-07');
  });

  test('transactions in the future are not part of today', () => {
    const points = buildHistory(new Map([d('2026-01-01', 100), d('2026-12-01', 900)]), '3m', now);
    expect(points[points.length - 1]).toEqual({ date: '2026-11-07', balance: 100 });
  });

  test('sampleDates includes the start and today', () => {
    const dates = sampleDates(new Date(2026, 7, 7), new Date(2026, 10, 7));
    expect(dates[0]).toBe('2026-08-07');
    expect(dates[dates.length - 1]).toBe('2026-11-07');
  });
});
