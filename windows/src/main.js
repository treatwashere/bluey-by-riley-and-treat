'use strict';
// Bluey for Windows: a tray app that pairs with the Bluey iPhone or Android app, runs focus sessions,
// watches the screen with the AI you choose (ChatGPT, Claude, Gemini, DeepSeek or all 4), and shows a little
// berry friend in your chosen colour (Bluey, Greenie, Reddie, Azure…) in the corner of the screen.
const path = require('path');
const os = require('os');
const {
  app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, screen, powerMonitor, safeStorage, desktopCapturer, clipboard,
} = require('electron');
const QRCode = require('qrcode');
const { Store } = require('./store');
const { Pairing } = require('./link');
const { PhoneServer } = require('./server');
const { FocusCompanion, clock, remaining } = require('./focus');
const { AI, TITLES, KEY_FOR } = require('./ai');
const { COLOURS, PROVIDERS, named, members } = require('./palette');
const { berryPNG } = require('./icon');
const capture = require('./capture');
const voice = require('./voice');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('co.visionairy.googly.windows');

let store; let server; let focus; let ai; let tray; let buddy; let settingsWindow;
let record; let awake = false; let bubble = null; let bubbleTimer = null;
const SETTABLE = ['colour', 'aiProvider', 'followMouse', 'showBuddy', 'phonePosition', 'claudeModel', 'geminiModel', 'deepseekModel', 'openaiDecisionModel', 'openaiModel'];
const KEYS = ['openai', 'anthropic', 'gemini', 'deepseek'];

const colour = () => named(store.get('colour')) || COLOURS[0];
const deviceName = () => os.hostname() || 'Windows PC';

function loadPairing() {
  record = store.readJSON(store.pairingFile, null);
  if (!record || !Pairing.key(record)) {
    record = Pairing.create(deviceName());
    store.writeJSON(store.pairingFile, record);
  }
}

// MARK: Speech bubble on the PC

function say(text, seconds = 8) {
  bubble = text ? String(text).slice(0, 280) : null;
  clearTimeout(bubbleTimer);
  if (bubble && seconds > 0) bubbleTimer = setTimeout(() => { bubble = null; pushBuddy(); }, seconds * 1000);
  pushBuddy();
}

// MARK: Phone requests

function handleRequest(packet, reply) {
  const command = packet.command;
  if (command.startsWith('focus')) {
    focus.heartbeat();
    let args = {};
    try { args = packet.text ? JSON.parse(packet.text) : {}; } catch {}
    let result = '';
    switch (command) {
      case 'focusStart': result = focus.start(args.task || '', Number(args.minutes ?? 30)); break;
      case 'focusPause': result = focus.pause(); break;
      case 'focusResume': result = focus.resume(); break;
      case 'focusEnd': result = focus.end(); break;
      case 'focusTestNudge': result = focus.testNudge(); break;
      case 'focusDeveloperMode':
        result = typeof args.developerMode === 'boolean' ? focus.setDeveloperMode(args.developerMode) : 'Specify whether Developer Mode is on or off.';
        break;
      case 'focusSync': focus.sync(); break;
      default: break;
    }
    if (command !== 'focusPing') reply({ command: 'focusReply', callID: packet.callID, text: result });
    return;
  }
  switch (command) {
    case 'colour': if (named(packet.text)) setSetting('colour', named(packet.text).id); break;
    case 'aiProvider': if (PROVIDERS.some((p) => p.id === packet.text)) setSetting('aiProvider', packet.text); break;
    case 'realtimeToken': {
      const s = focus.current && focus.current.status !== 'ended' ? focus.current : null;
      voice.mintToken(store.getKey('openai'), colour().name, s ? `Current focus task: ${s.task}. State: ${s.status}.` : null)
        .then((token) => reply({ command: 'realtimeToken', callID: packet.callID, text: token }))
        .catch((error) => { reply({ command: 'realtimeToken', callID: packet.callID }); say(error.message, 6); });
      break;
    }
    case 'tool': {
      let args = {};
      try { args = JSON.parse(packet.text || '{}'); } catch {}
      const text = voice.runTool(packet.tool || '', args, focus, (s) => clock(remaining(s)));
      reply({ command: 'toolResult', callID: packet.callID, text });
      break;
    }
    case 'caption': say((packet.text || '').trim() || null, 0); break;
    case 'captionDone': say(packet.text, 8); break;
    case 'awake': awake = true; refresh(); break;
    case 'asleep': awake = false; refresh(); break;
    // Meeting notes need the Mac app; tell the phone politely that there's nothing here.
    case 'transcribe': reply({ command: 'transcribed', callID: packet.callID }); break;
    case 'notes': reply({ command: 'notes', callID: packet.callID }); break;
    default: break;
  }
}

function setSetting(name, value) {
  if (!SETTABLE.includes(name)) return;
  store.set(name, value);
  if (name === 'colour') server.broadcast({ command: 'colour', text: value });
  if (name === 'aiProvider') server.broadcast({ command: 'aiProvider', text: value });
  refresh();
}

