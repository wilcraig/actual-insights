jest.mock('../../src/actual-client');
jest.mock('../../src/auth');

const { getActualClient } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');

const AUTH_HEADERS = { 'X-ACTUAL-TOKEN': 'valid-test-token' };

async function withServer(fn) {
  const app = require('../../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  getActualClient.mockReset();
  validateToken.mockReset();
  validateToken.mockResolvedValue(true);
});

test('flattens non-hidden category groups with their visible category ids and income/transfer flags', async () => {
  getActualClient.mockResolvedValue({
    getCategoryGroups: jest.fn(async () => [
      { id: 'group1', name: 'Everyday Expenses', hidden: false, categories: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B', hidden: true }] },
      { id: 'group2', name: 'Archived Group', hidden: true, categories: [] },
      { id: 'group3', name: 'Personal Income', hidden: false, categories: [{ id: 'c3', name: 'Pay' }] },
      { id: 'group4', name: 'Transfers', hidden: false, categories: [{ id: 'c4', name: 'Move' }] },
    ]),
  });

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/category-groups`, { headers: AUTH_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      groups: [
        { id: 'group1', name: 'Everyday Expenses', isIncome: false, isTransfer: false, categoryIds: ['c1'] },
        { id: 'group3', name: 'Personal Income', isIncome: true, isTransfer: false, categoryIds: ['c3'] },
        { id: 'group4', name: 'Transfers', isIncome: false, isTransfer: true, categoryIds: ['c4'] },
      ],
    });
  });
});

test('401s with no token', async () => {
  getActualClient.mockResolvedValue({ getCategoryGroups: jest.fn(async () => []) });

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/category-groups`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(validateToken).not.toHaveBeenCalled();
  });
});
