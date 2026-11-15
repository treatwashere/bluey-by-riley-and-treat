'use strict';
// Lets Bluey use the PC when you ask (Mac/ComputerControl.swift for Windows): move and click the mouse,
// type, press shortcuts, scroll and drag, through Windows' own SendInput. Positions arrive in DIPs (the same
// units as the overlay) and are converted to physical pixels with Electron's screen.dipToScreenPoint.
let koffi = null;
let user32 = null;
const api = {};

function load() {
  if (user32 || process.platform !== 'win32') return !!user32;
  koffi = require('koffi');
  user32 = koffi.load('user32.dll');
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
  const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
  api.size = koffi.sizeof(INPUT);
  api.SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, _In_ INPUT *pInputs, int cbSize)');
  api.SetCursorPos = user32.func('int __stdcall SetCursorPos(int X, int Y)');
  api.GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *lpPoint)');
  api.GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
  api.MapVirtualKeyW = user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)');
  return true;
}

const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
const MOUSE = { MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010, WHEEL: 0x0800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000 };
const KEY = { EXTENDED: 0x0001, UP: 0x0002, UNICODE: 0x0004 };

let toPhysical = (p) => p;
let toDip = (p) => p;
/** Electron's screen module provides the DIP ↔ physical pixel mapping (per-monitor DPI). */
function useScreen(screen) {
  if (process.platform === 'win32' && screen.dipToScreenPoint) {
    toPhysical = (p) => screen.dipToScreenPoint({ x: Math.round(p.x), y: Math.round(p.y) });
    toDip = (p) => screen.screenToDipPoint(p);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (input) => api.SendInput(1, input, api.size);
const mouseInput = (flags, extra = {}) => send({ type: INPUT_MOUSE, u: { mi: Object.assign({ dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 }, extra) } });
const keyInput = (vk, flags, scan = 0) => send({ type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });

/** Where your own mouse pointer is, in DIPs. */
function mouseLocation(screen) {
  if (!load()) return screen ? screen.getCursorScreenPoint() : { x: 0, y: 0 };
  const point = {};
  api.GetCursorPos(point);
  return toDip(point);
}

/** Moves the pointer with a real mouse-move event (apps see hover and drags). */
function moveTo(dip) {
  const p = toPhysical(dip);
  const vx = api.GetSystemMetrics(76), vy = api.GetSystemMetrics(77), vw = api.GetSystemMetrics(78), vh = api.GetSystemMetrics(79);
  const nx = Math.round((p.x - vx) * 65535 / Math.max(1, vw - 1));
  const ny = Math.round((p.y - vy) * 65535 / Math.max(1, vh - 1));
  mouseInput(MOUSE.MOVE | MOUSE.ABSOLUTE | MOUSE.VIRTUALDESK, { dx: nx, dy: ny });
}

function warp(dip) {
  if (!load()) return;
  const p = toPhysical(dip);
  api.SetCursorPos(p.x, p.y);
}

async function click(dip, right = false, count = 1) {
  if (!load()) throw new Error('Clicking only works on Windows.');
  moveTo(dip);
  await sleep(30);
  for (let i = 0; i < count; i++) {
    mouseInput(right ? MOUSE.RIGHTDOWN : MOUSE.LEFTDOWN);
    await sleep(35);
    mouseInput(right ? MOUSE.RIGHTUP : MOUSE.LEFTUP);
    if (i < count - 1) await sleep(70);
  }
}

async function scroll(dx, dy, at) {
  if (!load()) throw new Error('Scrolling only works on Windows.');
  moveTo(at);
  await sleep(30);
  // Wheel units: 120 per notch, positive = up / right. dy > 0 means scroll down the page.
  const steps = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / 120));
  for (let i = 0; i < steps; i++) {
    if (dy) mouseInput(MOUSE.WHEEL, { mouseData: (dy > 0 ? -120 : 120) >>> 0 });
    if (dx) mouseInput(MOUSE.HWHEEL, { mouseData: (dx > 0 ? 120 : -120) >>> 0 });
    await sleep(16);
  }
}

function dragBegin(dip) { load(); moveTo(dip); mouseInput(MOUSE.LEFTDOWN); }
function dragMove(dip) { moveTo(dip); }
function dragEnd(dip) { moveTo(dip); mouseInput(MOUSE.LEFTUP); }

// MARK: Keyboard

