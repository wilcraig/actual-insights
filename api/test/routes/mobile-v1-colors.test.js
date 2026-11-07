const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-colors-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/mobile/v1/reports', () => ({ buildReports: jest.fn(), buildReportList: jest.fn() }));

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const tokens = require('../../src/mobile-tokens-store');
const colorsStore = require('../../src/mobile-colors-store');
const hiddenStore = require('../../src/mobile-hidden-accounts-store');
const { expectValid, isValid, examples, makeFakeActual } = require('../helpers/native-v1');

const AUDIT = path.join(DATA_DIR, 'mobile-audit.log');
const COLORS_FILE = path.join(DATA_DIR, colorsStore.FILE_NAME);
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

beforeEach(async () => {
  for (const t of await tokens.listTokens(DATA_DIR)) await tokens.revokeToken(t.id, DATA_DIR);
  fs.rmSync(AUDIT, { force: true });
  fs.rmSync(COLORS_FILE, { force: true });
  fs.rmSync(path.join(DATA_DIR, hiddenStore.FILE_NAME), { force: true });
  validateToken.mockReset();
  validateToken.mockResolvedValue(false);
  client = makeFakeActual();
  getActualClient.mockReset();
  getActualClient.mockImplementation(async () => client);
  syncIfDue.mockReset();
  syncIfDue.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

test('the contract examples for colours validate, and drift is rejected', () => {
  expectValid('colorsResponse', examples.colorsResponse);
  expectValid('categoryItem', { id: 'c1', name: 'X', color: 'red' });
  expect(isValid('colorSetRequest', { color: null })).toBe(true);
  expect(isValid('colorSetRequest', { color: 'red' })).toBe(true);
  expect(isValid('colorSetRequest', { color: 'magenta' })).toBe(false);
  expect(isValid('colorSetRequest', {})).toBe(false);
  expect(isValid('colorSetRequest', { color: 'red', extra: 1 })).toBe(false);
});

describe('GET /colors', () => {
  test('requires a token; a read token is enough', async () => {
    await withServer(async (base) => {
      expect((await get(base, null, '/colors')).status).toBe(401);
      const { token } = await newToken('read');
      expect((await get(base, token, '/colors')).status).toBe(200);
      expect((await get(base, token, '/colors?x=1')).status).toBe(400);
    });
  });

  test('visible groups and categories in Actual order, defaults by position, explicit flag', async () => {
    fs.writeFileSync(COLORS_FILE, JSON.stringify({ groups: { 'g-empty': 'orange' }, categories: { 'c-fuel': 'pink', 'c-hid': 'red' } }));
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/colors'), 'colorsResponse');
      expect(body.groups).toEqual([
        { id: 'g-usual', name: 'Usual Expenses', color: 'blue', explicit: false },
        { id: 'g-empty', name: 'Nothing here', color: 'orange', explicit: true },
        { id: 'g-income', name: 'Income', color: 'green', explicit: false },
      ]);
      expect(body.categories).toEqual([
        { id: 'c-groc', name: 'Groceries', groupId: 'g-usual', color: 'blue', explicit: false },
        { id: 'c-fuel', name: 'Fuel', groupId: 'g-usual', color: 'pink', explicit: true },
        { id: 'c-pay', name: 'Paycheck', groupId: 'g-income', color: 'green', explicit: false },
      ]);
    });
  });

  test('a corrupt colours file means defaults, never an error', async () => {
    fs.writeFileSync(COLORS_FILE, '{broken');
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/colors'), 'colorsResponse');
      expect(body.groups.every((g) => !g.explicit)).toBe(true);
    });
  });
});

