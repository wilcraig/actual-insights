import qrcode from 'qrcode-generator';

/**
 * Renders `text` as an inline QR-code <svg> string.
 *
 * Dark modules on a white quiet zone (so it scans in dark themes), error
 * correction level M, smallest version that fits (type number 0). The
 * markup is built only from the encoder's boolean module grid and numeric
 * sizes, never from `text`, so it is safe to inject with {@html}.
 * @param {string} text
 * @param {{ cellSize?: number, margin?: number }} [options]
 */
export function qrSvg(text, { cellSize = 4, margin = 4 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = (count + margin * 2) * cellSize;
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        path += `M${(col + margin) * cellSize} ${(row + margin) * cellSize}h${cellSize}v${cellSize}h-${cellSize}z`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  );
}
