const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-acctgroups-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/mobile/v1/reports', () => ({ buildReports: jest.fn(), buildReportList: jest.fn() }));

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const tokens = require('../../src/mobile-tokens-store');
const hiddenStore = require('../../src/mobile-hidden-accounts-store');
const { buildAccounts } = require('../../src/mobile/v1/read');
const { expectValid, examples, makeFakeActual } = require('../helpers/native-v1');

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
const getAccounts = async (token) =>
  withServer(async (base) => {
    const res = await fetch(`${base}/api/mobile/v1/accounts`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expectValid('accountsResponse', body);
    return body;
  });

const acct = (id, name, balance, extra = {}) => ({ id, name, offbudget: false, closed: false, balance, ...extra });

beforeEach(async () => {
  for (const t of await tokens.listTokens(DATA_DIR)) await tokens.revokeToken(t.id, DATA_DIR);
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

test('the contract example validates', () => {
  expectValid('accountsResponse', examples.accountsResponse);
});

describe('GET /accounts with account groups', () => {
  test('without groups: Actual order, groupId null, groups empty', async () => {
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'read' });
    const body = await getAccounts(token);
    expect(body.accounts.map((a) => [a.id, a.groupId])).toEqual([['a-chk', null], ['a-sav', null], ['a-ret', null]]);
    expect(body.groups).toEqual([]);
  });

  test('Actual sidebar order: ungrouped first, then each group in group order (members in account order), on-budget before off-budget', async () => {
    // getAccounts() returns sort_order order: the groups' members are interleaved with ungrouped accounts.
    client.state.accountGroups = [{ id: 'grp-b', name: 'Bank B' }, { id: 'grp-a', name: 'Bank A' }];
    client.state.accounts = [
      acct('a1', 'Zed', 100, { account_group_id: 'grp-a' }),
      acct('a2', 'Plain', 200),
      acct('a3', 'Yak', 300, { account_group_id: 'grp-b' }),
      acct('a4', 'Xi', 400, { account_group_id: 'grp-a' }),
      acct('o1', 'Off one', 5000, { offbudget: true, account_group_id: 'grp-b' }),
      acct('o2', 'Off plain', 6000, { offbudget: true }),
      acct('a5', 'Closed', 1, { closed: true, account_group_id: 'grp-a' }),
    ];
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'read' });
    const body = await getAccounts(token);
    expect(body.accounts.map((a) => [a.id, a.onBudget, a.groupId])).toEqual([
      ['a2', true, null],
      ['a3', true, 'grp-b'],
      ['a1', true, 'grp-a'],
      ['a4', true, 'grp-a'],
      ['o2', false, null],
      ['o1', false, 'grp-b'],
    ]);
    // Groups in Actual's order, summed over open visible accounts of BOTH sides.
    expect(body.groups).toEqual([
      { id: 'grp-b', name: 'Bank B', balance: 5300 },
      { id: 'grp-a', name: 'Bank A', balance: 500 },
    ]);
  });

  test('a group with no visible account is not listed; empty groups too', async () => {
    client.state.accountGroups = [{ id: 'g-empty', name: 'Empty' }, { id: 'g-closed', name: 'Only closed' }, { id: 'g-live', name: 'Live' }];
    client.state.accounts = [acct('a1', 'One', 10, { account_group_id: 'g-live' }), acct('a2', 'Two', 20, { closed: true, account_group_id: 'g-closed' })];
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'read' });
    const body = await getAccounts(token);
    expect(body.groups).toEqual([{ id: 'g-live', name: 'Live', balance: 10 }]);
  });

  test('hidden accounts: not listed, not summed, and a group of only hidden accounts is gone (its name too)', async () => {
    client.state.accountGroups = [{ id: 'g-mixed', name: 'Mixed' }, { id: 'g-secret', name: 'Secret savings' }];
    client.state.accounts = [
      acct('a1', 'Shown', 100, { account_group_id: 'g-mixed' }),
      acct('a2', 'Hidden one', 900, { account_group_id: 'g-mixed' }),
      acct('a3', 'Hidden two', 700, { account_group_id: 'g-secret' }),
    ];
    await hiddenStore.writeHiddenIds(['a2', 'a3'], DATA_DIR);
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'read' });
    const body = await getAccounts(token);
    expect(body.accounts.map((a) => a.id)).toEqual(['a1']);
    expect(body.groups).toEqual([{ id: 'g-mixed', name: 'Mixed', balance: 100 }]);
    expect(JSON.stringify(body)).not.toContain('Secret');
  });

  test('a group balance is null when any shown member balance is unknown', async () => {
    client.state.accountGroups = [{ id: 'g1', name: 'G1' }, { id: 'g2', name: 'G2' }];
    client.state.accounts = [
      acct('a1', 'One', 10, { account_group_id: 'g1' }),
      acct('a2', 'Two', 20, { account_group_id: 'g1' }),
      acct('a3', 'Three', 30, { account_group_id: 'g2' }),
    ];
    client.getAccountBalance.mockImplementation(async (id) => {
      if (id === 'a2') throw new Error('boom');
      return client.state.accounts.find((a) => a.id === id).balance;
    });
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'read' });
    const body = await getAccounts(token);
    expect(body.accounts.find((a) => a.id === 'a2').balance).toBeNull();
    expect(body.groups).toEqual([{ id: 'g1', name: 'G1', balance: null }, { id: 'g2', name: 'G2', balance: 30 }]);
  });

  test('negative balances sum; an account pointing at a deleted group is ungrouped', async () => {
    client.state.accountGroups = [{ id: 'g1', name: 'Cards' }];
    client.state.accounts = [
      acct('a1', 'Card one', -2500, { account_group_id: 'g1' }),
      acct('a2', 'Card two', -500, { account_group_id: 'g1' }),
      acct('a3', 'Orphan', 70, { account_group_id: 'g-deleted' }),
    ];
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'read' });
    const body = await getAccounts(token);
    expect(body.accounts.map((a) => [a.id, a.groupId])).toEqual([['a3', null], ['a1', 'g1'], ['a2', 'g1']]);
    expect(body.groups).toEqual([{ id: 'g1', name: 'Cards', balance: -3000 }]);
  });

  test('an Actual server without account groups (or one that fails) just has none', async () => {
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'read' });
    client.getAccountGroups.mockRejectedValue(new Error('no such table'));
    expect((await getAccounts(token)).groups).toEqual([]);
    delete client.getAccountGroups;
    const body = await buildAccounts(client);
    expectValid('accountsResponse', body);
    expect(body.groups).toEqual([]);
  });

  test('the 100-account cap still keeps on-budget accounts ahead of off-budget ones', async () => {
    client.state.accounts = [
      ...Array.from({ length: 100 }, (_, i) => acct(`off${i}`, `Off ${i}`, 1, { offbudget: true })),
      acct('on1', 'On', 1),
    ];
    const body = await buildAccounts(client);
    expect(body.accounts).toHaveLength(100);
    expect(body.accounts[0].id).toBe('on1');
  });
});
