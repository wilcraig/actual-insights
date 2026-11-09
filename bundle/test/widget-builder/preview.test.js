vi.mock('../../src/widget-mounters', () => ({
  WIDGET_MOUNTERS: {
    ok: vi.fn((host, body) => {
      const el = document.createElement('i');
      el.textContent = JSON.stringify(body);
      host.appendChild(el);
      return { $destroy: vi.fn() };
    }),
    boom: vi.fn(() => {
      throw new Error('render failed');
    }),
  },
}));

import { mountPreview } from '../../src/widget-builder/preview';
import { WIDGET_MOUNTERS } from '../../src/widget-mounters';

test('renders the widget into the host with the given body, and the teardown destroys it and empties the host', () => {
  const host = document.createElement('div');
  host.innerHTML = '<b>old</b>';
  const teardown = mountPreview(host, 'ok', ['c1']);
  expect(host.textContent).toBe('["c1"]');
  const instance = WIDGET_MOUNTERS.ok.mock.results[0].value;
  teardown();
  expect(instance.$destroy).toHaveBeenCalled();
  expect(host.childNodes.length).toBe(0);
});

test('an unknown widget or a widget that throws leaves the preview empty without throwing', () => {
  const host = document.createElement('div');
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => mountPreview(host, 'nope', null)()).not.toThrow();
  expect(() => mountPreview(host, 'boom', null)()).not.toThrow();
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
