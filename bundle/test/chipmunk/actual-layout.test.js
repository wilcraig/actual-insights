import { findChrome, applyActualLayout } from '../../src/chipmunk/shell/actual-layout';

// Actual's frame, as seen live (docs/insights-page-hosting-notes.md): root > row > [sidebar, area > [main > [bar > help button, content]]].
function frame() {
  document.body.innerHTML = `
    <div id="root"><div id="row">
      <div id="sidebar"></div>
      <div id="area"><div id="main"><div id="bar"><button data-testid="help-menu-button"></button></div><div id="content"></div></div></div>
    </div></div>`;
  const rect = (id, left, height) => { document.getElementById(id).getBoundingClientRect = () => ({ left, top: 0, width: 100, height, right: left + 100, bottom: height }); };
  rect('row', 0, 900);
  rect('sidebar', 0, 900);
  rect('area', 312, 900);
  rect('main', 312, 900);
  rect('bar', 312, 49);
  document.querySelector('[data-testid="help-menu-button"]').getBoundingClientRect = () => ({ left: 1300, top: 10, width: 20, height: 20 });
  return { slot: Object.assign(document.createElement('div'), { getBoundingClientRect: () => ({ left: 248, top: 53, width: 1192, height: 847 }) }) };
}

describe('findChrome', () => {
  test('finds the title bar and the sidebar from the help button', () => {
    frame();
    const c = findChrome(document);
    expect(c.bar.id).toBe('bar');
    expect(c.area.id).toBe('area');
    expect(c.sidebars.map((e) => e.id)).toEqual(['sidebar']);
  });
  test('null when Actual shows no app frame (file picker, login)', () => {
    document.body.innerHTML = '<div id="root"><p>Files</p></div>';
    expect(findChrome(document)).toBeNull();
  });
});

describe('applyActualLayout', () => {
  test('sizes Actual to the slot, hides sidebar and title bar, and undoes all of it', () => {
    const { slot } = frame();
    const root = document.getElementById('root');
    root.setAttribute('style', 'visibility: hidden;');
    const undo = applyActualLayout(document, window, slot);
    expect(root.style.position).toBe('relative');
    expect(root.style.top).toBe('53px');
    expect(root.style.marginLeft).toBe('248px');
    expect(root.style.width).toBe('1192px');
    expect(root.style.height).toBe('847px');
    expect(root.style.zIndex).toBe(''); // no stacking context, so Actual's modals layer freely
    expect(root.style.transform).toBe('');
    expect(document.getElementById('bar').style.display).toBe('none');
    expect(document.getElementById('sidebar').style.display).toBe('none');
    expect(document.getElementById('content').style.display).toBe('');
    undo();
    expect(root.getAttribute('style')).toBe('visibility: hidden;');
    expect(document.getElementById('bar').getAttribute('style') ?? '').toBe('');
    expect(document.getElementById('sidebar').hasAttribute('data-cm-hidden')).toBe(false);
  });
  test('hides ABT live sidebars too; a file-picker page is shown whole', () => {
    document.body.innerHTML = '<div id="root"><div class="sidebar"></div><p>Files</p></div>';
    const slot = Object.assign(document.createElement('div'), { getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 200 }) });
    const undo = applyActualLayout(document, window, slot);
    expect(document.querySelector('.sidebar').style.display).toBe('none');
    expect(document.querySelector('p').style.display).toBe('');
    expect(document.getElementById('root').style.top).toBe('20px');
    undo();
    expect(document.querySelector('.sidebar').getAttribute('style') ?? '').toBe('');
  });
  test('re-places on window resize', async () => {
    const { slot } = frame();
    let box = { left: 248, top: 53, width: 1192, height: 847 };
    slot.getBoundingClientRect = () => box;
    const undo = applyActualLayout(document, window, slot);
    box = { left: 0, top: 56, width: 390, height: 788 };
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 60));
    expect(document.getElementById('root').style.width).toBe('390px');
    expect(document.getElementById('root').style.top).toBe('56px');
    undo();
  });
});