describe('PUT /colors/...', () => {
  test('a read token is refused (403), no token is 401, and nothing is written', async () => {
    await withServer(async (base) => {
      const { token } = await newToken('read');
      const res = await put(base, token, '/colors/groups/g-usual', { color: 'red' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'read_only' });
      expect((await put(base, null, '/colors/groups/g-usual', { color: 'red' })).status).toBe(401);
      expect(fs.existsSync(COLORS_FILE)).toBe(false);
      expect(auditLines()).toEqual([]);
    });
  });

  test('sets a group colour, answers okResponse, audits (never the token), and the next read shows it', async () => {
    const { token, id } = await newToken('write');
    await withServer(async (base) => {
      // Warm the read cache first: only a cache clear can make the next read fresh.
      expect((await json(await get(base, token, '/colors'))).groups[0]).toMatchObject({ color: 'blue', explicit: false });
      const res = await put(base, token, '/colors/groups/g-usual', { color: 'purple' });
      expect(res.status).toBe(200);
      expect(await json(res, 'okResponse')).toEqual({ schema: 1, ok: true });
      expect((await json(await get(base, token, '/colors'), 'colorsResponse')).groups[0]).toMatchObject({ color: 'purple', explicit: true });
      expect(await colorsStore.readColors(DATA_DIR)).toEqual({ groups: { 'g-usual': 'purple' }, categories: {} });
      const lines = auditLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ tokenId: id, op: 'colors.set', ids: { group: 'g-usual' }, before: { color: null }, after: { color: 'purple' } });
      expect(fs.readFileSync(AUDIT, 'utf8')).not.toContain(token);
    });
  });

  test('sets a category colour; null removes it (audit records the old key)', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      expect((await put(base, token, '/colors/categories/c-fuel', { color: 'pink' })).status).toBe(200);
      let body = await json(await get(base, token, '/colors'), 'colorsResponse');
      expect(body.categories.find((c) => c.id === 'c-fuel')).toMatchObject({ color: 'pink', explicit: true });
      expect(body.categories.find((c) => c.id === 'c-groc')).toMatchObject({ color: 'blue', explicit: false });
      expect((await put(base, token, '/colors/categories/c-fuel', { color: null })).status).toBe(200);
      body = await json(await get(base, token, '/colors'), 'colorsResponse');
      expect(body.categories.find((c) => c.id === 'c-fuel')).toMatchObject({ color: 'blue', explicit: false });
      expect(auditLines().map((l) => [l.ids, l.before, l.after])).toEqual([
        [{ category: 'c-fuel' }, { color: null }, { color: 'pink' }],
        [{ category: 'c-fuel' }, { color: 'pink' }, { color: null }],
      ]);
    });
  });

  test('strict body and ids: 400 for anything else, 404 for unknown or hidden targets, nothing written', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const bad = [
        ['/colors/groups/g-usual', {}],
        ['/colors/groups/g-usual', { color: 'magenta' }],
        ['/colors/groups/g-usual', { color: 5 }],
        ['/colors/groups/g-usual', { color: 'red', extra: true }],
        ['/colors/groups/g-usual', { colour: 'red' }],
        ['/colors/groups/g-usual', ['red']],
        ['/colors/groups/g-usual', 'null'],
        ['/colors/groups/g-usual', '{bad json'],
        ['/colors/groups/bad%20id', { color: 'red' }],
      ];
      for (const [url, body] of bad) expect([url, (await put(base, token, url, body)).status]).toEqual([url, 400]);
      for (const url of ['/colors/groups/nope', '/colors/categories/nope', '/colors/groups/g-gone', '/colors/categories/c-hid', '/colors/categories/c-gone', '/colors/groups/c-groc', '/colors/categories/g-usual']) {
        const res = await put(base, token, url, { color: 'red' });
        expect([url, res.status, await res.json()]).toEqual([url, 404, { error: 'not_found' }]);
      }
      expect(fs.existsSync(COLORS_FILE)).toBe(false);
      expect(auditLines()).toEqual([]);
    });
  });
});

