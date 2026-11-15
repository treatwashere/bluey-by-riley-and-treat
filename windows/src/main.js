'use strict';
// Bluey for Windows: does what the Mac app does. A tray app with Bluey's googly-eyed cursor flying over the
// screen, pairing with the Bluey iPhone or Android app, focus sessions watched by the AI you choose (ChatGPT,
// Claude, Gemini, DeepSeek or all 4), and, when you talk to him on an iPhone, his tools: look at the screen,
// point, click, type, press keys, scroll, drag, open apps and websites, research, Codex and meeting notes.
const path = require('path');
const os = require('os');
const {
  app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, screen, powerMonitor, safeStorage, desktopCapturer, clipboard,
  globalShortcut, shell, dialog,
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
const control = require('./control');
const { WinHelper } = require('./winhelper');
const { ScreenReader } = require('./screenreader');
const { RealtimeHost } = require('./host');
const { CodexController, codexLine } = require('./codex');
const notes = require('./notes');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('co.visionairy.googly.windows');

let store; let server; let focus; let ai; let tray; let overlayWindow; let settingsWindow; let reportWindow;
let record; let helper; let reader; let host; let codex;
const SETTABLE = ['colour', 'aiProvider', 'followMouse', 'showCursor', 'phonePosition', 'cursorSize', 'trail', 'mood', 'computerControl',
  'personality', 'codexPath', 'codexFolders', 'claudeModel', 'geminiModel', 'deepseekModel', 'openaiDecisionModel', 'openaiModel'];
const KEYS = ['openai', 'anthropic', 'gemini', 'deepseek'];
const MOODS = ['listening', 'resting', 'thinking', 'happy'];

const colour = () => named(store.get('colour')) || COLOURS[0];
const deviceName = () => os.hostname() || 'Windows PC';

function loadPairing() {
  record = store.readJSON(store.pairingFile, null);
  if (!record || !Pairing.key(record)) {
    record = Pairing.create(deviceName());
    store.writeJSON(store.pairingFile, record);
  }
}

// MARK: The cursor overlay (a click-through window over the whole main screen)

const overlay = {
  state: { tip: { x: 0, y: 0 }, arriveIn: 0, isHome: true, opacity: 0 },
  frames: [],
  send(message) {
    if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.webContents.isDestroyed()) overlayWindow.webContents.send('overlay', message);
  },
  /** Resolves after the overlay has drawn a frame that saw the latest message. */
  waitForFrame() {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 200);
      this.frames.push(() => setTimeout(() => { clearTimeout(timer); resolve(); }, 40));
    });
  },
};

function overlaySettings() {
  overlay.send({ type: 'settings', settings: {
    colour: colour(), size: Number(store.get('cursorSize')) || 72, trail: store.get('trail') || 'comet',
    showCursor: store.get('showCursor') !== false, followMouse: store.get('followMouse') !== false,
    phonePosition: Number(store.get('phonePosition') ?? 0.5), mood: store.get('mood') || 'listening',
  } });
}

function createOverlay() {
  const display = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    ...display.bounds, frame: false, transparent: true, resizable: false, movable: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false, enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setContentProtection(true); // like the Mac: never part of his own screenshots
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlayWindow.webContents.on('did-finish-load', () => {
    overlaySettings();
    host.goHomeNow();
    overlayWindow.showInactive();
    pushCountdown();
  });
  const fit = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.setBounds(screen.getPrimaryDisplay().bounds);
    pushCountdown();
  };
  screen.on('display-metrics-changed', fit);
  screen.on('display-added', fit);
  screen.on('display-removed', fit);
  // Your mouse, for his eyes and for dozing off when it sits still.
  setInterval(() => {
    const p = screen.getCursorScreenPoint(); const b = screen.getPrimaryDisplay().bounds;
    overlay.send({ type: 'mouse', x: p.x - b.x, y: p.y - b.y });
  }, 16);
}

