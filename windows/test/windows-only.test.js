'use strict';
// Runs on a real Windows machine (the GitHub Actions windows job); skipped elsewhere.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WinHelper } = require('../src/winhelper');
const control = require('../src/control');

const onWindows = { skip: process.platform !== 'win32' ? 'needs Windows' : false, timeout: 90000 };

test('the PowerShell helper starts and answers', onWindows, async () => {
  const helper = new WinHelper(fs.mkdtempSync(path.join(os.tmpdir(), 'bluey-')));
  try {
    assert.strictEqual((await helper.request('ping', {}, 60000)).pong, true);
    const front = await helper.request('front');
    assert.strictEqual(typeof front.title, 'string');
    const focus = await helper.request('focus');
    assert.strictEqual(typeof focus.secure, 'boolean');
    const controls = await helper.request('controls', {}, 10000);
    assert.ok(Array.isArray(controls.controls) || controls.controls === undefined || typeof controls.controls === 'object');
    // OCR on a small blank image: may find nothing, but must not fail if OCR exists on this machine.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr(64, 32)),
      chunk('IDAT', zlib.deflateSync(Buffer.alloc((64 * 3 + 1) * 32, 255))), chunk('IEND', Buffer.alloc(0))]);
    try { const r = await helper.ocr(png); assert.ok(Array.isArray(r.lines) || r.lines === undefined || typeof r.lines === 'object'); }
    catch (e) { assert.match(e.message, /OCR/); }
  } finally { helper.stop(); }
});

test('SendInput structures load and the pointer can be read and put back', onWindows, () => {
  const p = control.mouseLocation();
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  control.warp(p);
  assert.strictEqual(control.parseKeys('ctrl+t').label, 'Ctrl+T');
});

function ihdr(w, h) { const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = 8; b[9] = 2; return b; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  let c = ~0; for (const x of td) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
  return Buffer.concat([len, td, crc]);
}
