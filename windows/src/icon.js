'use strict';
// Draws the little berry (in any colour) as a PNG, for the tray and the app icon. No image files needed.
const zlib = require('zlib');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function gradientAt(colour, t) {
  const stops = [0, 0.34, 0.68, 1]; const cols = colour.berry.map(hex);
  for (let i = 0; i < 3; i++) if (t <= stops[i + 1]) return mix(cols[i], cols[i + 1], (t - stops[i]) / (stops[i + 1] - stops[i]));
  return cols[3];
}

function rgba(colour, size) {
  const px = Buffer.alloc(size * size * 4);
  const ink = [0x17, 0x15, 0x1f];
  const put = (x, y, c, a) => {
    const i = (y * size + x) * 4; const old = px[i + 3] / 255; const na = a + old * (1 - a);
    for (let k = 0; k < 3; k++) px[i + k] = na ? Math.round((c[k] * a + px[i + k] * old * (1 - a)) / na) : 0;
    px[i + 3] = Math.round(na * 255);
  };
  const cover = (x, y, cx, cy, rx, ry) => { // 4x4 supersampled coverage of an ellipse
    let n = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const dx = (x + (sx + 0.5) / 4 - cx) / rx; const dy = (y + (sy + 0.5) / 4 - cy) / ry;
      if (dx * dx + dy * dy <= 1) n++;
    }
    return n / 16;
  };
  const s = size;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const body = cover(x, y, s * 0.5, s * 0.55, s * 0.47, s * 0.42);
    if (body) put(x, y, gradientAt(colour, Math.min(1, Math.max(0, (x * 0.5 + y) / (s * 1.5)))), body);
    for (const ex of [0.36, 0.64]) {
      const white = cover(x, y, s * ex, s * 0.47, s * 0.13, s * 0.15);
      if (white) put(x, y, [255, 255, 255], white);
      const pupil = cover(x, y, s * (ex + 0.02), s * 0.5, s * 0.065, s * 0.075);
      if (pupil) put(x, y, ink, pupil);
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function berryPNG(colour, size = 32) {
  const px = rgba(colour, size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { berryPNG };
