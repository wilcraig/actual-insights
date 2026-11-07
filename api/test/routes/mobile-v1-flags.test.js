const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-flags-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const store = require('../../src/mobile-tokens-store');
const flagStore = require('../../src/mobile-transaction-flags-store');
const { expectValid, examples, makeFakeActual } = require('../helpers/native-v1');

const NOW = new Date(2026, 10, 12, 15, 0, 0);
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
const call = (base, token, method, url, body, extra = {}) =>
  fetch(`${base}/api/mobile/v1${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const patch = (base, token, id, body) => call(base, token, 'PATCH', `/transactions/${id}`, body);
const get = (base, token, url) => call(base, token, 'GET', url);
async function json(res, definition) {
  const body = await res.json();
  if (definition) expectValid(definition, body);
  return body;
}
const auditLines = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const flagsOf = async (id) => flagStore.getFlags(id, DATA_DIR);
let writeToken;
let readToken;

beforeEach(async () => {
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  fs.rmSync(AUDIT, { force: true });
  fs.rmSync(path.join(DATA_DIR, flagStore.FILE_NAME), { force: true });
  writeToken = (await store.createToken('w', DATA_DIR, { scope: 'write' })).token;
  readToken = (await store.createToken('r', DATA_DIR, { scope: 'read' })).token;
  validateToken.mockReset();
  validateToken.mockResolvedValue(false);
  client = makeFakeActual();
  getActualClient.mockReset();
  getActualClient.mockImplementation(async () => client);
  syncIfDue.mockReset();
  syncIfDue.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });
});
afterEach(() => {
  console.error.mockRestore();
  jest.useRealTimers();
});

describe('the contract examples', () => {
  test('the new request and response examples validate', () => {
    for (const [name, def] of [
      ['transactionDetailResponse', 'transactionDetailResponse'],
      ['transactionsResponse', 'transactionsResponse'],
      ['transactionUpdateRequest', 'transactionUpdateRequest'],
    ]) expectValid(def, examples[name]);
    for (const key of Object.keys(examples)) {
      if (/^(categoryGroupCreat|categoryCreat)/.test(key)) expectValid(key, examples[key]);
    }
  });
});

describe('PATCH excluded / hidden', () => {
  test('flag-only: no Actual call, no sync, effective flags in the detail, one audit line with before and after', async () => {
    await withServer(async (base) => {
      const res = await patch(base, writeToken, 't-01', { excluded: true });
      expect(res.status).toBe(200);
      const body = await json(res, 'transactionDetailResponse');
      expect(body.transaction).toMatchObject({ id: 't-01', excluded: true, hidden: false });
      expect(client.updateTransaction).not.toHaveBeenCalled();
      expect(client.sync).not.toHaveBeenCalled();
      expect(await flagsOf('t-01')).toEqual({ excluded: true, hidden: false });
      expect(auditLines()).toEqual([expect.objectContaining({ op: 'transaction.update', ids: { transaction: 't-01' }, before: { excluded: false, hidden: false }, after: { excluded: true, hidden: false } })]);
    });
  });

  test('every combination follows the rules', async () => {
    // [existing flags, body, expected status, expected flags]
    const E = { excluded: true, hidden: false };
    const H = { excluded: true, hidden: true };
    const N = { excluded: false, hidden: false };
    const cases = [
      [N, { excluded: true }, 200, E],
      [N, { excluded: false }, 200, N],
      [N, { hidden: true }, 200, H],
      [N, { hidden: false }, 200, N],
      [N, { excluded: true, hidden: true }, 200, H],
      [N, { excluded: false, hidden: true }, 400, N],
      [N, { excluded: true, hidden: false }, 200, E],
      [N, { excluded: false, hidden: false }, 200, N],
      [E, { excluded: false }, 200, N],
      [E, { hidden: true }, 200, H],
      [E, { hidden: false }, 200, E],
      [E, { excluded: false, hidden: true }, 400, E],
      [H, { excluded: false }, 400, H],
      [H, { excluded: true }, 200, H],
      [H, { hidden: false }, 200, E], // hidden false leaves excluded as it was
      [H, { hidden: true }, 200, H],
      [H, { excluded: false, hidden: false }, 200, N],
      [H, { excluded: true, hidden: false }, 200, E],
      [H, { excluded: false, hidden: true }, 400, H],
    ];
    await withServer(async (base) => {
      for (const [start, body, status, want] of cases) {
        await flagStore.setFlags('t-01', start, DATA_DIR);
        const res = await patch(base, writeToken, 't-01', body);
        const label = `${JSON.stringify(start)} + ${JSON.stringify(body)}`;
        expect([label, res.status]).toEqual([label, status]);
        if (status === 200) expect(await json(res, 'transactionDetailResponse')).toMatchObject({ transaction: want });
        else expect(await json(res, 'error')).toEqual({ error: 'bad_request' });
        expect([label, await flagsOf('t-01')]).toEqual([label, want]);
      }
      expect(client.updateTransaction).not.toHaveBeenCalled();
    });
  });

  test('a no-change flag PATCH writes nothing and audits nothing', async () => {
    await flagStore.setFlags('t-01', { excluded: true, hidden: false }, DATA_DIR);
    await withServer(async (base) => {
      expect((await patch(base, writeToken, 't-01', { excluded: true })).status).toBe(200);
      expect(auditLines()).toEqual([]);
    });
  });

  test('strict: non-boolean flags, unknown keys, empty body, unknown transaction, read token', async () => {
    await withServer(async (base) => {
      for (const body of [{ excluded: 'yes' }, { hidden: 1 }, { excluded: null }, { hidden: null }, { excluded: true, extra: 1 }, {}]) {
        expect([JSON.stringify(body), (await patch(base, writeToken, 't-01', body)).status]).toEqual([JSON.stringify(body), 400]);
      }
      expect((await patch(base, writeToken, 'nope', { excluded: true })).status).toBe(404);
      expect((await patch(base, readToken, 't-01', { excluded: true })).status).toBe(403);
      expect(await flagsOf('t-01')).toEqual({ excluded: false, hidden: false });
    });
  });

  test('the POST override carries the flags too', async () => {
    await withServer(async (base) => {
      const res = await call(base, writeToken, 'POST', '/transactions/t-01', { hidden: true }, { 'X-HTTP-Method-Override': 'PATCH' });
      expect(await json(res, 'transactionDetailResponse')).toMatchObject({ transaction: { excluded: true, hidden: true } });
    });
  });

  test('mixed PATCH: one updateTransaction for the Actual fields, flags written after it succeeded', async () => {
    const order = [];
    const realUpdate = client.updateTransaction.getMockImplementation();
    client.updateTransaction.mockImplementation(async (...args) => {
      order.push(['actual', await flagsOf('t-01')]);
      return realUpdate(...args);
    });
    await withServer(async (base) => {
      const res = await patch(base, writeToken, 't-01', { notes: 'new note', cleared: false, excluded: true });
      const body = await json(res, 'transactionDetailResponse');
      expect(body.transaction).toMatchObject({ notes: 'new note', cleared: false, excluded: true, hidden: false });
      expect(client.updateTransaction).toHaveBeenCalledTimes(1);
      expect(client.updateTransaction).toHaveBeenCalledWith('t-01', { notes: 'new note', cleared: false });
      // when the Actual write ran, the flag was not yet there
      expect(order).toEqual([['actual', { excluded: false, hidden: false }]]);
      expect(client.sync).toHaveBeenCalledTimes(1);
      expect(auditLines().map((l) => l.op)).toEqual(['transaction.update', 'transaction.update']);
      expect(auditLines()[1]).toMatchObject({ before: { excluded: false, hidden: false }, after: { excluded: true, hidden: false } });
    });
  });

  test('a failed Actual write leaves the flags alone; a bad category is rejected before anything is written', async () => {
    client.updateTransaction.mockRejectedValueOnce(new Error('boom'));
    await withServer(async (base) => {
      expect((await patch(base, writeToken, 't-01', { notes: 'x', excluded: true })).status).toBe(500);
      expect(await flagsOf('t-01')).toEqual({ excluded: false, hidden: false });
      expect((await patch(base, writeToken, 't-01', { category: 'c-nope', excluded: true })).status).toBe(404);
      expect(await flagsOf('t-01')).toEqual({ excluded: false, hidden: false });
      // a contradictory flag pair in a mixed PATCH writes nothing at all
      client.updateTransaction.mockClear();
      expect((await patch(base, writeToken, 't-01', { notes: 'y', excluded: false, hidden: true })).status).toBe(400);
      expect(client.updateTransaction).not.toHaveBeenCalled();
    });
  });

  test('split parents and transfers can be flagged', async () => {
    await withServer(async (base) => {
      expect(await json(await patch(base, writeToken, 't-05', { excluded: true }), 'transactionDetailResponse')).toMatchObject({ transaction: { split: true, excluded: true } });
      expect(await json(await patch(base, writeToken, 't-04', { hidden: true }), 'transactionDetailResponse')).toMatchObject({ transaction: { transfer: true, hidden: true, excluded: true } });
    });
  });
});

describe('reads carry the flags', () => {
  test('rows and detail say excluded and hidden; split parents carry their own flags', async () => {
    await flagStore.setFlags('t-01', { excluded: true, hidden: false }, DATA_DIR);
    await flagStore.setFlags('t-05', { excluded: true, hidden: false }, DATA_DIR);
    await withServer(async (base) => {
      const list = await json(await get(base, readToken, '/transactions?limit=100'), 'transactionsResponse');
      const by = Object.fromEntries(list.transactions.map((t) => [t.id, t]));
      expect(by['t-01']).toMatchObject({ excluded: true, hidden: false });
      expect(by['t-05']).toMatchObject({ excluded: true, hidden: false, split: true });
      expect(by['t-10']).toMatchObject({ excluded: false, hidden: false });
      expect(list.transactions.every((t) => typeof t.excluded === 'boolean' && typeof t.hidden === 'boolean')).toBe(true);
      expect((await json(await get(base, readToken, '/transactions/t-01'), 'transactionDetailResponse')).transaction).toMatchObject({ excluded: true, hidden: false });
      expect((await json(await get(base, readToken, '/transactions/t-05'), 'transactionDetailResponse')).transaction).toMatchObject({ excluded: true, split: true });
    });
  });

  test('hidden transactions drop out of the list unless showHidden=1; excluded ones always appear', async () => {
    await flagStore.setFlags('t-01', { excluded: true, hidden: false }, DATA_DIR);
    await flagStore.setFlags('t-10', { excluded: true, hidden: true }, DATA_DIR);
    await withServer(async (base) => {
      const ids = async (url) => (await json(await get(base, readToken, url), 'transactionsResponse')).transactions.map((t) => t.id);
      const plain = await ids('/transactions?limit=100');
      expect(plain).toContain('t-01');
      expect(plain).not.toContain('t-10');
      const all = await ids('/transactions?limit=100&showHidden=1');
      expect(all).toContain('t-10');
      expect((await json(await get(base, readToken, '/transactions?limit=100&showHidden=1'), 'transactionsResponse')).transactions.find((t) => t.id === 't-10')).toMatchObject({ hidden: true, excluded: true });
      // pagination stays stable with hidden rows left out
      const first = await json(await get(base, readToken, '/transactions?limit=3'), 'transactionsResponse');
      expect(first.transactions).toHaveLength(3);
      expect(first.transactions.map((t) => t.id)).not.toContain('t-10');
      // hidden rows are still addressable by id
      expect((await get(base, readToken, '/transactions/t-10')).status).toBe(200);
      // only the value 1 turns it on
      for (const bad of ['0', 'true', 'yes', '2', '']) expect([bad, (await get(base, readToken, `/transactions?showHidden=${bad}`)).status]).toEqual([bad, 400]);
    });
  });

  test('showHidden has its own cache entry', async () => {
    await flagStore.setFlags('t-10', { excluded: true, hidden: true }, DATA_DIR);
    await withServer(async (base) => {
      const a = (await json(await get(base, readToken, '/transactions?limit=100'), 'transactionsResponse')).transactions.length;
      const b = (await json(await get(base, readToken, '/transactions?limit=100&showHidden=1'), 'transactionsResponse')).transactions.length;
      expect(b).toBe(a + 1);
    });
  });

  test('the uncategorized view and count skip excluded and hidden transactions (showHidden does not bring them back)', async () => {
    await withServer(async (base) => {
      const view = async (extra = '') => json(await get(base, readToken, `/transactions?uncategorized=1&limit=100${extra}`), 'transactionsResponse');
      const start = await view();
      const startIds = start.transactions.map((t) => t.id);
      expect(startIds).toEqual(expect.arrayContaining(['t-02', 't-03', 't-09']));
      expect(start.uncategorizedCount).toBe(startIds.length);

      await flagStore.setFlags('t-02', { excluded: true, hidden: false }, DATA_DIR);
      await flagStore.setFlags('t-03', { excluded: true, hidden: true }, DATA_DIR);
      require('../../src/routes/mobile-v1').clearMobileV1Cache();
      const after = await view();
      expect(after.transactions.map((t) => t.id)).toEqual(startIds.filter((id) => id !== 't-02' && id !== 't-03'));
      expect(after.uncategorizedCount).toBe(startIds.length - 2);
      expect((await view('&showHidden=1')).uncategorizedCount).toBe(startIds.length - 2);
      expect((await view('&showHidden=1')).transactions.map((t) => t.id)).not.toContain('t-03');
      // the count on the plain list is the same number
      const plain = await json(await get(base, readToken, '/transactions?limit=100'), 'transactionsResponse');
      expect(plain.uncategorizedCount).toBe(startIds.length - 2);
    });
  });

  test('flagging through PATCH is visible at once (the read cache is cleared)', async () => {
    await withServer(async (base) => {
      const before = await json(await get(base, readToken, '/budget/2026-11'), 'budgetMonthResponse');
      await patch(base, writeToken, 't-01', { excluded: true });
      const after = await json(await get(base, readToken, '/budget/2026-11'), 'budgetMonthResponse');
      expect(after.groups[0].categories[0].spent).toBe(before.groups[0].categories[0].spent + 8423);
    });
  });
});

describe('/budget/<month> adjustments', () => {
  const groc = (body) => body.groups.find((g) => g.id === 'g-usual').categories.find((c) => c.id === 'c-groc');
  test('spent and balance add back the excluded amounts of that month; group sums and totals follow', async () => {
    await withServer(async (base) => {
      const plain = await json(await get(base, readToken, '/budget/2026-11'), 'budgetMonthResponse');
      await flagStore.setFlags('t-01', { excluded: true, hidden: false }, DATA_DIR); // c-groc -8423 on 2026-11-11
      await flagStore.setFlags('t-11', { excluded: true, hidden: true }, DATA_DIR); // c-fuel -1500 on 2026-11-05
      require('../../src/routes/mobile-v1').clearMobileV1Cache();
      const body = await json(await get(base, readToken, '/budget/2026-11'), 'budgetMonthResponse');
      expect(groc(body)).toMatchObject({ spent: groc(plain).spent + 8423, balance: groc(plain).balance + 8423, budgeted: groc(plain).budgeted });
      const fuel = body.groups[0].categories.find((c) => c.id === 'c-fuel');
      expect(fuel.spent).toBe(plain.groups[0].categories.find((c) => c.id === 'c-fuel').spent + 1500);
      const g = body.groups[0];
      expect(g.spent).toBe(g.categories.reduce((s, c) => s + c.spent, 0));
      expect(g.balance).toBe(g.categories.reduce((s, c) => s + c.balance, 0));
      expect(body.totals.spent).toBe(plain.totals.spent + 8423 + 1500);
      expect(body.totals.balance).toBe(plain.totals.balance + 8423 + 1500);
      expect(body.totals.budgeted).toBe(plain.totals.budgeted);
      expect(body.totals.income).toBe(plain.totals.income);
    });
  });

  test('an excluded transaction in another month changes nothing; a split parent adds back its lines by their categories', async () => {
    await withServer(async (base) => {
      const dec = await json(await get(base, readToken, '/budget/2026-12'), 'budgetMonthResponse');
      const plain = await json(await get(base, readToken, '/budget/2026-11'), 'budgetMonthResponse');
      await flagStore.setFlags('t-01', { excluded: true, hidden: false }, DATA_DIR);
      require('../../src/routes/mobile-v1').clearMobileV1Cache();
      expect(await json(await get(base, readToken, '/budget/2026-12'), 'budgetMonthResponse')).toEqual({ ...dec, generatedAt: expect.any(String) });
      // t-05: parent -5000 flagged; its c-groc line (-2500) counts, the uncategorized line does not
      await flagStore.setFlags('t-01', { excluded: false, hidden: false }, DATA_DIR);
      await flagStore.setFlags('t-05', { excluded: true, hidden: false }, DATA_DIR);
      require('../../src/routes/mobile-v1').clearMobileV1Cache();
      const split = await json(await get(base, readToken, '/budget/2026-11'), 'budgetMonthResponse');
      expect(groc(split).spent).toBe(groc(plain).spent + 2500);
      expect(split.totals.spent).toBe(plain.totals.spent + 2500);
    });
  });

  test('flags on transactions that no longer exist, and income categories, change nothing', async () => {
    await flagStore.setFlags('long-gone', { excluded: true, hidden: false }, DATA_DIR);
    await withServer(async (base) => {
      const a = await json(await get(base, readToken, '/budget/2026-11'), 'budgetMonthResponse');
      expect(groc(a).spent).toBe(-9500);
    });
  });

  test('the budget write answers use the adjusted figures too', async () => {
    await flagStore.setFlags('t-01', { excluded: true, hidden: false }, DATA_DIR);
    await withServer(async (base) => {
      const res = await call(base, writeToken, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 50000 });
      const body = await json(res, 'budgetChangeResponse');
      expect(body.categories[0]).toMatchObject({ id: 'c-groc', spent: -9500 + 8423, balance: 50000 - 9500 + 8423 });
      expect(body.totals.spent).toBe(-9500 - 2800 + 8423);
    });
  });
});

describe('POST /category-groups', () => {
  const post = (base, token, url, body) => call(base, token, 'POST', url, body);
  beforeEach(() => {
    let n = 0;
    client.createCategoryGroup = jest.fn(async (group) => {
      n += 1;
      const id = `g-new${n}`;
      client.state.groups.push({ id, name: group.name, is_income: Boolean(group.is_income), hidden: false, categories: [] });
      client.state.calls.push(['createCategoryGroup', group]);
      return id;
    });
    client.createCategory = jest.fn(async (category) => {
      n += 1;
      const id = `c-new${n}`;
      client.state.groups.find((g) => g.id === category.group_id).categories.push({ id, name: category.name, is_income: false, hidden: false });
      client.state.calls.push(['createCategory', category]);
      return id;
    });
  });

  test('creates an expense group: trimmed name, colour from the helper, no categories, audited, synced, cache cleared', async () => {
    await withServer(async (base) => {
      const before = await json(await get(base, readToken, '/categories'), 'categoriesResponse');
      const res = await post(base, writeToken, '/category-groups', { name: '  Pets  ' });
      expect(res.status).toBe(200);
      const body = await json(res, 'categoryGroupCreatedResponse');
      expect(body.group).toMatchObject({ id: 'g-new1', name: 'Pets', isIncome: false, categories: [] });
      expect(typeof body.group.color).toBe('string');
      expect(client.createCategoryGroup).toHaveBeenCalledWith({ name: 'Pets', is_income: false });
      expect(client.sync).toHaveBeenCalledTimes(1);
      expect(auditLines()).toEqual([expect.objectContaining({ op: 'category-group.create', ids: { group: 'g-new1' }, after: { name: 'Pets' } })]);
      const after = await json(await get(base, readToken, '/categories'), 'categoriesResponse');
      expect(after.groups).toHaveLength(before.groups.length + 1);
    });
  });

  test('validation: empty or whitespace names, too long, wrong types, extra keys, read-only, duplicates (any case, visible groups only)', async () => {
    await withServer(async (base) => {
      for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 5 }, { name: null }, { name: 'ok', extra: 1 }, []]) {
        expect([JSON.stringify(body), (await post(base, writeToken, '/category-groups', body)).status]).toEqual([JSON.stringify(body), 400]);
      }
      expect((await post(base, writeToken, '/category-groups', { name: 'x'.repeat(200) })).status).toBe(200);
      expect((await post(base, readToken, '/category-groups', { name: 'Nope' })).status).toBe(403);
      const dup = await post(base, writeToken, '/category-groups', { name: ' usual EXPENSES ' });
      expect(dup.status).toBe(409);
      expect(await json(dup, 'error')).toEqual({ error: 'conflict' });
      // a hidden group's name is free
      expect((await post(base, writeToken, '/category-groups', { name: 'Retired group' })).status).toBe(200);
      expect(client.createCategoryGroup).toHaveBeenCalledTimes(2);
    });
  });
});

describe('POST /categories', () => {
  const post = (base, token, body) => call(base, token, 'POST', '/categories', body);
  beforeEach(() => {
    let n = 0;
    client.createCategory = jest.fn(async (category) => {
      n += 1;
      const id = `c-new${n}`;
      client.state.groups.find((g) => g.id === category.group_id).categories.push({ id, name: category.name, is_income: false, hidden: false });
      return id;
    });
  });

  test('creates a category with the group colour, and sets the budgeted amount for the CURRENT month only, with one sync', async () => {
    await withServer(async (base) => {
      const res = await post(base, writeToken, { groupId: 'g-usual', name: ' Pet food ', budgeted: 12000 });
      expect(res.status).toBe(200);
      const body = await json(res, 'categoryCreatedResponse');
      expect(body).toMatchObject({ groupId: 'g-usual', category: { id: 'c-new1', name: 'Pet food' } });
      expect(client.createCategory).toHaveBeenCalledWith({ name: 'Pet food', group_id: 'g-usual' });
      expect(client.state.calls.filter((c) => c[0] === 'setBudgetAmount')).toEqual([['setBudgetAmount', '2026-11', 'c-new1', 12000]]);
      expect(client.sync).toHaveBeenCalledTimes(1);
      expect(auditLines().map((l) => l.op)).toEqual(['category.create', 'budget.set']);
      // the colour is what GET /categories says
      const cats = await json(await get(base, readToken, '/categories'), 'categoriesResponse');
      expect(cats.groups.find((g) => g.id === 'g-usual').categories.find((c) => c.id === 'c-new1').color).toBe(body.category.color);
    });
  });

  test('without budgeted no budget call is made; budgeted 0 is written', async () => {
    await withServer(async (base) => {
      await json(await post(base, writeToken, { groupId: 'g-usual', name: 'A' }), 'categoryCreatedResponse');
      expect(client.setBudgetAmount).not.toHaveBeenCalled();
      await json(await post(base, writeToken, { groupId: 'g-usual', name: 'B', budgeted: 0 }), 'categoryCreatedResponse');
      expect(client.setBudgetAmount).toHaveBeenCalledWith('2026-11', 'c-new2', 0);
    });
  });

  test('validation: bad shapes 400, unknown group 404, hidden or income group 400, duplicate name in the group 409 (hidden categories count)', async () => {
    await withServer(async (base) => {
      const bad = [{}, { groupId: 'g-usual' }, { name: 'x' }, { groupId: 'g-usual', name: '   ' }, { groupId: 'g-usual', name: 'x'.repeat(201) }, { groupId: 7, name: 'x' }, { groupId: 'bad id!', name: 'x' }, { groupId: 'g-usual', name: 'x', budgeted: -1 }, { groupId: 'g-usual', name: 'x', budgeted: 1.5 }, { groupId: 'g-usual', name: 'x', budgeted: '5' }, { groupId: 'g-usual', name: 'x', budgeted: 1000000000001 }, { groupId: 'g-usual', name: 'x', extra: true }];
      for (const body of bad) expect([JSON.stringify(body), (await post(base, writeToken, body)).status]).toEqual([JSON.stringify(body), 400]);
      expect((await post(base, writeToken, { groupId: 'g-nope', name: 'x' })).status).toBe(404);
      expect((await post(base, writeToken, { groupId: 'g-gone', name: 'x' })).status).toBe(400);
      expect((await post(base, writeToken, { groupId: 'g-income', name: 'x' })).status).toBe(400);
      expect((await post(base, readToken, { groupId: 'g-usual', name: 'x' })).status).toBe(403);
      const dup = await post(base, writeToken, { groupId: 'g-usual', name: ' groceries ' });
      expect(dup.status).toBe(409);
      expect(await json(dup, 'error')).toEqual({ error: 'conflict' });
      expect((await post(base, writeToken, { groupId: 'g-usual', name: 'Old hobby' })).status).toBe(409);
      expect(client.createCategory).not.toHaveBeenCalled();
      expect(client.setBudgetAmount).not.toHaveBeenCalled();
      // the same name in another group is fine
      expect((await post(base, writeToken, { groupId: 'g-empty', name: 'Groceries' })).status).toBe(200);
    });
  });

  test('long names are clipped to 80 characters in the audit log', async () => {
    await withServer(async (base) => {
      await post(base, writeToken, { groupId: 'g-usual', name: 'n'.repeat(150) });
      expect(auditLines()[0].after.name).toHaveLength(80);
    });
  });
});