const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B, windows: 0x5B, super: 0x5B, meta: 0x5B,
  return: 0x0D, enter: 0x0D, escape: 0x1B, esc: 0x1B, tab: 0x09, space: 0x20, backspace: 0x08,
  delete: 0x08, forwarddelete: 0x2E, del: 0x2E, insert: 0x2D,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  capslock: 0x14, printscreen: 0x2C, menu: 0x5D,
  minus: 0xBD, '-': 0xBD, equal: 0xBB, equals: 0xBB, '=': 0xBB, plus: 0xBB, comma: 0xBC, ',': 0xBC, period: 0xBE, '.': 0xBE,
  slash: 0xBF, '/': 0xBF, semicolon: 0xBA, ';': 0xBA, quote: 0xDE, "'": 0xDE, '[': 0xDB, ']': 0xDD, backslash: 0xDC, '\\': 0xDC, '`': 0xC0, grave: 0xC0,
};
for (let i = 1; i <= 24; i++) VK['f' + i] = 0x6F + i;
const EXTENDED = new Set([0x26, 0x28, 0x25, 0x27, 0x24, 0x23, 0x21, 0x22, 0x2D, 0x2E, 0x5B, 0x5D]);

/** "cmd+t" / "ctrl+shift+n" / "return" → virtual keys. Mac names map to their Windows partners. */
function parseKeys(text) {
  const parts = String(text || '').toLowerCase().replace(/\s+/g, '')
    .replace(/command|cmd|⌘/g, 'ctrl').replace(/option|opt|⌥/g, 'alt').replace(/⇧/g, 'shift').replace(/⌃/g, 'ctrl')
    .split('+').filter(Boolean);
  if (!parts.length) throw new Error('Which keys?');
  const keys = parts.map((p) => {
    if (VK[p] !== undefined) return VK[p];
    if (/^[a-z0-9]$/.test(p)) return p.toUpperCase().charCodeAt(0);
    throw new Error(`I don't know the key "${p}".`);
  });
  const pretty = { return: '↩', enter: '↩', escape: 'Esc', esc: 'Esc', up: '↑', down: '↓', left: '←', right: '→', win: 'Win', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  const label = parts.map((p) => pretty[p] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join('+');
  return { keys, label, normalized: parts.join('+') };
}

/** Logging out, locking and Task Manager are left to the user (like the Mac version's refused shortcuts). */
const REFUSED = new Set(['win+l', 'ctrl+alt+delete', 'ctrl+alt+del', 'ctrl+alt+forwarddelete', 'ctrl+shift+escape', 'ctrl+shift+esc', 'alt+f4+ctrl']);

function press(text) {
  const { keys, label, normalized } = parseKeys(text);
  if (REFUSED.has(normalized)) throw new Error("I won't press that one (it locks, logs out or opens Task Manager). Ask the user to do it.");
  if (!load()) throw new Error('Pressing keys only works on Windows.');
  for (const k of keys) keyInput(k, EXTENDED.has(k) ? KEY.EXTENDED : 0);
  for (const k of [...keys].reverse()) keyInput(k, (EXTENDED.has(k) ? KEY.EXTENDED : 0) | KEY.UP);
  return label;
}

function typeUnicode(text) {
  for (const unit of Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))) {
    keyInput(0, KEY.UNICODE, unit);
    keyInput(0, KEY.UNICODE | KEY.UP, unit);
  }
}

/** Short text types at a natural pace; long text goes in faster, a few characters at a time. */
async function type(text, onChunk = () => {}) {
  if (!load()) throw new Error('Typing only works on Windows.');
  const chars = [...text];
  const chunkSize = chars.length > 160 ? 6 : 1;
  const pause = chars.length > 160 ? 12 : 22;
  let chunk = '';
  for (const ch of chars) {
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      if (chunk) { typeUnicode(chunk); onChunk(chunk); chunk = ''; await sleep(pause); }
      if (ch === '\r') continue;
      const vk = ch === '\t' ? VK.tab : VK.return;
      keyInput(vk, 0); keyInput(vk, KEY.UP);
      await sleep(pause);
      continue;
    }
    chunk += ch;
    if ([...chunk].length >= chunkSize) { typeUnicode(chunk); onChunk(chunk); chunk = ''; await sleep(pause); }
  }
  if (chunk) { typeUnicode(chunk); onChunk(chunk); }
}

module.exports = { useScreen, mouseLocation, warp, click, scroll, dragBegin, dragMove, dragEnd, press, type, parseKeys, available: () => process.platform === 'win32' };
