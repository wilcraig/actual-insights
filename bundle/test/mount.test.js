import { findPlaceholder, mountWidget } from '../src/mount';
import { buildPlaceholder } from '../src/widget-builder/placeholder';

test('finds and parses a placeholder with valid JSON config', () => {
  document.body.innerHTML = '<div id="host">{{INSIGHTS:pacing-bars:["catA","catB"]}}</div>';
  const result = findPlaceholder('{{INSIGHTS:pacing-bars:');
  expect(result).not.toBeNull();
  expect(result.config).toEqual(['catA', 'catB']);
  expect(result.node).toBe(document.getElementById('host'));
});

test('returns null when no placeholder is present', () => {
  document.body.innerHTML = '<div>nothing here</div>';
  expect(findPlaceholder('{{INSIGHTS:pacing-bars:')).toBeNull();
});

test('a throwing render callback is caught and does not propagate', () => {
  document.body.innerHTML = '<div>{{INSIGHTS:pacing-bars:[]}}</div>';
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(() => {
    mountWidget('{{INSIGHTS:pacing-bars:', () => { throw new Error('boom'); });
  }).not.toThrow();

  expect(consoleError).toHaveBeenCalled();
});

test('placeholders written before the rename ({{ACTUALMINT:...}}) still mount, alongside new ones', () => {
  document.body.innerHTML = `
    <div id="old">{{ACTUALMINT:pacing-bars:["legacy"]}}</div>
    <div id="new">{{INSIGHTS:pacing-bars:["current"]}}</div>
  `;

  const configs = [];
  mountWidget('{{INSIGHTS:pacing-bars:', (mountHost, config) => configs.push(config));

  expect(configs).toEqual(expect.arrayContaining([['legacy'], ['current']]));
  expect(configs).toHaveLength(2);
});

test('mounts every matching placeholder present in the same DOM snapshot', () => {
  document.body.innerHTML = `
    <div id="a">{{INSIGHTS:pacing-bars:["x"]}}</div>
    <div id="b">{{INSIGHTS:pacing-bars:["y"]}}</div>
  `;

  const mountedHosts = [];
  mountWidget('{{INSIGHTS:pacing-bars:', (mountHost, config) => {
    mountedHosts.push({ mountHost, config });
  });

  expect(mountedHosts.length).toBe(2);
  // render() is given a new element mounted *inside* the original host
  // (#a / #b), not the original host itself (see the non-destructive-mount
  // test below for why).
  expect(mountedHosts.map((m) => m.mountHost.parentElement)).toEqual(
    expect.arrayContaining([document.getElementById('a'), document.getElementById('b')]),
  );
  expect(mountedHosts.map((m) => m.config)).toEqual(
    expect.arrayContaining([['x'], ['y']]),
  );
});

test('does not delete the original placeholder text node; hides it instead', () => {
  document.body.innerHTML = '<div id="host">{{INSIGHTS:pacing-bars:["catA"]}}</div>';
  const host = document.getElementById('host');
  const originalTextNode = host.firstChild;
  expect(originalTextNode.nodeType).toBe(Node.TEXT_NODE);

  mountWidget('{{INSIGHTS:pacing-bars:', () => {});

  // The original text node is still in the document (not removed), its
  // content untouched, just wrapped in a hidden element.
  expect(document.body.contains(originalTextNode)).toBe(true);
  expect(originalTextNode.nodeValue).toContain('{{INSIGHTS:pacing-bars:');

  const wrapper = originalTextNode.parentElement;
  expect(wrapper).not.toBe(null);
  expect(wrapper.tagName).toBe('SPAN');
  expect(wrapper.style.display).toBe('none');
  expect(host.contains(wrapper)).toBe(true);
});

test('mounts into a new sibling element rather than clearing the host', () => {
  document.body.innerHTML = '<div id="host">{{INSIGHTS:pacing-bars:["catA"]}}</div>';
  const host = document.getElementById('host');

  let receivedMountHost;
  mountWidget('{{INSIGHTS:pacing-bars:', (mountHost) => {
    receivedMountHost = mountHost;
  });

  expect(receivedMountHost).not.toBe(host);
  expect(host.contains(receivedMountHost)).toBe(true);
  // Both the hidden wrapper and the new mount host are children of #host.
  expect(host.children.length).toBe(2);
});

