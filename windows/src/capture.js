'use strict';
// One screenshot of the main display, kept in memory only, plus the foreground app and window title.
// Bluey's own windows use setContentProtection, so Windows leaves them out of the capture.
const { execFile } = require('child_process');

const FOREGROUND_SCRIPT = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class BlueyW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@
$h=[BlueyW]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 512
[void][BlueyW]::GetWindowText($h,$sb,512); $p=0; [void][BlueyW]::GetWindowThreadProcessId($h,[ref]$p)
$n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
@{app=$n;title=$sb.ToString()} | ConvertTo-Json -Compress
`;

function foreground() {
  if (process.platform !== 'win32') return Promise.resolve({});
  const encoded = Buffer.from(FOREGROUND_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 4000, windowsHide: true }, (error, stdout) => {
        if (error) { resolve({}); return; }
        try {
          const json = JSON.parse(String(stdout).trim());
          resolve({ app: String(json.app || '').slice(0, 120), title: String(json.title || '').slice(0, 300) });
        } catch { resolve({}); }
      });
  });
}

async function snapshot(desktopCapturer, screen) {
  const display = screen.getPrimaryDisplay();
  const scale = Math.min(1, 1600 / display.size.width);
  const size = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
  const [sources, fg] = await Promise.all([desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size }), foreground()]);
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    const error = new Error('Screen capture is unavailable. Check Windows privacy settings, then resume.');
    error.needsUser = true;
    throw error;
  }
  return { jpeg: source.thumbnail.toJPEG(70), app: fg.app, title: fg.title };
}

module.exports = { snapshot, foreground };
