import { qrSvg } from '../src/insights-page/qr';

test('qrSvg returns an inline svg with crisp edges and a white quiet zone', () => {
  const svg = qrSvg('hello', { cellSize: 4, margin: 4 });
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg.trim().endsWith('</svg>')).toBe(true);
  expect(svg).toContain('shape-rendering="crispEdges"');
  expect(svg).toContain('fill="#ffffff"');
  expect(svg).toContain('fill="#000000"');
});

test('a short input is a version 1 symbol: 21 modules plus the quiet zone', () => {
  // 'hello' at level M fits version 1 (21x21); cellSize 4, margin 4 -> (21 + 8) * 4.
  const svg = qrSvg('hello', { cellSize: 4, margin: 4 });
  expect(svg).toContain('width="116"');
  expect(svg).toContain('height="116"');
  expect(svg).toContain('viewBox="0 0 116 116"');
});

test('different inputs produce different output, same input is stable', () => {
  expect(qrSvg('hello')).not.toBe(qrSvg('world'));
  expect(qrSvg('hello')).toBe(qrSvg('hello'));
});

test('longer payloads grow the symbol', () => {
  const small = qrSvg('a', { cellSize: 1, margin: 0 });
  const big = qrSvg('chipmunk://pair?u=' + 'x'.repeat(80), { cellSize: 1, margin: 0 });
  const size = (s) => Number(/width="(\d+)"/.exec(s)[1]);
  expect(size(big)).toBeGreaterThan(size(small));
});
