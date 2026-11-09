vi.mock('../../src/api-client', () => ({ fetchApi: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ categories: [] }) })) }));
vi.mock('../../src/widget-builder/preview', () => ({ mountPreview: vi.fn(() => () => {}) }));

import { tick } from 'svelte';
import { openBuilder, closeBuilder } from '../../src/widget-builder/controller';

beforeEach(() => {
  closeBuilder();
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/reports/0a1b2c3d-1111-2222-3333-444455556666');
});

test('mounts one dialog straight on <body>, a second open is ignored, and closing removes it and restores focus', async () => {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();

  openBuilder();
  openBuilder();
  await tick();
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
  expect(document.querySelector('[role="dialog"]').closest('body')).toBe(document.body);

  document.querySelector('.insights-wb-close').click();
  await tick();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);

  openBuilder();
  await tick();
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
});

test('navigating away from Reports closes it', async () => {
  openBuilder();
  await tick();
  window.history.pushState({}, '', '/budget');
  await tick();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('opens on an existing widget when given one', async () => {
  openBuilder({ initial: { widgetId: 'month-end-net', body: null, raw: '{{INSIGHTS:month-end-net:null}}', mountHost: null } });
  await tick();
  expect(document.querySelector('#insights-wb-title').textContent).toBe('Edit widget');
});
