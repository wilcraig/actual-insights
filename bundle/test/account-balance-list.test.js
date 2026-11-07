vi.mock('../src/api-client', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../src/api-client';
import AccountBalanceList from '../src/widgets/AccountBalanceList.svelte';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const payload = () => ({
  accounts: [
    { id: 'a1', name: 'Checking', points: [{ date: '2026-11-06', balanceCents: 1000 }, { date: '2026-11-07', balanceCents: 123456 }] },
    { id: 'a2', name: 'Savings', points: [{ date: '2026-11-07', balanceCents: -5000 }] },
  ],
  netWorth: [],
});

function mount(props = {}) {
  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new AccountBalanceList({ target, props });
  return target;
}
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => fetchApi.mockReset());

test('lists each account with its latest balance, no total by default', async () => {
  fetchApi.mockResolvedValue(ok(payload()));
  const target = mount();
  await settle();
  const rows = [...target.querySelectorAll('.abl-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain('Checking');
  expect(rows[0]).toContain('1,234.56');
  expect(rows[1]).toContain('Savings');
  expect(fetchApi.mock.calls[0][0]).not.toContain('accounts=');
});

test('showTotal adds a Total row summing the balances', async () => {
  fetchApi.mockResolvedValue(ok(payload()));
  const target = mount({ showTotal: true });
  await settle();
  const total = target.querySelector('.abl-row--total');
  expect(total.textContent).toContain('Total');
  expect(total.textContent).toContain('1,184.56');
});

test('accountIds are sent as a comma-joined filter', async () => {
  fetchApi.mockResolvedValue(ok(payload()));
  mount({ accountIds: ['a1', 'a2'] });
  await settle();
  expect(decodeURIComponent(fetchApi.mock.calls[0][0])).toContain('accounts=a1,a2');
});

test('shows an error message when the request fails', async () => {
  fetchApi.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  const target = mount();
  await settle();
  expect(target.querySelector('[role="alert"]').textContent).toContain('500');
});
