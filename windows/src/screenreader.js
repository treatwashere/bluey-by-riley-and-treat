'use strict';
// Looks at the main display for his tools (Mac/ScreenReader.swift + ControlsReader.swift for Windows):
// a screenshot without Bluey's own windows, every line and word with its box (Windows OCR), and the front
// window's clickable controls (UI Automation). All boxes are in DIPs on the overlay, top-left origin.

class ScreenSnapshot {
  constructor({ jpeg, lines, size, app, controls }) {
    Object.assign(this, { jpeg, lines, size, app, controls });
  }

  target(id) {
    id = String(id || '').trim().toUpperCase();
    const control = this.controls.find((c) => c.id === id);
    if (control) return { id: control.id, text: control.label || control.kind, rect: control.rect };
    for (const entry of this.lines) {
      if (entry.line.id === id) return entry.line;
      const word = entry.words.find((w) => w.id === id);
      if (word) return word;
    }
    return null;
  }

  /** What's under (or right next to) a point: the smallest word, line or control there. */
  targetNear(p) {
    const candidates = this.controls.map((c) => ({ id: c.id, text: c.label || c.kind, rect: c.rect }));
    for (const entry of this.lines) candidates.push(entry.line, ...entry.words);
    const inside = (r) => p.x >= r.x - 6 && p.x <= r.x + r.w + 6 && p.y >= r.y - 6 && p.y <= r.y + r.h + 6;
    const hits = candidates.filter((c) => inside(c.rect)).sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
    if (hits.length) return hits[0];
    const distance = (r) => Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.w)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h)));
    const near = candidates.filter((c) => distance(c.rect) < 60).sort((a, b) => distance(a.rect) - distance(b.rect));
    return near[0] || null;
  }

  /** The list the model picks from. Coordinates are on a 0–1000 grid so it can relate them to the image. */
  get targetList() {
    const grid = (r) => `@${Math.round((r.x + r.w / 2) / this.size.w * 1000)},${Math.round((r.y + r.h / 2) / this.size.h * 1000)}`;
    const out = [];
    if (this.app) out.push(`Frontmost app: ${this.app}`);
    if (this.controls.length) {
      out.push('Controls (click these by id):');
      for (const c of this.controls) out.push(`${c.id} ${c.kind} ${grid(c.rect)}` + (c.label ? ` "${c.label}"` : ''));
    }
    out.push('Text on screen (L = line, W = word, @x,y on a 0-1000 grid):');
    if (!this.lines.length) out.push('(no text found)');
    for (const entry of this.lines) {
      const words = entry.words.length > 1 ? ' | ' + entry.words.map((w) => `${w.id}=${w.text}`).join(' ') : '';
      out.push(`${entry.line.id} ${grid(entry.line.rect)} "${entry.line.text}"${words}`);
    }
    return out.join('\n');
  }
}

/** Builds lines/words with ids from raw OCR (pixel boxes in an image of ocrW × ocrH) on a screen of size w × h. */
function linesFromOcr(ocr, size) {
  const sx = size.w / Math.max(1, ocr.width), sy = size.h / Math.max(1, ocr.height);
  const box = (r) => ({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy });
  const raw = (ocr.lines || []).map((l) => {
    const words = (l.words || []).map((w) => ({ text: w.text, rect: box(w) }));
    const xs = words.map((w) => w.rect.x), ys = words.map((w) => w.rect.y);
    const x2 = words.map((w) => w.rect.x + w.rect.w), y2 = words.map((w) => w.rect.y + w.rect.h);
    const rect = words.length ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...x2) - Math.min(...xs), h: Math.max(...y2) - Math.min(...ys) } : { x: 0, y: 0, w: 0, h: 0 };
    return { text: l.text, rect, words };
  }).filter((l) => l.text && l.text.trim());
  // Reading order: top to bottom, then left to right.
  raw.sort((a, b) => (Math.abs(a.rect.y - b.rect.y) > size.h * 0.01 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x));
  let wordCount = 0;
  return raw.slice(0, 400).map((l, i) => ({
    line: { id: `L${i + 1}`, text: l.text, rect: l.rect },
    words: wordCount < 600 ? l.words.map((w) => ({ id: `W${++wordCount}`, text: w.text, rect: w.rect })) : [],
  }));
}

class ScreenReader {
  /** electron: { desktopCapturer, screen }, helper: WinHelper, toDip: physical point → DIP point */
  constructor(electron, helper, toDip) { this.electron = electron; this.helper = helper; this.toDip = toDip; }

  async snapshot() {
    const { desktopCapturer, screen } = this.electron;
    const display = screen.getPrimaryDisplay();
    const size = { w: display.bounds.width, h: display.bounds.height };
    const physical = { width: Math.round(size.w * display.scaleFactor), height: Math.round(size.h * display.scaleFactor) };
    const controlsTask = this.helper.available ? this.helper.request('controls', {}, 4000).catch(() => ({ controls: [] })) : Promise.resolve({ controls: [] });
    const frontTask = this.helper.available ? this.helper.request('front', {}, 4000).catch(() => ({})) : Promise.resolve({});
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error("I can't see the screen. Check Windows privacy settings for screen capture.");
    const image = source.thumbnail;
    // Windows OCR reads images up to about 2600 px on a side.
    const { width, height } = image.getSize();
    const ocrScale = Math.min(1, 2560 / Math.max(width, height));
    const ocrImage = ocrScale < 1 ? image.resize({ width: Math.round(width * ocrScale), quality: 'best' }) : image;
    let lines = [];
    if (this.helper.available) {
      try { lines = linesFromOcr(await this.helper.ocr(ocrImage.toPNG()), size); } catch { lines = []; }
    }
    const controlsRaw = (await controlsTask).controls || [];
    const controls = controlsRaw.map((c, i) => {
      const a = this.toDip({ x: Math.round(c.x), y: Math.round(c.y) });
      const b = this.toDip({ x: Math.round(c.x + c.w), y: Math.round(c.y + c.h) });
      return { id: `C${i + 1}`, kind: c.kind, label: String(c.label || '').slice(0, 80), rect: { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y } };
    }).filter((c) => c.rect.x < size.w && c.rect.y < size.h && c.rect.x + c.rect.w > 0 && c.rect.y + c.rect.h > 0);
    const front = await frontTask;
    const jpegScale = Math.min(1, 1100 / Math.max(width, height));
    const small = jpegScale < 1 ? image.resize({ width: Math.round(width * jpegScale), quality: 'best' }) : image;
    return new ScreenSnapshot({
      jpeg: small.toJPEG(72), lines, size,
      app: front.app ? `${front.app}${front.title ? ` (${front.title})` : ''}` : null, controls,
    });
  }
}

module.exports = { ScreenReader, ScreenSnapshot, linesFromOcr };