// MARK: Eyes follow the mouse

function gazeLoop() {
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const b = screen.getPrimaryDisplay().bounds;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    const follow = store.get('followMouse') !== false;
    const phoneX = b.x + b.width * (store.get('phonePosition') ?? 0.5);
    const face = {
      gazeX: follow ? clamp((p.x - phoneX) / (b.width / 2)) : 0,
      gazeY: follow ? clamp(-1 + 1.2 * (p.y - b.y) / b.height) : 0,
      mood: bubble ? 'happy' : 'listening',
      talk: 0,
    };
    server.sendFace(face);
    if (buddy && !buddy.isDestroyed() && buddy.isVisible()) {
      const w = buddy.getBounds(); const cx = w.x + 70; const cy = w.y + w.height - 70;
      buddy.webContents.send('gaze', { x: clamp((p.x - cx) / 400), y: clamp((p.y - cy) / 400) });
    }
  }, 50);
}

// MARK: Windows

function buddyState() {
  const s = focus.current && focus.current.status !== 'ended' ? focus.current : null;
  return {
    colour: colour(), bubble, show: store.get('showBuddy') !== false,
    countdown: s ? (s.status === 'paused' ? 'Ⅱ ' : '') + clock(remaining(s)) : null,
    developer: !!(s && s.developerMode), awake,
  };
}
function pushBuddy() {
  if (!buddy || buddy.isDestroyed() || buddy.webContents.isDestroyed()) return;
  const state = buddyState();
  buddy.webContents.send('state', state);
  if (state.show || state.countdown || state.bubble) buddy.showInactive(); else buddy.hide();
}