/** The focus countdown in the bottom-right corner, above the taskbar (the Mac's countdown panel). */
function pushCountdown() {
  const s = focus?.current && focus.current.status !== 'ended' ? focus.current : null;
  const d = screen.getPrimaryDisplay();
  overlay.send({
    type: 'countdown', text: s ? (s.status === 'paused' ? 'Ⅱ ' : '') + clock(remaining(s)) : '',
    mode: s && s.developerMode ? 'DEVELOPER MODE · 4×' : '',
    right: (d.bounds.x + d.bounds.width) - (d.workArea.x + d.workArea.width) + 32,
    bottom: (d.bounds.y + d.bounds.height) - (d.workArea.y + d.workArea.height) + 24,
  });
}

// MARK: The research card

const reportState = { question: '', report: null, error: null, expanded: false };
function pushReport() {
  if (!reportWindow || reportWindow.isDestroyed()) return;
  const r = reportState.report;
  reportWindow.webContents.send('report', { ...reportState, colour: colour(), report: r ? { title: r.title, paragraphs: r.paragraphs, sources: r.sources } : null });
  const area = screen.getPrimaryDisplay().workArea;
  const width = reportState.expanded ? 520 : 400;
  let height = r ? 190 : 140;
  if (reportState.expanded && r) {
    const lines = r.paragraphs.reduce((n, p) => n + Math.ceil(p.length / 58), 0);
    height = Math.min(area.height * 0.75, 110 + lines * 21 + r.paragraphs.length * 12 + (r.sources.length ? 30 + r.sources.length * 22 : 0));
  }
  reportWindow.setBounds({ x: area.x + area.width - width - 24, y: area.y + 24, width: Math.round(width), height: Math.round(height) });
  reportWindow.showInactive();
}
function ensureReportWindow() {
  if (reportWindow && !reportWindow.isDestroyed()) return Promise.resolve();
  reportWindow = new BrowserWindow({
    width: 400, height: 140, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true,
    hasShadow: false, show: false, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  reportWindow.setAlwaysOnTop(true, 'screen-saver', 1); // above his cursor
  reportWindow.setContentProtection(true);
  return new Promise((resolve) => {
    reportWindow.webContents.once('did-finish-load', resolve);
    reportWindow.loadFile(path.join(__dirname, '..', 'renderer', 'report.html'));
  });
}
const reports = {
  loading(question) { Object.assign(reportState, { question, report: null, error: null, expanded: false }); ensureReportWindow().then(pushReport); },
  show(report) { Object.assign(reportState, { report, error: null }); ensureReportWindow().then(pushReport); },
  error(message) { Object.assign(reportState, { error: message }); ensureReportWindow().then(pushReport); },
};

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
  if (command === 'colour') { if (named(packet.text)) setSetting('colour', named(packet.text).id); return; }
  if (command === 'aiProvider') { if (PROVIDERS.some((p) => p.id === packet.text)) setSetting('aiProvider', packet.text); return; }
  host.handle(packet, reply);
}

function setSetting(name, value) {
  if (!SETTABLE.includes(name)) return;
  store.set(name, value);
  if (name === 'colour') server.broadcast({ command: 'colour', text: value });
  if (name === 'aiProvider') server.broadcast({ command: 'aiProvider', text: value });
  if (name === 'followMouse') host.goHomeNow();
  if (name === 'computerControl' || name === 'personality') restartIfAwake();
  overlaySettings();
  refresh();
}

/** Wakes him again so a new personality or set of tools takes effect right away. */
function restartIfAwake() {
  if (!host.awake) return;
  server.broadcast({ command: 'sleep' });
  setTimeout(() => server.broadcast({ command: 'wake' }), 1000);
}

/** A Codex job finished. Awake, he hears about it and says so himself; asleep, the bubble shows here and the phone chirps. */
async function codexEvent(event) {
  if (host.awake && server.phoneNames.length) { server.broadcast({ command: 'codexNote', text: event.note }); return; }
  const text = (await codexLine(store.getKey('openai'), host.personality, event.note)) || event.line;
  host.showReply(text);
  server.broadcast({ command: 'codexChirp', text });
}

// MARK: Settings window

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 940, height: 820, minWidth: 640, minHeight: 560, title: 'Bluey Settings', autoHideMenuBar: true,
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
    colours: COLOURS, providers: PROVIDERS, active: ai.activeProviders(), moods: MOODS,
    phones: server.phoneNames, focus: focus.current, history: focus.history.slice(0, 10),
    awake: host.awake, windows: process.platform === 'win32', codexInstalled: codex.isInstalled,
    codexJobs: codex.jobs.slice(-6).reverse().map((j) => ({ project: j.project, status: j.status, prompt: j.prompt.slice(0, 80) })),
    defaultPersonality: require('./host').DEFAULT_PERSONALITY(colour().name), notesFolder: notes.root(),
    pairing: { name: record.service, text: Pairing.qrText(record), qr: await QRCode.toDataURL(Pairing.qrText(record), { margin: 1, width: 280 }) },
  };
}