describe('effective colours in every response', () => {
  async function withColors(fn) {
    // Groceries pink (explicit); Usual Expenses stays blue by position; Income explicit red.
    fs.writeFileSync(COLORS_FILE, JSON.stringify({ groups: { 'g-income': 'red' }, categories: { 'c-groc': 'pink' } }));
    const { token } = await newToken('write');
    return withServer((base) => fn(base, token));
  }

  test('transactions: the category colour, null when uncategorized, null for split parents', async () => {
    await withColors(async (base, token) => {
      const body = await json(await get(base, token, '/transactions?limit=100'), 'transactionsResponse');
      const byId = Object.fromEntries(body.transactions.map((t) => [t.id, t]));
      expect(byId['t-01'].color).toBe('pink');
      expect(byId['t-11'].color).toBe('blue'); // Fuel inherits its group
      expect(byId['t-02'].color).toBeNull(); // uncategorized
      expect(byId['t-05'].split).toBe(true);
      expect(byId['t-05'].color).toBeNull();
      expect(body.transactions.every((t) => t.color === null || typeof t.color === 'string')).toBe(true);
    });
  });

  test('a split parent stays null even if its stored category is still set', async () => {
    client.state.transactions.find((t) => t.id === 't-05').category = 'c-groc';
    await withColors(async (base, token) => {
      const row = (await json(await get(base, token, '/transactions?limit=100'), 'transactionsResponse')).transactions.find((t) => t.id === 't-05');
      expect(row.color).toBeNull();
    });
  });

  test('transaction detail', async () => {
    await withColors(async (base, token) => {
      expect((await json(await get(base, token, '/transactions/t-01'), 'transactionDetailResponse')).transaction.color).toBe('pink');
      expect((await json(await get(base, token, '/transactions/t-11'), 'transactionDetailResponse')).transaction.color).toBe('blue');
      expect((await json(await get(base, token, '/transactions/t-02'), 'transactionDetailResponse')).transaction.color).toBeNull();
      expect((await json(await get(base, token, '/transactions/t-05'), 'transactionDetailResponse')).transaction.color).toBeNull();
    });
  });

  test('categories', async () => {
    await withColors(async (base, token) => {
      const body = await json(await get(base, token, '/categories'), 'categoriesResponse');
      expect(body.groups.map((g) => g.color)).toEqual(['blue', 'teal', 'red']);
      expect(body.groups[0].categories).toEqual([
        { id: 'c-groc', name: 'Groceries', color: 'pink' },
        { id: 'c-fuel', name: 'Fuel', color: 'blue' },
      ]);
      expect(body.groups[2].categories).toEqual([{ id: 'c-pay', name: 'Paycheck', color: 'red' }]);
    });
  });

  test('budget month, and the budget writes', async () => {
    await withColors(async (base, token) => {
      const body = await json(await get(base, token, '/budget/2026-11'), 'budgetMonthResponse');
      expect(body.groups[0].color).toBe('blue');
      expect(body.groups[0].categories.map((c) => c.color)).toEqual(['pink', 'blue']);
      const set = await json(await put(base, token, '/budget/2026-11/categories/c-groc', { budgeted: 47500 }), 'budgetChangeResponse');
      expect(set.categories[0].color).toBe('pink');
      const moved = await json(await call(base, token, 'POST', '/budget/2026-11/move', { from: 'c-fuel', to: 'c-groc', amount: 100 }), 'budgetChangeResponse');
      expect(moved.categories.map((c) => c.color)).toEqual(['blue', 'pink']);
    });
  });

  test('a colour change shows up in every read (the cache is cleared by the PUT)', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const colorOfTx = async () => (await json(await get(base, token, '/transactions?limit=100'))).transactions.find((t) => t.id === 't-01').color;
      expect(await colorOfTx()).toBe('blue');
      await put(base, token, '/colors/categories/c-groc', { color: 'lime' });
      expect(await colorOfTx()).toBe('lime');
      await put(base, token, '/colors/categories/c-groc', { color: null });
      await put(base, token, '/colors/groups/g-usual', { color: 'brown' });
      expect(await colorOfTx()).toBe('brown');
    });
  });

  test('a hidden account does not change any colour', async () => {
    await hiddenStore.writeHiddenIds(['a-sav'], DATA_DIR);
    await withColors(async (base, token) => {
      const body = await json(await get(base, token, '/transactions?limit=100'), 'transactionsResponse');
      expect(body.transactions.find((t) => t.id === 't-01').color).toBe('pink');
    });
  });
});
