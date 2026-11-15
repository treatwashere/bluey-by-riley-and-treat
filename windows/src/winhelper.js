'use strict';
// Talks to winhelper.ps1: one Windows PowerShell process, started on first use and restarted if it quits.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class WinHelper {
  constructor(scriptDir) {
    this.scriptDir = scriptDir; this.proc = null; this.buffer = ''; this.nextId = 1; this.waiting = new Map();
  }
  get available() { return process.platform === 'win32'; }

  start() {
    if (this.proc || !this.available) return;
    // PowerShell can't run a script from inside Electron's app.asar, so a copy goes in the data folder.
    // UTF-8 with a byte-order mark, so Windows PowerShell 5.1 reads the script as UTF-8.
    const source = '\ufeff' + fs.readFileSync(path.join(__dirname, 'winhelper.ps1'), 'utf8').replace(/^\ufeff/, '');
    const script = path.join(this.scriptDir, 'winhelper.ps1');
    try { if (fs.readFileSync(script, 'utf8') !== source) throw new Error(); } catch { fs.writeFileSync(script, source); }
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        let reply; try { reply = JSON.parse(line); } catch { continue; }
        const done = this.waiting.get(reply.id);
        if (done) { this.waiting.delete(reply.id); done(reply); }
      }
    });
    this.proc.on('exit', () => {
      this.proc = null; this.buffer = '';
      for (const done of this.waiting.values()) done({ ok: false, error: 'The Windows helper stopped.' });
      this.waiting.clear();
    });
  }

  /** Sends one request; rejects with a readable message on failure or after `timeout` ms. */
  request(cmd, fields = {}, timeout = 15000) {
    if (!this.available) return Promise.reject(new Error('This needs Windows.'));
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('The Windows helper took too long.')); }, timeout);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.ok) resolve(reply); else reject(new Error(reply.error || 'The Windows helper failed.'));
      });
      this.proc.stdin.write(JSON.stringify(Object.assign({ id, cmd }, fields)) + '\n');
    });
  }

  /** OCR on an image buffer (PNG). Images bigger than Windows OCR's limit should be scaled first. */
  async ocr(png) {
    const file = path.join(os.tmpdir(), `bluey-ocr-${process.pid}.png`);
    fs.writeFileSync(file, png);
    try { return await this.request('ocr', { path: file }, 20000); } finally { fs.rmSync(file, { force: true }); }
  }

  stop() { try { this.proc?.kill(); } catch {} this.proc = null; }
}

module.exports = { WinHelper };
