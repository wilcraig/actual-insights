import { tick } from 'svelte';

vi.mock('../../src/widget-builder/controller', () => ({ openBuilder: vi.fn() }));

import WidgetBuilderPanel from '../../src/widget-builder/WidgetBuilderPanel.svelte';
import { openBuilder } from '../../src/widget-builder/controller';

test('renders only the toolbar button, and clicking it opens the builder', async () => {
  openBuilder.mockReset();
  document.body.innerHTML = '';
  const target = document.createElement('div');
  document.body.appendChild(target);
  new WidgetBuilderPanel({ target });
  await tick();

  const button = target.querySelector('.actualmint-wb-toggle');
  expect(button.textContent.trim()).toBe('Widget builder');
  expect(target.querySelector('.actualmint-wb-panel')).toBeNull();

  button.click();
  expect(openBuilder).toHaveBeenCalledTimes(1);
  expect(openBuilder).toHaveBeenCalledWith();
});
