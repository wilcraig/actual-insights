const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-acctgroup-w-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const store = require('../../src/mobile-tokens-store');
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
const get = (base, token, url) => call(base, token, 'GET', url);
async function json(res, definition) {
  const body = await res.json();
  if (definition) expectValid(definition, body);
  return body;
}
const auditLines = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
let writeToken;
let readToken;

beforeEach(async () => {
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  fs.rmSync(AUDIT, { force: true });
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


function installGroupClient() {
  let n = 0;
  client.state.accountGroups.push({ id: 'ag-1', name: 'Cards' });
  client.createAccountGroup = jest.fn(async (group) => {
    n += 1;
    client.state.accountGroups.push({ id: `ag-new${n}`, name: group.name });
    return `ag-new${n}`;
  });
  client.updateAccountGroup = jest.fn(async (id, fields) => {
    Object.assign(client.state.accountGroups.find((g) => g.id === id), fields);
  });
  client.deleteAccountGroup = jest.fn(async (id) => {
    client.state.accountGroups = client.state.accountGroups.filter((g) => g.id !== id);
    for (const a of client.state.accounts) if (a.account_group_id === id) a.account_group_id = null;
  });
  client.updateAccount = jest.fn(async (id, fields) => {
    Object.assign(client.state.accounts.find((a) => a.id === id), fields);
  });
}

describe('account group writes', () => {
  beforeEach(installGroupClient);

  test('the contract examples validate', () => {
    expectValid('accountGroupCreateRequest', examples.accountGroupCreateRequest);
    expectValid('accountGroupCreatedResponse', examples.accountGroupCreatedResponse);
    expectValid('accountGroupAssignRequest', examples.accountGroupAssignRequest);
  });

  test('POST creates a group: trimmed name, audited, synced, listed by /accounts once it has a member', async () => {
    await withServer(async (base) => {
      const res = await call(base, writeToken, 'POST', '/account-groups', { name: '  Savings  ' });
      expect(res.status).toBe(200);
      expect((await json(res, 'accountGroupCreatedResponse')).group).toEqual({ id: 'ag-new1', name: 'Savings' });
      expect(client.createAccountGroup).toHaveBeenCalledWith({ name: 'Savings' });
      expect(client.sync).toHaveBeenCalledTimes(1);
      expect(auditLines()).toEqual([expect.objectContaining({ op: 'account-group.create', ids: { group: 'ag-new1' }, after: { name: 'Savings' } })]);
    });
  });

  test('POST validation: bad bodies 400, read scope 403, duplicate (any case) 409', async () => {
    await withServer(async (base) => {
      for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 5 }, { name: 'ok', extra: 1 }, []]) {
        expect([JSON.stringify(body), (await call(base, writeToken, 'POST', '/account-groups', body)).status]).toEqual([JSON.stringify(body), 400]);
      }
      expect((await call(base, readToken, 'POST', '/account-groups', { name: 'Nope' })).status).toBe(403);
      const dup = await call(base, writeToken, 'POST', '/account-groups', { name: ' cards ' });
      expect(dup.status).toBe(409);
      expect(client.createAccountGroup).not.toHaveBeenCalled();
    });
  });

  test('PATCH renames (409 on another group name, 404 unknown); DELETE removes and leaves members ungrouped', async () => {
    client.state.accountGroups.push({ id: 'ag-2', name: 'Loans' });
    client.state.accounts.find((a) => a.id === 'a-chk').account_group_id = 'ag-2';
    await withServer(async (base) => {
      expect((await call(base, writeToken, 'PATCH', '/account-groups/ag-1', { name: 'Credit cards' })).status).toBe(200);
      expect(client.updateAccountGroup).toHaveBeenCalledWith('ag-1', { name: 'Credit cards' });
      expect((await call(base, writeToken, 'PATCH', '/account-groups/ag-1', { name: 'loans' })).status).toBe(409);
      expect((await call(base, writeToken, 'PATCH', '/account-groups/ag-1', { name: 'Credit cards' })).status).toBe(200);
      expect((await call(base, writeToken, 'PATCH', '/account-groups/nope', { name: 'X' })).status).toBe(404);
      expect((await call(base, readToken, 'PATCH', '/account-groups/ag-1', { name: 'X' })).status).toBe(403);
      const del = await call(base, writeToken, 'DELETE', '/account-groups/ag-2');
      expect(del.status).toBe(200);
      await json(del, 'okResponse');
      expect(client.state.accounts.find((a) => a.id === 'a-chk').account_group_id).toBeNull();
      expect((await call(base, writeToken, 'DELETE', '/account-groups/ag-2')).status).toBe(404);
      expect((await call(base, readToken, 'DELETE', '/account-groups/ag-1')).status).toBe(403);
      expect(auditLines().map((l) => l.op)).toEqual(['account-group.rename', 'account-group.rename', 'account-group.delete']);
    });
  });

  test('PUT /accounts/<id>/group assigns, moves and clears; unknown account or group is 404; bad bodies 400', async () => {
    await withServer(async (base) => {
      const put = (id, body, token = writeToken) => call(base, token, 'PUT', `/accounts/${id}/group`, body);
      const res = await put('a-chk', { groupId: 'ag-1' });
      expect(res.status).toBe(200);
      await json(res, 'okResponse');
      expect(client.updateAccount).toHaveBeenCalledWith('a-chk', { account_group_id: 'ag-1' });
      const listed = await json(await get(base, readToken, '/accounts'), 'accountsResponse');
      expect(listed.accounts.find((a) => a.id === 'a-chk').groupId).toBe('ag-1');
      expect(listed.groups.map((g) => g.id)).toEqual(['ag-1']);
      expect((await put('a-chk', { groupId: null })).status).toBe(200);
      expect(client.updateAccount).toHaveBeenLastCalledWith('a-chk', { account_group_id: null });
      expect((await put('nope', { groupId: 'ag-1' })).status).toBe(404);
      expect((await put('a-chk', { groupId: 'nope' })).status).toBe(404);
      for (const body of [{}, { groupId: 5 }, { groupId: 'a b' }, { groupId: null, x: 1 }]) expect((await put('a-chk', body)).status).toBe(400);
      expect((await put('a-chk', { groupId: 'ag-1' }, readToken)).status).toBe(403);
      expect(auditLines().map((l) => l.op)).toEqual(['account.group', 'account.group']);
    });
  });
});
