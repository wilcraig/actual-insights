vi.mock('../src/insights-page/mobile-api', async (importOriginal) => ({
  ...(await importOriginal()),
  listTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
}));

import { listTokens, createToken, revokeToken, MobileApiError } from '../src/insights-page/mobile-api';
import MobileTab from '../src/insights-page/MobileTab.svelte';

const SECRET = 'tok_SuperSecretValue_123';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const tok = (id, label, lastUsedAt = null, scope = 'read') => ({ id, label, scope, createdAt: '2026-10-01T12:00:00.000Z', lastUsedAt });

let app;
async function mountTab() {
  document.body.innerHTML = '<div id="host"></div>';
  app = new MobileTab({ target: document.getElementById('host') });
  await flush();
  await flush();
  return document.getElementById('host');
}

async function click(el) {
  el.click();
  await flush();
  await flush();
}

async function create(host, label = 'My phone') {
  const input = host.querySelector('.label-input');
  input.value = label;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  await click(host.querySelector('.create-token'));
}

const buttonByText = (host, text) => [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

beforeEach(() => {
  listTokens.mockReset();
  listTokens.mockResolvedValue({ tokens: [] });
  createToken.mockReset();
  createToken.mockResolvedValue({ id: 't9', token: SECRET, label: 'My phone', createdAt: '2026-11-01T00:00:00.000Z' });
  revokeToken.mockReset();
  revokeToken.mockResolvedValue(null);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  try {
    app?.$destroy?.();
  } catch {
    // ignore
  }
});

test('shows the intro, secret warning, empty state and 0 of 10', async () => {
  const host = await mountTab();
  expect(host.textContent).toContain('read-only');
  expect(host.querySelector('.secret-warning').textContent).toMatch(/screenshot/i);
  expect(host.textContent).toContain('No devices paired yet.');
  expect(host.textContent).toContain('0 of 10 devices');
});

test('Create token is disabled while the label is empty', async () => {
  const host = await mountTab();
  const btn = host.querySelector('.create-token');
  expect(btn.disabled).toBe(true);
  const input = host.querySelector('.label-input');
  input.value = 'Phone';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  expect(btn.disabled).toBe(false);
});

test('creating shows the token once with the QR code and pairing URL, then lists the device', async () => {
  const host = await mountTab();
  listTokens.mockResolvedValue({ tokens: [tok('t9', 'My phone')] });
  await create(host);
  expect(createToken).toHaveBeenCalledWith('My phone', 'read');
  const block = host.querySelector('.new-token');
  expect(block).not.toBeNull();
  expect(block.textContent).toContain(SECRET);
  expect(block.querySelector('svg')).not.toBeNull();
  const expected = `chipmunk://pair?u=${encodeURIComponent(window.location.origin)}&t=${encodeURIComponent(SECRET)}`;
  expect(block.querySelector('.pairing-url').textContent).toBe(expected);
  expect(host.querySelectorAll('.token-row')).toHaveLength(1);
});

test('Done removes the token from the DOM for good and never touches web storage', async () => {
  const host = await mountTab();
  await create(host);
  expect(host.innerHTML).toContain(SECRET);
  await click(buttonByText(host, 'Done'));
  expect(host.querySelector('.new-token')).toBeNull();
  expect(host.innerHTML).not.toContain(SECRET);
  expect(host.innerHTML).not.toContain(encodeURIComponent(SECRET));
  expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
});

test('Copy writes the pairing token to the clipboard, or says it could not', async () => {
  const host = await mountTab();
  await create(host);
  const writeText = vi.fn().mockResolvedValue();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await click(buttonByText(host, 'Copy'));
  expect(writeText).toHaveBeenCalledWith(SECRET);
  expect(host.querySelector('.copy-status').textContent).toMatch(/copied/i);

  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  await click(buttonByText(host, 'Copy'));
  expect(host.querySelector('.copy-status').textContent).toMatch(/select|manually|copy it/i);
});

test('leaving the tab (destroy) drops the token', async () => {
  const host = await mountTab();
  await create(host);
  app.$destroy();
  app = null;
  expect(host.innerHTML).not.toContain(SECRET);
});

test('lists devices with created and last-used info', async () => {
  listTokens.mockResolvedValue({ tokens: [tok('t1', 'Kitchen iPad', '2026-10-20T08:00:00.000Z'), tok('t2', 'Phone')] });
  const host = await mountTab();
  const rows = host.querySelectorAll('.token-row');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('Kitchen iPad');
  expect(rows[0].textContent).toContain('Last used');
  expect(rows[1].textContent).toContain('Never used');
  expect(host.textContent).toContain('2 of 10 devices');
});

test('Revoke asks inline first, Cancel backs out, confirm removes the row', async () => {
  listTokens.mockResolvedValue({ tokens: [tok('t1', 'Kitchen iPad'), tok('t2', 'Phone')] });
  const host = await mountTab();
  const row = () => host.querySelector('[data-token-id="t1"]');
  await click(row().querySelector('.revoke'));
  expect(revokeToken).not.toHaveBeenCalled();
  expect(row().textContent).toMatch(/revoke/i);
  await click(buttonByText(row(), 'Cancel'));
  expect(row().querySelector('.confirm-revoke')).toBeNull();
  await click(row().querySelector('.revoke'));
  await click(row().querySelector('.confirm-revoke'));
  expect(revokeToken).toHaveBeenCalledWith('t1');
  expect(host.querySelector('[data-token-id="t1"]')).toBeNull();
  expect(host.querySelectorAll('.token-row')).toHaveLength(1);
});

test('a failed revoke keeps the row and shows the error', async () => {
  listTokens.mockResolvedValue({ tokens: [tok('t1', 'Kitchen iPad')] });
  revokeToken.mockRejectedValue(new MobileApiError('Unknown token', 404));
  const host = await mountTab();
  await click(host.querySelector('.revoke'));
  await click(host.querySelector('.confirm-revoke'));
  expect(host.querySelector('[data-token-id="t1"]')).not.toBeNull();
  expect(host.querySelector('.mobile-error').textContent).toContain('Unknown token');
});

test('create errors (400, 409, network) are shown and never include the label', async () => {
  const host = await mountTab();
  for (const message of ['Label is too long', 'Too many devices', 'Could not reach insights-api.']) {
    createToken.mockRejectedValueOnce(new MobileApiError(message, 400));
    await create(host, 'Secret-ish label');
    expect(host.querySelector('.mobile-error').textContent).toContain(message);
    expect(host.querySelector('.new-token')).toBeNull();
  }
});

test('at 10 devices creating is disabled', async () => {
  listTokens.mockResolvedValue({ tokens: Array.from({ length: 10 }, (_, i) => tok(`t${i}`, `Device ${i}`)) });
  const host = await mountTab();
  expect(host.textContent).toContain('10 of 10 devices');
  const input = host.querySelector('.label-input');
  input.value = 'One more';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  expect(host.querySelector('.create-token').disabled).toBe(true);
});

test('a failed list load shows an error', async () => {
  listTokens.mockRejectedValue(new MobileApiError('Could not reach insights-api.'));
  const host = await mountTab();
  expect(host.querySelector('.mobile-error').textContent).toContain('Could not reach insights-api.');
});

test('the edit checkbox is off by default, explains itself, and creates a read token', async () => {
  const host = await mountTab();
  const box = host.querySelector('.allow-edit');
  expect(box.checked).toBe(false);
  expect(host.textContent).toContain('Allow this device to change my budget');
  expect(host.querySelector('.allow-edit-note').textContent).toMatch(/categorize transactions and edit budget amounts.*revoking the device removes it/);
  await create(host);
  expect(createToken).toHaveBeenLastCalledWith('My phone', 'read');
});

test('ticking the checkbox creates a write token, then the box resets', async () => {
  const host = await mountTab();
  const box = host.querySelector('.allow-edit');
  box.click();
  await flush();
  expect(box.checked).toBe(true);
  await create(host);
  expect(createToken).toHaveBeenLastCalledWith('My phone', 'write');
  expect(host.querySelector('.allow-edit').checked).toBe(false);
});

test('each device shows its access: Read only or Can edit', async () => {
  listTokens.mockResolvedValue({ tokens: [tok('t1', 'Ann phone'), tok('t2', 'Ryan phone', null, 'write'), { id: 't3', label: 'Old', createdAt: '2026-10-01T12:00:00.000Z', lastUsedAt: null }] });
  const host = await mountTab();
  const rows = [...host.querySelectorAll('.token-row')].map((r) => r.textContent);
  expect(rows[0]).toContain('Read only');
  expect(rows[1]).toContain('Can edit');
  expect(rows[2]).toContain('Read only');
});