async function pushSettings() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  const state = await fullState();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('state', state);
}

// MARK: Tray menu (the Mac's menu bar menu)

function buildMenu() {
  const s = focus.current && focus.current.status !== 'ended' ? focus.current : null;
  const phones = server.phoneNames;
  const radio = (label, checked, click) => ({ label, type: 'radio', checked, click });
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
    { label: host.awake ? 'Go to Sleep (Follow Mode)' : 'Wake Up and Talk', accelerator: 'Ctrl+Alt+Space', enabled: phones.length > 0, click: toggleAwake },
    { type: 'separator' },
    { label: 'Let Him Use the Computer', type: 'checkbox', checked: store.get('computerControl') !== false, click: (i) => setSetting('computerControl', i.checked) },
    { label: 'Stop Him', accelerator: 'Ctrl+Alt+S', click: stopActions },
    { type: 'separator' },
    { label: 'Point Here', accelerator: 'Ctrl+Alt+P', click: pointHere },
    { label: 'Eyes Follow My Mouse', accelerator: 'Ctrl+Alt+F', type: 'checkbox', checked: store.get('followMouse') !== false, click: (i) => setSetting('followMouse', i.checked) },
    { label: 'Stop Pointing', accelerator: 'Ctrl+Alt+D', click: () => host.goHome() },
    { label: 'Talk Test', accelerator: 'Ctrl+Alt+T', click: () => overlay.send({ type: 'talkTest', seconds: 3 }) },
    { type: 'separator' },
    { label: 'Mood', submenu: MOODS.map((m) => radio(m[0].toUpperCase() + m.slice(1), (store.get('mood') || 'listening') === m, () => setSetting('mood', m))) },
    { label: 'Cursor Size', submenu: [['Small', 48], ['Medium', 72], ['Large', 96], ['Huge', 120]].map(([n, v]) => radio(`${n} (${v} pt)`, (Number(store.get('cursorSize')) || 72) === v, () => setSetting('cursorSize', v))) },
    { label: 'Phone Sits Under', submenu: [['Left', 0.2], ['Center', 0.5], ['Right', 0.8]].map(([n, v]) => radio(n, Math.abs((store.get('phonePosition') ?? 0.5) - v) < 0.01, () => setSetting('phonePosition', v))) },
    { label: 'Pointer Trail', submenu: [['Comet Trail', 'comet'], ['String to the Phone', 'string'], ['No Trail', 'none']].map(([n, v]) => radio(n, (store.get('trail') || 'comet') === v, () => setSetting('trail', v))) },
    { label: 'Show Cursor', accelerator: 'Ctrl+Alt+H', type: 'checkbox', checked: store.get('showCursor') !== false, click: (i) => setSetting('showCursor', i.checked) },
    { type: 'separator' },
    { label: `Colour: ${colour().name}`, submenu: COLOURS.map((c) => ({
      label: c.name, type: 'radio', checked: c.id === colour().id, icon: nativeImage.createFromBuffer(berryPNG(c, 16)), click: () => setSetting('colour', c.id),
    })) },
    { label: `AI Brain: ${TITLES[store.get('aiProvider')]}`, submenu: PROVIDERS.map((p) => radio(
      p.title + (members(p.id).some((m) => store.hasKey(KEY_FOR[m])) ? '' : ' (needs a key)'), store.get('aiProvider') === p.id, () => setSetting('aiProvider', p.id))) },
  );
  if (codex.isInstalled) {
    items.push({ label: codex.jobs.some((j) => j.status === 'working') ? 'Codex (working)' : 'Codex', submenu: [
      ...codex.jobs.slice(-8).reverse().map((j) => ({ label: `${j.project}: ${j.prompt.slice(0, 40)} (${j.status})`, click: () => shell.openExternal(`codex://threads/${j.threadID}`).catch(() => {}) })),
      ...(codex.jobs.length ? [{ type: 'separator' }] : []),
      { label: 'Add Project Folder…', click: addCodexFolder },
    ] });
  }
  items.push(
    { label: 'Open Meeting Notes', click: () => { require('fs').mkdirSync(notes.root(), { recursive: true }); shell.openPath(notes.root()); } },
    { label: 'Settings, Personality and AI Keys…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit Bluey', click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

async function addCodexFolder() {
  const result = await dialog.showOpenDialog({ title: 'Folders Codex can work in when you ask Bluey', properties: ['openDirectory', 'multiSelections'], buttonLabel: 'Add' });
  if (result.canceled) return;
  const added = store.get('codexFolders') || [];
  setSetting('codexFolders', [...added, ...result.filePaths.filter((p) => !added.includes(p))]);
}

function toggleAwake() { server.broadcast({ command: host.awake ? 'sleep' : 'wake' }); }
function stopActions() { focus.pause('Stopped with Ctrl+Alt+S'); host.stopActions(); codex.stopAll().catch(() => {}); }
function pointHere() {
  const p = screen.getCursorScreenPoint(); const b = screen.getPrimaryDisplay().bounds;
  host.mode({ mode: 'pinned', x: p.x - b.x, y: p.y - b.y });
}

function refresh() {
  if (tray) {
    tray.setImage(nativeImage.createFromBuffer(berryPNG(colour(), 32)).resize({ width: 16, height: 16 }));
    tray.setToolTip(server.phoneNames.length ? `${colour().name} · phone connected` : `${colour().name} · waiting for the phone`);
    tray.setContextMenu(buildMenu());
  }
  pushCountdown();
  pushSettings();
}

// MARK: Startup

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'), safeStorage);
  for (const [k, v] of Object.entries({ computerControl: true, showCursor: true, trail: 'comet', cursorSize: 72, phonePosition: 0.5, mood: 'listening', codexFolders: [] })) {
    if (store.get(k) === undefined) store.set(k, v);
  }
  loadPairing();
  control.useScreen(screen);
  helper = new WinHelper(app.getPath('userData'));
  reader = new ScreenReader({ desktopCapturer, screen }, helper, (p) => (screen.screenToDipPoint ? screen.screenToDipPoint(p) : p));
  ai = new AI(store);
  server = new PhoneServer(record, deviceName());
  codex = new CodexController({ getAdded: () => store.get('codexFolders') || [], customPath: () => store.get('codexPath') });
  codex.onEvent = codexEvent;
  codex.onChange = refresh;
  focus = new FocusCompanion({
    now: () => performance.now() / 1000,
    hasKey: () => ai.hasAnyKey(),
    missingKey: () => ai.missingKeyMessage(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    // Focus checks see the same screen text he does (OCR), plus the window title.
    capture: async () => {
      if (!helper.available) return capture.snapshot(desktopCapturer, screen);
      const shot = await reader.snapshot();
      return { jpeg: shot.jpeg, app: shot.app, title: '', text: shot.lines.slice(0, 140).map((l) => l.line.text).join('\n') };
    },
    classify: (shot, session, idle) => ai.classify(shot, session, idle),
    prepareNudge: (shot, task) => ai.nudge(shot, task, colour().name),
    historyFile: store.historyFile,
    developerMode: store.get('developerMode'),
    onSettings: (enabled) => store.set('developerMode', enabled),
    onChange: (sync) => { server.broadcast({ command: 'focusState', text: JSON.stringify(sync) }); refresh(); },
    onNudge: (message) => {
      host.focusNudge(message);
      server.broadcast({ command: 'focusChirp', text: message });
    },
  });
  host = new RealtimeHost({ overlay, store, focus, codex, reader, helper, reports, screen,
    colourName: () => colour().name, openExternal: (url) => shell.openExternal(url) });
  host.onChange = refresh;

  server.onPhonesChanged = (names) => {
    if (!names.length) { focus.disconnected(); if (host.awake) host.setAwake(false); }
    refresh();
  };
  server.onAuthenticated = (send) => {
    send({ command: 'colour', text: colour().id });
    send({ command: 'aiProvider', text: store.get('aiProvider') });
  };
  server.onRequest = handleRequest;
  server.start();
  focus.startService();
  codex.warmUp();

  for (const event of ['lock-screen', 'suspend']) powerMonitor.on(event, () => focus.lock("Computer locked or sleeping. Resume when you're ready."));
  for (const event of ['unlock-screen', 'resume']) powerMonitor.on(event, () => focus.unlock());

  tray = new Tray(nativeImage.createFromBuffer(berryPNG(colour(), 32)).resize({ width: 16, height: 16 }));
  tray.on('click', () => tray.popUpContextMenu());
  tray.on('double-click', openSettings);
  createOverlay();
  refresh();

  // The Mac's hotkeys, with Ctrl+Alt instead of ⌃⌥ (and Ctrl+Alt+Space instead of ⌥Space).
  const keys = { 'Ctrl+Alt+Space': toggleAwake, 'Ctrl+Alt+P': pointHere, 'Ctrl+Alt+F': () => setSetting('followMouse', store.get('followMouse') === false),
    'Ctrl+Alt+D': () => host.goHome(), 'Ctrl+Alt+H': () => setSetting('showCursor', store.get('showCursor') === false),
    'Ctrl+Alt+T': () => overlay.send({ type: 'talkTest', seconds: 3 }), 'Ctrl+Alt+S': stopActions };
  for (const [accel, fn] of Object.entries(keys)) { try { globalShortcut.register(accel, fn); } catch {} }

  if (!ai.hasAnyKey() || process.argv.includes('--pair')) openSettings();

  ipcMain.on('overlay-state', (_e, state) => {
    overlay.state = state;
    if (state.face) server.sendFace(state.face);
    const waiting = overlay.frames; overlay.frames = [];
    for (const done of waiting) done();
  });
  ipcMain.on('report-action', (_e, action, url) => {
    if (action === 'close') reportWindow?.hide();
    if (action === 'toggle') { reportState.expanded = !reportState.expanded; pushReport(); }
    if (action === 'open' && /^https?:\/\//.test(String(url))) shell.openExternal(url);
  });
  ipcMain.handle('state', () => fullState());
  ipcMain.handle('set', (_e, name, value) => { setSetting(name, value); return fullState(); });
  ipcMain.handle('key', (_e, name, value) => { if (KEYS.includes(name)) store.setKey(name, value); refresh(); return fullState(); });
  ipcMain.handle('action', (_e, action) => {
    if (action === 'wake') toggleAwake();
    if (action === 'stop') stopActions();
    if (action === 'notes') { require('fs').mkdirSync(notes.root(), { recursive: true }); shell.openPath(notes.root()); }
    if (action === 'codexFolder') addCodexFolder();
    if (action === 'talkTest') overlay.send({ type: 'talkTest', seconds: 3 });
    return fullState();
  });
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

  // For README previews: BLUEY_CAPTURE_DIR=… saves pictures of the windows and quits.
  if (process.env.BLUEY_CAPTURE_DIR) {
    openSettings();
    setTimeout(async () => {
      const fs = require('fs');
      const dir = process.env.BLUEY_CAPTURE_DIR;
      fs.writeFileSync(path.join(dir, 'windows-settings.png'), (await settingsWindow.webContents.capturePage()).toPNG());
      fs.writeFileSync(path.join(dir, 'windows-overlay.png'), (await overlayWindow.webContents.capturePage()).toPNG());
      app.quit();
    }, Number(process.env.BLUEY_CAPTURE_DELAY || 4000));
  }
});

app.on('window-all-closed', () => {}); // keeps running in the tray
app.on('second-instance', () => openSettings());
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => { focus?.shutdown(); server?.stop(); helper?.stop(); codex?.shutdown(); });
