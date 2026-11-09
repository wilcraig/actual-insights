import { watchEditableWidgets } from '../../src/widget-builder/edit-hook';

function addWidget(raw) {
  const host = document.createElement('div');
  const wrapper = document.createElement('span');
  wrapper.className = 'actualmint-hidden-placeholder';
  wrapper.textContent = raw;
  const mountHost = document.createElement('div');
  mountHost.className = 'actualmint-widget-host';
  host.append(wrapper, mountHost);
  document.body.appendChild(host);
  return mountHost;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

test('puts an accessible edit button on a live widget and hands its parsed placeholder to onEdit', async () => {
  const onEdit = vi.fn();
  const stop = watchEditableWidgets(document, window, onEdit);
  const mountHost = addWidget('{{INSIGHTS:savings-rate-gauge:["g1"]}}');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const button = mountHost.querySelector('.insights-edit-widget');
  expect(button.getAttribute('aria-label')).toBe('Edit in widget builder');
  button.click();
  expect(onEdit).toHaveBeenCalledWith({ widgetId: 'savings-rate-gauge', body: ['g1'], raw: '{{INSIGHTS:savings-rate-gauge:["g1"]}}', mountHost });
  stop();
});

test('widgets already on the page get a button immediately, once, and unrelated text gets none', async () => {
  const live = addWidget('{{INSIGHTS:burn-rate:null}}');
  const plain = addWidget('just some notes');
  const stop = watchEditableWidgets(document, window, () => {});
  expect(live.querySelectorAll('.insights-edit-widget').length).toBe(1);
  expect(plain.querySelector('.insights-edit-widget')).toBeNull();
  document.body.appendChild(document.createElement('p'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(live.querySelectorAll('.insights-edit-widget').length).toBe(1);
  stop();
});
