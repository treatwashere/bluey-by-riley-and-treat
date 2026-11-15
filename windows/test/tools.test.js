'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RealtimeHost, tools } = require('../src/host');
const { ScreenSnapshot, linesFromOcr } = require('../src/screenreader');
const { CodexController } = require('../src/codex');
const notes = require('../src/notes');
const control = require('../src/control');

const ocr = { width: 2000, height: 1000, lines: [
  { text: 'Save changes', words: [{ text: 'Save', x: 100, y: 100, w: 80, h: 30 }, { text: 'changes', x: 190, y: 100, w: 120, h: 30 }] },
  { text: 'Title', words: [{ text: 'Title', x: 50, y: 20, w: 90, h: 30 }] },
] };

function fakeHost(snapshot) {
  const sent = [];
  const store = { get: (k) => ({ computerControl: true, followMouse: true })[k], getKey: () => null };
  const host = new RealtimeHost({
    overlay: { send: (m) => sent.push(m), state: { tip: { x: 0, y: 0 }, arriveIn: 0 }, waitForFrame: async () => {} },
    store, focus: { current: null, start: (t, m) => `Focus started: ${t}, ${m} minutes.`, pause: () => 'Focus paused.' },
    codex: { isInstalled: false, status: () => 'No Codex jobs yet.' },
    reader: { snapshot: async () => snapshot }, helper: { request: async () => ({ secure: false }) },
    reports: { loading() {}, show() {}, error() {} }, screen: { getPrimaryDisplay: () => ({ bounds: { width: 1000, height: 500 } }), getCursorScreenPoint: () => ({ x: 120, y: 60 }) },
    colourName: () => 'Greenie', openExternal: async () => {},
  });
  return { host, sent };
}

test('OCR lines become L/W targets in reading order on the DIP screen', () => {
  const lines = linesFromOcr(ocr, { w: 1000, h: 500 });
  assert.deepStrictEqual(lines.map((l) => l.line.text), ['Title', 'Save changes']);
  assert.deepStrictEqual(lines[1].words.map((w) => w.id), ['W2', 'W3']);
  assert.deepStrictEqual(lines[1].words[0].rect, { x: 50, y: 50, w: 40, h: 15 });
  const shot = new ScreenSnapshot({ jpeg: Buffer.from('x'), lines, size: { w: 1000, h: 500 }, app: 'notepad', controls: [{ id: 'C1', kind: 'button', label: 'OK', rect: { x: 900, y: 450, w: 40, h: 20 } }] });
  assert.match(shot.targetList, /C1 button @920,920 "OK"/);
  assert.match(shot.targetList, /L2 @103,115 "Save changes" \| W2=Save W3=changes/);
  assert.strictEqual(shot.target('w2').text, 'Save');
  assert.strictEqual(shot.targetNear({ x: 70, y: 57 }).id, 'W2');
});

test('his tools: look, point, focus, and computer control is refused off Windows', async () => {
  const lines = linesFromOcr(ocr, { w: 1000, h: 500 });
  const shot = new ScreenSnapshot({ jpeg: Buffer.from('jpg'), lines, size: { w: 1000, h: 500 }, app: null, controls: [] });
  const { host, sent } = fakeHost(shot);
  const look = await host.runTool('look_at_screen', '{}');
  assert.match(look.text, /mouse pointer is at @120,120, on W3 "changes"/);
  assert.strictEqual(look.image, Buffer.from('jpg').toString('base64'));
  assert.match((await host.runTool('point_at', '{"target_id":"W3"}')).text, /Pointing at "changes"/);
  assert.ok(sent.some((m) => m.type === 'mode' && m.mode === 'pinned' && m.x === 125 && Math.abs(m.y - 68) < 0.01));
  assert.match((await host.runTool('point_at', '{"target_id":"W99"}')).text, /No target W99/);
  assert.match((await host.runTool('focus_start', '{"task":"Essay","minutes":20}')).text, /Focus started: Essay, 20/);
  if (process.platform !== 'win32') assert.match((await host.runTool('click', '{"x":10,"y":10}')).text, /only works on Windows/);
  host.stopChoreography();
  const names = tools({ codex: true, computer: true }).map((t) => t.name);
  for (const n of ['look_at_screen', 'point_at', 'click', 'type_text', 'press_keys', 'scroll', 'drag', 'open_app', 'open_url', 'web_research', 'codex_start', 'focus_start', 'go_to_sleep']) assert.ok(names.includes(n), n);
  assert.match(host.instructions(), /Greenie/);
});

test('keyboard shortcuts map Mac names to Windows keys and refuse locking', () => {
  assert.deepStrictEqual(control.parseKeys('cmd+shift+t').keys, [0x11, 0x10, 0x54]);
  assert.deepStrictEqual(control.parseKeys('option+tab').keys, [0x12, 0x09]);
  assert.strictEqual(control.parseKeys('enter').label, '↩');
  assert.throws(() => control.press('win+l'), /won't press/);
  assert.throws(() => control.parseKeys('hyper+q'), /don't know/);
});

test('Codex: starts a job over JSON-RPC, approves, and reports when done', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bluey-home-'));
  const oldHome = process.env.HOME; const oldProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const codex = new CodexController({ getAdded: () => [], customPath: () => path.join(__dirname, 'fixtures', 'fake-codex.js') });
    const events = [];
    const finished = new Promise((resolve) => { codex.onEvent = (e) => { events.push(e); resolve(); }; });
    assert.match(codex.start(null, 'Make the README friendlier'), /Codex is on it \(Bluey\)/);
    await finished;
    assert.match(events[0].note, /Codex finished in Bluey.*Made the README friendlier/);
    assert.strictEqual(codex.jobs[0].status, 'done');
    assert.ok(fs.existsSync(path.join(home, 'Documents', 'Bluey', 'README.md')));
    assert.match(codex.status(), /Bluey: done/);
    assert.match(codex.start('nope', 'x'), /No project called "nope"/);
    codex.shutdown();
  } finally { process.env.HOME = oldHome; process.env.USERPROFILE = oldProfile; }
});

test('meeting notes are written as markdown', () => {
  const md = notes.markdown({ id: 'abcdef123', started: 1700000000, ended: 1700003600, entries: [
    { kind: 'transcript', speaker: 'A', time: 1700000010, text: 'Hello everyone' },
    { kind: 'asked', time: 1700000020, text: 'What is the plan?' }, { kind: 'reply', text: 'Ship it.' }] }, new Date(1700000000 * 1000));
  assert.match(md, /Speaker A:\*\* Hello everyone/);
  assert.match(md, /You asked Bluey:\*\* What is the plan\?/);
  assert.match(md, /\(1h 0m\)/);
});
