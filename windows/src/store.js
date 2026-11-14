'use strict';
// Settings (plain JSON) and API keys (encrypted with Windows DPAPI through Electron's safeStorage when
// available) in the app's private data folder. Nothing here is ever sent to the phone.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.safe = safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.settingsFile = path.join(dir, 'settings.json');
    this.keysFile = path.join(dir, 'keys.json');
    this.pairingFile = path.join(dir, 'pairing.json');
    this.historyFile = path.join(dir, 'focus-history.json');
    this.settings = Object.assign({
      colour: 'bluey', aiProvider: 'chatgpt', developerMode: false, followMouse: true, showBuddy: true,
      claudeModel: 'claude-opus-5-5', geminiModel: 'gemini-flash-latest', deepseekModel: 'deepseek-chat',
      openaiDecisionModel: 'gpt-6-luna', openaiModel: 'gpt-5.5',
    }, this.readJSON(this.settingsFile, {}));
    this.keys = this.readJSON(this.keysFile, {});
  }
  readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  writeJSON(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  }
  get(name) { return this.settings[name]; }
  set(name, value) { this.settings[name] = value; this.writeJSON(this.settingsFile, this.settings); }

  /// Key names: openai, anthropic, gemini, deepseek.
  getKey(name) {
    const stored = this.keys[name];
    if (!stored) return null;
    try {
      if (stored.startsWith('dpapi:') && this.safe) return this.safe.decryptString(Buffer.from(stored.slice(6), 'base64'));
      if (stored.startsWith('plain:')) return stored.slice(6);
    } catch { return null; }
    return null;
  }
  setKey(name, value) {
    const clean = (value || '').trim();
    if (!clean) delete this.keys[name];
    else this.keys[name] = this.safe ? 'dpapi:' + this.safe.encryptString(clean).toString('base64') : 'plain:' + clean;
    this.writeJSON(this.keysFile, this.keys);
  }
  hasKey(name) { return !!this.getKey(name); }
}

module.exports = { Store };