function createBuddy() {
  const area = screen.getPrimaryDisplay().workArea;
  buddy = new BrowserWindow({
    width: 480, height: 320, x: area.x + area.width - 500, y: area.y + area.height - 330,
    frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  buddy.setAlwaysOnTop(true, 'screen-saver');
  buddy.setIgnoreMouseEvents(true);
  buddy.setContentProtection(true); // never part of its own screenshots
  buddy.loadFile(path.join(__dirname, '..', 'renderer', 'buddy.html'));
  buddy.webContents.on('did-finish-load', pushBuddy);
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 900, height: 780, minWidth: 640, minHeight: 560, title: 'Bluey Settings', autoHideMenuBar: true,
    backgroundColor: '#15131c', icon: nativeImage.createFromBuffer(berryPNG(colour(), 64)),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  settingsWindow.setContentProtection(true); // the pairing QR never ends up in a screenshot
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
}

async function fullState() {
  return {
    settings: Object.fromEntries(SETTABLE.map((k) => [k, store.get(k)])),
    developerMode: focus.developerMode,
    keys: Object.fromEntries(KEYS.map((k) => [k, store.hasKey(k)])),
    colours: COLOURS, providers: PROVIDERS, active: ai.activeProviders(),
    phones: server.phoneNames, focus: focus.current, history: focus.history.slice(0, 10),
    pairing: { name: record.service, text: Pairing.qrText(record), qr: await QRCode.toDataURL(Pairing.qrText(record), { margin: 1, width: 280 }) },
  };
}

async function pushSettings() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  const state = await fullState();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('state', state);
}

// MARK: Tray

function buildMenu() {
  const s = focus.current && focus.current.status !== 'ended' ? focus.current : null;
  const phones = server.phoneNames;
  const items = [
    { label: phones.length ? `Phone connected: ${phones.join(', ')}` : 'Waiting for the phone app…', enabled: false },
    { label: 'Pair Phone (iPhone or Android)…', click: openSettings },
  ];
  if (s) {
    items.push({ label: `Focus: ${s.task.slice(0, 40)} · ${clock(remaining(s))}`, enabled: false });
    items.push(s.status === 'running' ? { label: 'Pause Focus', click: () => focus.pause() } : { label: 'Resume Focus', click: () => focus.resume() });
    items.push({ label: 'End Focus', click: () => focus.end() });
  }
  items.push(
    { label: 'Developer Mode (4× · checks every 10s)', type: 'checkbox', checked: focus.developerMode, click: () => focus.setDeveloperMode(!focus.developerMode) },
    { label: awake ? 'Go to Sleep' : 'Wake Up and Talk', enabled: phones.length > 0, click: () => server.broadcast({ command: awake ? 'sleep' : 'wake' }) },
    { type: 'separator' },
    { label: `Colour: ${colour().name}`, submenu: COLOURS.map((c) => ({
      label: c.name, type: 'radio', checked: c.id === colour().id,
      icon: nativeImage.createFromBuffer(berryPNG(c, 16)), click: () => setSetting('colour', c.id),
    })) },
    { label: `AI Brain: ${TITLES[store.get('aiProvider')]}`, submenu: PROVIDERS.map((p) => ({
      label: p.title + (members(p.id).some((m) => store.hasKey(KEY_FOR[m])) ? '' : ' (needs a key)'),
      type: 'radio', checked: store.get('aiProvider') === p.id, click: () => setSetting('aiProvider', p.id),
    })) },
    { label: 'Settings and AI Keys…', click: openSettings },
    { label: 'Eyes Follow My Mouse', type: 'checkbox', checked: store.get('followMouse') !== false, click: (i) => setSetting('followMouse', i.checked) },
    { label: 'Show Desktop Buddy', type: 'checkbox', checked: store.get('showBuddy') !== false, click: (i) => setSetting('showBuddy', i.checked) },
    { type: 'separator' },
    { label: 'Quit Bluey', click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

function refresh() {
  if (tray) {
    tray.setImage(nativeImage.createFromBuffer(berryPNG(colour(), 32)).resize({ width: 16, height: 16 }));
    tray.setToolTip(server.phoneNames.length ? `${colour().name} · phone connected` : `${colour().name} · waiting for the phone`);
    tray.setContextMenu(buildMenu());
  }
  pushBuddy();
  pushSettings();
}

// MARK: Startup

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'), safeStorage);
  loadPairing();
  ai = new AI(store);
  server = new PhoneServer(record, deviceName());
  focus = new FocusCompanion({
    now: () => performance.now() / 1000,
    hasKey: () => ai.hasAnyKey(),
    missingKey: () => ai.missingKeyMessage(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    capture: () => capture.snapshot(desktopCapturer, screen),
    classify: (shot, session, idle) => ai.classify(shot, session, idle),
    prepareNudge: (shot, task) => ai.nudge(shot, task, colour().name),
    historyFile: store.historyFile,
    developerMode: store.get('developerMode'),
    onSettings: (enabled) => store.set('developerMode', enabled),
    onChange: (sync) => { server.broadcast({ command: 'focusState', text: JSON.stringify(sync) }); refresh(); },
    onNudge: (message) => {
      server.broadcast({ command: 'focusChirp', text: message });
      say(message, 10);
    },
  });
  server.onPhonesChanged = (names) => { if (!names.length) focus.disconnected(); if (!names.length) awake = false; refresh(); };
  server.onAuthenticated = (send) => {
    send({ command: 'colour', text: colour().id });
    send({ command: 'aiProvider', text: store.get('aiProvider') });
  };
  server.onRequest = handleRequest;
  server.start();
  focus.startService();

  for (const event of ['lock-screen', 'suspend']) powerMonitor.on(event, () => focus.lock('Computer locked or sleeping. Resume when you\'re ready.'));
  for (const event of ['unlock-screen', 'resume']) powerMonitor.on(event, () => focus.unlock());

  tray = new Tray(nativeImage.createFromBuffer(berryPNG(colour(), 32)).resize({ width: 16, height: 16 }));
  tray.on('click', openSettings);
  createBuddy();
  gazeLoop();
  refresh();
  if (!ai.hasAnyKey() || process.argv.includes('--pair')) openSettings();
  // For README previews: BLUEY_CAPTURE_DIR=… saves pictures of both windows and quits.
  if (process.env.BLUEY_CAPTURE_DIR) {
    openSettings();
    setTimeout(async () => {
      const fs = require('fs');
      const dir = process.env.BLUEY_CAPTURE_DIR;
      fs.writeFileSync(path.join(dir, 'windows-settings.png'), (await settingsWindow.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(dir, 'windows-buddy.png'), (await buddy.webContents.capturePage()).toPNG());
      app.quit();
    }, Number(process.env.BLUEY_CAPTURE_DELAY || 4000));
  }

  ipcMain.handle('state', () => fullState());
  ipcMain.handle('set', (_e, name, value) => { setSetting(name, value); return fullState(); });
  ipcMain.handle('key', (_e, name, value) => { if (KEYS.includes(name)) store.setKey(name, value); refresh(); return fullState(); });
  ipcMain.handle('focus', (_e, command, args = {}) => {
    switch (command) {
      case 'start': return focus.start(args.task, Number(args.minutes));
      case 'pause': return focus.pause();
      case 'resume': return focus.resume();
      case 'end': return focus.end();
      case 'developer': return focus.setDeveloperMode(!!args.enabled);
      case 'testNudge': return focus.testNudge();
      default: return '';
    }
  });
  ipcMain.handle('pairing', (_e, action) => {
    if (action === 'copy') clipboard.writeText(Pairing.qrText(record));
    if (action === 'reset') {
      record = Pairing.create(deviceName());
      store.writeJSON(store.pairingFile, record);
      server.restart(record);
    }
    return fullState();
  });
});

app.on('window-all-closed', () => {}); // keeps running in the tray
app.on('second-instance', () => openSettings());
app.on('before-quit', () => { focus?.shutdown(); server?.stop(); });