describe('findPlaceholder parses all buildPlaceholder body shapes', () => {
  test('single-field (raw array) body', () => {
    const placeholder = buildPlaceholder('pacing-bars', [{ key: 'categories' }], {
      categories: ['catA', 'catB'],
    });
    expect(placeholder).toBe('{{INSIGHTS:pacing-bars:["catA","catB"]}}');
    document.body.innerHTML = `<div id="host">${placeholder}</div>`;

    const result = findPlaceholder('{{INSIGHTS:pacing-bars:');
    expect(result).not.toBeNull();
    expect(result.config).toEqual(['catA', 'catB']);
  });

  test('multi-field (keyed object) body', () => {
    const placeholder = buildPlaceholder(
      'month-end-net',
      [{ key: 'accountId' }, { key: 'months' }],
      { accountId: 'acc1', months: 6 },
    );
    expect(placeholder).toBe('{{INSIGHTS:month-end-net:{"accountId":"acc1","months":6}}}');
    document.body.innerHTML = `<div id="host">${placeholder}</div>`;

    const result = findPlaceholder('{{INSIGHTS:month-end-net:');
    expect(result).not.toBeNull();
    expect(result.config).toEqual({ accountId: 'acc1', months: 6 });
  });

  test('zero-field (empty object) body', () => {
    const placeholder = buildPlaceholder('month-end-net', [], {});
    expect(placeholder).toBe('{{INSIGHTS:month-end-net:{}}}');
    document.body.innerHTML = `<div id="host">${placeholder}</div>`;

    const result = findPlaceholder('{{INSIGHTS:month-end-net:');
    expect(result).not.toBeNull();
    expect(result.config).toEqual({});
  });
});

test('a later DOM mutation does not cause the same placeholder to be re-mounted', async () => {
  document.body.innerHTML = '<div id="host">{{INSIGHTS:pacing-bars:["catA"]}}</div>';

  let calls = 0;
  mountWidget('{{INSIGHTS:pacing-bars:', () => {
    calls += 1;
  });
  expect(calls).toBe(1);

  // Some unrelated DOM mutation elsewhere (e.g. Actual re-rendering another
  // part of the page) triggers the MutationObserver and another scan().
  const unrelated = document.createElement('div');
  document.body.appendChild(unrelated);
  await Promise.resolve(); // the observer's scan() is queued as a microtask

  expect(calls).toBe(1);
});

// Editing a Text widget in Actual updates its (moved) placeholder text node in
// place instead of replacing it, so the widget must be drawn again from the new text.
describe('a placeholder edited in place', () => {
  test('is re-rendered from the new text, replacing the old widget instead of stacking a second one', async () => {
    document.body.innerHTML = '<div id="card"><p id="p">{{INSIGHTS:demo:["a"]}}</p></div>';
    const destroy = vi.fn();
    const calls = [];
    mountWidget('{{INSIGHTS:demo:', (host, config) => {
      calls.push(config);
      host.textContent = JSON.stringify(config);
      return { $destroy: destroy };
    });
    expect(calls).toEqual([['a']]);

    // Actual's renderer updates the text node itself, which mounting moved into a hidden wrapper.
    document.querySelector('.actualmint-hidden-placeholder').firstChild.nodeValue = '{{INSIGHTS:demo:["b"]}}';
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([['a'], ['b']]);
    expect(destroy).toHaveBeenCalledTimes(1);
    const hosts = document.querySelectorAll('.actualmint-widget-host');
    expect(hosts.length).toBe(1);
    expect(hosts[0].textContent).toBe('["b"]');
    // The new widget sits next to the (hidden) placeholder, not inside it.
    expect(hosts[0].parentElement.id).toBe('p');
  });

  test('an unchanged placeholder is not drawn again', async () => {
    document.body.innerHTML = '<p id="p">{{INSIGHTS:demo2:[1]}}</p>';
    const render = vi.fn();
    mountWidget('{{INSIGHTS:demo2:', render);
    document.body.appendChild(document.createElement('div'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render).toHaveBeenCalledTimes(1);
  });
});
