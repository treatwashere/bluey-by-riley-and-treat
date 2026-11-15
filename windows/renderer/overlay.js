'use strict';
// Bluey's cursor on Windows: a line-by-line port of Mac/Sources/GooglyMac/CursorOverlay.swift.
// A click-through, transparent window over the main screen. The googly-eyed teardrop cursor flies along
// gentle curves, points at things, squishes when it clicks, trails a comet (or a string to the phone),
// shows typed letters and labels, and talks in a speech bubble. Coordinates: top-left origin, y down, DIPs.

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const DISPLAY = 'Fredoka, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';

const settings = {
  colour: { berry: ['#A9BCFF', '#6C86F5', '#4254D6', '#2B2F8F'], nose: '#1C1F66' },
  size: 72, trail: 'comet', showCursor: true, followMouse: true, phonePosition: 0.5, mood: 'listening',
};
const INK = '#17151F';
const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const rand = (a, b) => a + Math.random() * (b - a);
const now = () => performance.now() / 1000;

// MARK: Motion

/** A CSS-style cubic-bezier timing curve: maps time (0…1) to progress (0…1). */
class TimingCurve {
  constructor(x1, y1, x2, y2) { Object.assign(this, { x1, y1, x2, y2 }); }
  coord(t, a, b) { const u = 1 - t; return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t; }
  deriv(t, a, b) { const u = 1 - t; return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b); }
  parameter(x) {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = this.coord(t, this.x1, this.x2) - x;
      if (Math.abs(error) < 1e-7) return t;
      const d = this.deriv(t, this.x1, this.x2);
      if (Math.abs(d) < 1e-7) break;
      t -= error / d;
    }
    let low = 0, high = 1; t = x;
    for (let i = 0; i < 40; i++) {
      const v = this.coord(t, this.x1, this.x2);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) low = t; else high = t;
      t = (low + high) / 2;
    }
    return t;
  }
  value(x) { if (x <= 0) return 0; if (x >= 1) return 1; return this.coord(this.parameter(x), this.y1, this.y2); }
  rate(x) {
    const t = this.parameter(Math.min(Math.max(x, 0), 1));
    const dx = this.deriv(t, this.x1, this.x2), dy = this.deriv(t, this.y1, this.y2);
    return dx > 1e-7 ? dy / dx : 0;
  }
}
TimingCurve.launch = new TimingCurve(0.42, 0, 0.22, 1);
TimingCurve.redirect = new TimingCurve(0.25, 0.25, 0.22, 1);
TimingCurve.steady = new TimingCurve(0.42, 0, 0.38, 1);

class Flight {
  constructor(from, c1, c2, to, start, duration, timing, pointing) {
    Object.assign(this, { from, c1, c2, to, start, duration, timing, pointing, landed: false });
  }
  progress(t) { return this.duration <= 0 ? 1 : Math.min(1, Math.max(0, (t - this.start) / this.duration)); }
  position(e) {
    const u = 1 - e, a = u * u * u, b = 3 * u * u * e, c = 3 * u * e * e, d = e * e * e;
    return { x: a * this.from.x + b * this.c1.x + c * this.c2.x + d * this.to.x, y: a * this.from.y + b * this.c1.y + c * this.c2.y + d * this.to.y };
  }
  tangent(e) {
    const u = 1 - e, a = 3 * u * u, b = 6 * u * e, c = 3 * e * e;
    return { x: a * (this.c1.x - this.from.x) + b * (this.c2.x - this.c1.x) + c * (this.to.x - this.c2.x),
      y: a * (this.c1.y - this.from.y) + b * (this.c2.y - this.c1.y) + c * (this.to.y - this.c2.y) };
  }
}

/** Where the cursor is and how it moves (CursorEngine in the Mac app). */
class CursorEngine {
  constructor() {
    this.mode = { kind: 'following' };
    this.tip = { x: -1000, y: -1000 }; this.velocity = { x: 0, y: 0 };
    this.angle = Math.PI / 4; this.angleVelocity = 0; this.opacity = 0;
    this.flight = null; this.placed = false; this.bounds = { w: 1440, h: 900 };
    this.dragging = false; this.landedAt = -10; this.pressStart = -10; this.pressDepth = 0;
    this.talkUntil = 0; this.brainMood = null; this.gazeOverride = null; this.awake = false;
    this.mouse = { x: 0, y: 0 }; this.lastMouseMove = now(); this.talkLevel = 0;
    this.blinkUntil = 0; this.nextBlink = now() + 3;
    this.onLand = () => {}; this.onLaunch = () => {};
  }
  get size() { return settings.size; }
  get isHome() { return this.mode.kind !== 'pinned'; }
  phonePoint(b) { return { x: b.w * settings.phonePosition, y: b.h + b.h * 0.18 }; }
  dockPoint(b) { return { x: b.w * settings.phonePosition, y: b.h - this.size * 0.42 }; }
  tuckedPoint(b) { return { x: b.w * settings.phonePosition, y: b.h + this.size * 0.35 }; }
  goal() {
    if (this.mode.kind === 'docked') return this.dockPoint(this.bounds);
    if (this.mode.kind === 'following') return this.tuckedPoint(this.bounds);
    return { x: this.mode.x, y: this.mode.y };
  }
  timeToArrive(t) { return this.flight ? Math.max(0, this.flight.start + this.flight.duration - t) : 0; }
  press(depth, at = now()) { this.pressStart = at; this.pressDepth = depth; }

  step(dt, t, mouse, bounds) {
    this.bounds = bounds;
    if (Math.hypot(mouse.x - this.mouse.x, mouse.y - this.mouse.y) > 1.5) this.lastMouseMove = t;
    this.mouse = mouse;
    if (!this.placed) { this.tip = this.tuckedPoint(bounds); this.placed = true; }
    const target = this.goal();
    const needsPlan = this.flight ? Math.hypot(this.flight.to.x - target.x, this.flight.to.y - target.y) > 0.5
      : Math.hypot(this.tip.x - target.x, this.tip.y - target.y) > 0.5;
    if (needsPlan) this.plan(target, t);
    this.advance(t);

    const settled = (this.flight ? this.flight.progress(t) : 1) >= 1;
    const wantOpacity = this.mode.kind === 'following' && settled ? 0 : 1;
    const rate = wantOpacity > this.opacity ? 12 : 6;
    this.opacity += (wantOpacity - this.opacity) * Math.min(1, dt * rate);

    const lean = Math.max(-0.2, Math.min(0.2, this.velocity.x / 2800));
    const targetAngle = (this.isHome ? Math.PI / 4 : 0) + lean;
    const k = 24;
    this.angleVelocity += (k * (targetAngle - this.angle) - 2 * Math.sqrt(k) * this.angleVelocity) * dt;
    this.angle += this.angleVelocity * dt;

    if (t > this.nextBlink) { this.blinkUntil = t + 0.13; this.nextBlink = t + rand(2.5, 6); }
  }

  plan(goal, t) {
    const from = this.tip;
    const dx = goal.x - from.x, dy = goal.y - from.y;
    const distance = Math.hypot(dx, dy);
    const pointing = !this.isHome;
    const dock = this.dockPoint(this.bounds);
    const fromHome = Math.hypot(from.x - dock.x, from.y - dock.y) < this.size * 1.2 || from.y > this.bounds.h - 2;
    if (distance <= 0.5) { this.flight = new Flight(from, from, goal, goal, t, 0, TimingCurve.launch, pointing); return; }
    let duration = Math.min(1.2, Math.max(0.45, 0.4 + 0.12 * Math.log2(1 + distance / 24)));
    if (this.dragging) duration = Math.min(1.6, Math.max(0.6, duration * 1.45));
    const dir = { x: dx / distance, y: dy / distance };
    let normal = { x: -dir.y, y: dir.x };
    if (Math.abs(dir.x) > 0.4) {
      if (normal.y > 0) normal = { x: -normal.x, y: -normal.y };
    } else {
      const towardMiddle = this.bounds.w / 2 - (from.x + goal.x) / 2 >= 0 ? 1 : -1;
      if (normal.x * towardMiddle < 0) normal = { x: -normal.x, y: -normal.y };
    }
    const bow = this.dragging ? 0 : Math.min(distance * 0.1, 70) * 0.75;
    const reach = distance * 0.3;
    const c2 = { x: goal.x - dir.x * reach + normal.x * bow, y: goal.y - dir.y * reach + normal.y * bow };
    const speed = Math.hypot(this.velocity.x, this.velocity.y);
    let c1, timing;
    if (speed > 60) {
      let carry = { x: this.velocity.x * duration / 3, y: this.velocity.y * duration / 3 };
      const len = Math.hypot(carry.x, carry.y);
      if (len > distance * 0.6) carry = { x: carry.x / len * distance * 0.6, y: carry.y / len * distance * 0.6 };
      c1 = { x: from.x + carry.x, y: from.y + carry.y };
      timing = TimingCurve.redirect;
    } else {
      c1 = { x: from.x + dir.x * reach + normal.x * bow, y: from.y + dir.y * reach + normal.y * bow };
      timing = this.dragging ? TimingCurve.steady : TimingCurve.launch;
    }
    this.flight = new Flight(from, c1, c2, goal, t, duration, timing, pointing);
    if (pointing && fromHome) this.onLaunch({ x: dock.x, y: this.bounds.h });
  }

  advance(t) {
    const f = this.flight;
    if (!f) { this.velocity = { x: 0, y: 0 }; return; }
    const p = f.progress(t);
    const e = f.timing.value(p);
    this.tip = f.position(e);
    if (p >= 1) {
      this.velocity = { x: 0, y: 0 };
      if (!f.landed) {
        f.landed = true;
        if (f.pointing) { this.landedAt = t; this.onLand(this.tip); }
        else if (this.mode.kind === 'following') this.onLaunch({ x: this.tip.x, y: this.bounds.h });
      }
    } else {
      const r = f.timing.rate(p) / f.duration;
      const d = f.tangent(e);
      this.velocity = { x: d.x * r, y: d.y * r };
    }
  }

  pressScale(t) {
    const s = t - this.pressStart;
    if (s < 0 || s >= 0.42) return 1;
    if (s < 0.12) return 1 - this.pressDepth * Math.sin(s / 0.12 * Math.PI / 2);
    const r = (s - 0.12) / 0.3;
    return 1 - this.pressDepth * Math.cos(r * Math.PI * 1.5) * Math.exp(-r * 3.2);
  }
  hover(t) {
    if (this.isHome || (this.flight ? this.flight.progress(t) : 1) < 1) return 0;
    const since = t - this.landedAt;
    const amount = Math.min(1, Math.max(0, (since - 0.35) / 0.6));
    return Math.sin(since * 2.4) * 1.6 * amount;
  }
  get bodyCenter() {
    const r = this.size * 0.5 * Math.SQRT2;
    return { x: this.tip.x + Math.cos(this.angle + Math.PI / 4) * r, y: this.tip.y + Math.sin(this.angle + Math.PI / 4) * r };
  }

  /** What the phone's face should do: look at the cursor (or at your mouse in follow mode). */
  face(b, t) {
    const phone = this.phonePoint(b);
    const c = this.mode.kind === 'following' ? this.mouse : this.bodyCenter;
    let gx = Math.max(-1, Math.min(1, (c.x - phone.x) / (b.w * 0.5)));
    let gy = -Math.max(0.15, Math.min(1, (phone.y - c.y) / (b.h * 1.1)));
    if (this.gazeOverride) { gx = this.gazeOverride.x; gy = this.gazeOverride.y; }
    const testing = t < this.talkUntil;
    const talk = testing ? 0.5 + 0.5 * Math.sin(t * 19) * Math.sin(t * 7.3) : this.talkLevel;
    let mood = settings.mood;
    if (this.brainMood) mood = this.brainMood;
    else if (testing) mood = 'talking';
    else if (this.mode.kind === 'pinned' && mood === 'listening') mood = 'pointing';
    else if (this.mode.kind === 'following' && !this.awake && mood === 'listening') {
      // Your mouse sat still: he gets drowsy after 5 seconds and dozes off after 15.
      const idle = t - this.lastMouseMove;
      if (idle > 15) mood = 'resting'; else if (idle > 5) mood = 'sleepy';
    }
    return { gazeX: gx, gazeY: gy, mood, talk };
  }
}

// MARK: Drawing

/** A square with three fully rounded corners and one sharp one (the tip) at the origin. y down. */
function teardropPath(s, r) {
  const p = new Path2D();
  const big = s / 2;
  p.moveTo(r, 0);
  p.arcTo(s, 0, s, s, big);
  p.arcTo(s, s, 0, s, big);
  p.arcTo(0, s, 0, 0, big);
  p.arcTo(0, 0, s, 0, r);
  p.closePath();
  return p;
}
function starPath(radius) {
  const p = new Path2D();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.4;
    const a = i * Math.PI / 4 - Math.PI / 2;
    if (i === 0) p.moveTo(Math.cos(a) * r, Math.sin(a) * r); else p.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  p.closePath();
  return p;
}

const engine = new CursorEngine();
let mouse = { x: 0, y: 0 };
let look = { x: -0.7, y: -0.7 };
let samples = [];
let lastTwinkle = 0;
let stringMid = null; let stringVel = { x: 0, y: 0 };
const effects = []; // { draw(t) → boolean alive }
let label = null;    // { text, born, life }
const speech = { text: null, born: 0, lines: [], size: null, target: null, fadeOut: 0, font: 21 };
let speechTarget = null;

function addEffect(born, life, draw) { effects.push({ born, life, draw }); }

function ring(point, radius, colour, alpha, duration) {
  const ease = new TimingCurve(0.2, 0.7, 0.3, 1);
  addEffect(now(), duration, (p) => {
    const e = ease.value(p);
    ctx.save();
    ctx.globalAlpha = 1 - e;
    ctx.strokeStyle = hexA(colour, alpha);
    ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.arc(point.x, point.y, radius * (0.3 + 0.7 * e), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  });
}
function star(point, radius, travel, colour, duration) {
  const ease = new TimingCurve(0.1, 0.8, 0.3, 1);
  const spin = rand(-2.5, 2.5);
  const path = starPath(radius);
  addEffect(now(), duration, (p) => {
    const e = ease.value(p);
    ctx.save();
    ctx.globalAlpha = p < 0.45 ? 1 : 1 - (p - 0.45) / 0.55;
    ctx.translate(point.x + travel.x * e, point.y + travel.y * e);
    ctx.rotate(spin * p);
    const s = 1 - 0.6 * p; ctx.scale(s, s);
    ctx.fillStyle = colour; ctx.fill(path);
    ctx.restore();
  });
}
const berry = (i) => settings.colour.berry[i];
function twinkle(point) {
  star(point, rand(3, 5.5), { x: rand(-8, 8), y: rand(6, 18) }, [berry(0), berry(1)][Math.random() < 0.5 ? 0 : 1], 0.5);
}
function softLand(point) { engine.press(0.05); ring(point, 30, berry(1), 0.55, 0.7); }
function puff(point) {
  if (!settings.showCursor) return;
  ring(point, 26, berry(0), 0.6, 0.55);
  for (let i = 0; i < 3; i++) {
    const dx = (i - 1) * 14;
    star({ x: point.x + dx, y: point.y - 4 }, 4, { x: dx * 0.6, y: -28 }, berry(0), 0.6);
  }
}
engine.onLand = softLand;
engine.onLaunch = puff;

function clickEffect(point, right) {
  engine.press(0.14);
  ring(point, 38, right ? berry(2) : berry(1), 0.85, 0.65);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * 2 * Math.PI + rand(-0.25, 0.25);
    const d = rand(34, 58);
    star(point, rand(4, 7), { x: Math.cos(a) * d, y: Math.sin(a) * d }, berry([0, 1, 2][Math.floor(Math.random() * 3)]), 0.55);
  }
}
function typedEffect(text) {
  if (!settings.showCursor || engine.opacity <= 0.1) return;
  engine.press(0.035);
  [...text].forEach((ch, i) => {
    if (/\s/.test(ch)) return;
    const start = { x: engine.tip.x + engine.size * 0.55 + i * 6, y: engine.tip.y - 6 };
    const end = { x: start.x + rand(-12, 16), y: start.y - 46 };
    addEffect(now(), 0.9, (p) => {
      const e = 1 - Math.pow(1 - p, 2);
      ctx.save();
      ctx.globalAlpha = p < 0.12 ? p / 0.12 : p < 0.55 ? 1 : 1 - (p - 0.55) / 0.45;
      ctx.translate(start.x + (end.x - start.x) * e, start.y + (end.y - start.y) * e);
      const s = 1.1 - 0.35 * p; ctx.scale(s, s);
      ctx.font = `600 22px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3.5; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = berry(2); ctx.fillText(ch, 0, 0);
      ctx.restore();
    });
  });
}
function showLabel(text, life = 1.4) {
  if (!settings.showCursor) return;
  label = { text, born: now(), life };
}

function drawLabel(t) {
  if (!label) return;
  const age = t - label.born;
  if (age > label.life) { label = null; return; }
  let anchor;
  if (engine.opacity > 0.1) anchor = { x: engine.tip.x + engine.size * 1.05, y: engine.tip.y - engine.size * 0.1 };
  else anchor = { x: engine.bounds.w * settings.phonePosition, y: engine.bounds.h - engine.size * 1.3 };
  ctx.save();
  ctx.font = `500 19px ${DISPLAY}`;
  const w = Math.ceil(ctx.measureText(label.text).width) + 28, h = 19 * 1.3 + 14;
  let x = anchor.x;
  if (x + w > engine.bounds.w - 12) x = engine.tip.x - w - engine.size * 0.3;
  const y = anchor.y - Math.min(age, 0.3) * 20;
  // A springy pop.
  const pop = age < 0.5 ? 1 - 0.6 * Math.exp(-age * 11) * Math.cos(age * 30) : 1;
  ctx.globalAlpha = Math.min(1, age / 0.12, (label.life - age) / 0.3);
  ctx.translate(x + w / 2, y); ctx.scale(pop, pop);
  ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, 14);
  ctx.fillStyle = hexA(INK, 0.92); ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = hexA(berry(1), 0.9); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label.text, 0, 1);
  ctx.restore();
}

// MARK: The cursor itself

function drawCursor(t, dt) {
  const k = engine.size / 96;
  const s = engine.size;
  if (!settings.showCursor || engine.opacity < 0.01) return;
  const v = engine.velocity;
  const speed = Math.hypot(v.x, v.y);
  let want = { x: -0.7, y: -0.7 };
  if (speed > 90) {
    const a = -engine.angle;
    const local = { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) };
    const n = Math.max(Math.hypot(local.x, local.y), 1);
    want = { x: local.x / n, y: local.y / n };
  }
  const follow = Math.min(1, dt * 12);
  look = { x: look.x + (want.x - look.x) * follow, y: look.y + (want.y - look.y) * follow };
  const blinking = t < engine.blinkUntil;

  ctx.save();
  ctx.globalAlpha = engine.opacity;
  ctx.translate(engine.tip.x, engine.tip.y + engine.hover(t));
  ctx.rotate(engine.angle);
  const squish = engine.pressScale(t);
  ctx.scale(squish, squish);
  ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = 8 * k; ctx.shadowOffsetY = 2 * k;
  const body = teardropPath(s, 6 * k);
  ctx.fillStyle = '#fff'; ctx.fill(body);
  ctx.shadowColor = 'transparent';
  ctx.save();
  ctx.clip(body);
  const g = ctx.createLinearGradient(0.25 * s, 0.067 * s, 0.75 * s, 0.933 * s);
  [0, 0.34, 0.68, 1].forEach((stop, i) => g.addColorStop(stop, berry(i)));
  ctx.fillStyle = g; ctx.fill(body);
  const shine = ctx.createRadialGradient(0.3 * s, 0.24 * s, 0, 0.3 * s, 0.24 * s, 0.38 * s);
  shine.addColorStop(0, 'rgba(255,255,255,0.55)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine; ctx.fill(body);
  ctx.lineWidth = 8 * k; ctx.strokeStyle = '#fff'; ctx.stroke(body); // half is clipped away: a 4 pt rim
  ctx.restore();
  // Googly eyes that look where it's heading, and back at the tip when it stops.
  for (let i = 0; i < 2; i++) {
    const d = 18 * k;
    const cx = (34 + i * 24) * k + d / 2, cy = 40 * k + d / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, blinking ? 0.12 : 1);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, d / 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(look.x * 3.4 * k, look.y * 3.4 * k, 4.5 * k, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawTrail(t, speed) {
  const center = engine.bodyCenter;
  samples.push({ p: center, t });
  samples = samples.filter((x) => t - x.t <= 0.2);
  if (!settings.showCursor || settings.trail !== 'comet' || samples.length <= 2 || speed <= 260) return;
  const head = engine.size * 0.42;
  const left = [], right = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i].p, prev = samples[Math.max(0, i - 1)].p, next = samples[Math.min(samples.length - 1, i + 1)].p;
    let n = { x: -(next.y - prev.y), y: next.x - prev.x };
    const len = Math.max(Math.hypot(n.x, n.y), 0.001);
    n = { x: n.x / len, y: n.y / len };
    const w = head * Math.pow(i / (samples.length - 1), 1.3) / 2;
    left.push({ x: p.x + n.x * w, y: p.y + n.y * w }); right.push({ x: p.x - n.x * w, y: p.y - n.y * w });
  }
  const pts = left.concat(right.reverse());
  ctx.save();
  ctx.globalAlpha = Math.min(1, (speed - 260) / 900) * 0.26 * engine.opacity;
  ctx.fillStyle = berry(1);
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
  ctx.restore();
  if (speed > 900 && t - lastTwinkle > 0.05) {
    lastTwinkle = t;
    twinkle({ x: center.x + rand(-10, 10), y: center.y + rand(-10, 10) });
  }
}

function drawString(t, dt) {
  if (!settings.showCursor || settings.trail !== 'string' || engine.opacity <= 0.02) { stringMid = null; return; }
  const from = { x: engine.bounds.w * settings.phonePosition, y: engine.bounds.h + 4 };
  const to = engine.bodyCenter;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const slack = Math.max(0, 160 - distance * 0.12);
  const goal = { x: (from.x + to.x) / 2 + Math.sin(t * 1.3) * 6, y: (from.y + to.y) / 2 + slack };
  const mid = stringMid || { ...goal };
  const k = 22;
  stringVel.x += (k * (goal.x - mid.x) - 2 * Math.sqrt(k) * 0.55 * stringVel.x) * dt;
  stringVel.y += (k * (goal.y - mid.y) - 2 * Math.sqrt(k) * 0.55 * stringVel.y) * dt;
  mid.x += stringVel.x * dt; mid.y += stringVel.y * dt;
  stringMid = mid;
  const control = { x: 2 * mid.x - (from.x + to.x) / 2, y: 2 * mid.y - (from.y + to.y) / 2 };
  ctx.save();
  ctx.globalAlpha = engine.opacity;
  ctx.strokeStyle = hexA(berry(0), 0.7); ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(control.x, control.y, to.x, to.y); ctx.stroke();
  ctx.restore();
}

// MARK: Speech bubble

function wrap(text, maxWidth) {
  const words = text.split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    const tryLine = line ? line + ' ' + w : w;
    if (ctx.measureText(tryLine).width > maxWidth && line) { lines.push(line); line = w; } else line = tryLine;
  }
  if (line) lines.push(line);
  return lines;
}

function setCaption(text) {
  text = text && text.trim() ? text.trim() : null;
  if (text === speech.text) return;
  if (!text) { if (speech.text) speech.fadeOut = now(); speech.text = null; return; }
  const appearing = !speech.text;
  speech.text = text; speech.fadeOut = 0;
  const length = text.length;
  speech.font = length <= 50 ? 21 : length <= 110 ? 19 : 17;
  ctx.save();
  ctx.font = `500 ${speech.font}px ${DISPLAY}`;
  const maxWidth = Math.min(engine.bounds.w * 0.5, 580, Math.max(240, Math.sqrt(length) * 50));
  speech.lines = wrap(text, maxWidth);
  const width = Math.max(...speech.lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  const lineH = speech.font * 1.3;
  speech.size = { w: Math.max(Math.ceil(width) + 48, 70), h: Math.ceil(lineH * speech.lines.length) + 30 };
  if (appearing) speech.born = now();
}

function drawSpeech(t) {
  const fading = !speech.text && speech.fadeOut && t - speech.fadeOut < 0.22;
  if ((!speech.text && !fading) || !speech.size) return;
  const { w, h } = speech.size;
  const tail = 18, margin = 14;
  const pointing = engine.opacity > 0.1 && !engine.isHome;
  let target, origin, tailUp = false;
  const below = { x: engine.tip.x + engine.size * 0.5, y: engine.tip.y + engine.size * 1.35 };
  if (pointing) {
    const thing = speechTarget || { x: engine.tip.x - 12, y: engine.tip.y - 30, w: 24, h: 24 };
    target = { x: thing.x + thing.w / 2, y: thing.y - 10 };
    origin = { x: target.x - w / 2, y: target.y - tail - h };
    if (origin.y < margin) { target = below; origin = { x: target.x - w / 2, y: target.y + tail }; tailUp = true; }
  } else {
    target = { x: engine.bounds.w * settings.phonePosition, y: engine.bounds.h - engine.size * 0.9 };
    origin = { x: target.x - w / 2, y: target.y - tail - h };
  }
  origin.x = Math.min(Math.max(origin.x, margin), engine.bounds.w - w - margin);
  origin.y = Math.min(Math.max(origin.y, margin), engine.bounds.h - h - margin);
  const float = Math.sin((t - speech.born) * 2.2) * 2;
  origin.y += float; target.y += float * 0.5;

  // Tail position, as in the Mac version.
  const r = Math.min(24, h / 2), half = 13;
  const localX = target.x - origin.x;
  const baseX = Math.min(Math.max(localX, r + half + 2), w - r - half - 2);
  const lean = Math.min(Math.max(localX - baseX, -tail * 1.4), tail * 1.4);
  const tipY = tailUp ? -tail : h + tail;
  const tipX = baseX + lean;
  const p = new Path2D();
  p.moveTo(r, 0);
  if (tailUp) {
    p.lineTo(baseX - half, 0);
    p.bezierCurveTo(baseX - half * 0.3, 0, tipX - 1, -tail * 0.5, tipX, tipY);
    p.bezierCurveTo(tipX + 2, -tail * 0.45, baseX + half * 0.4, 0, baseX + half, 0);
  }
  p.lineTo(w - r, 0); p.arcTo(w, 0, w, r, r);
  p.lineTo(w, h - r); p.arcTo(w, h, w - r, h, r);
  if (!tailUp) {
    p.lineTo(baseX + half, h);
    p.bezierCurveTo(baseX + half * 0.3, h, tipX + 1, h + tail * 0.5, tipX, tipY);
    p.bezierCurveTo(tipX - 2, h + tail * 0.45, baseX - half * 0.4, h, baseX - half, h);
  }
  p.lineTo(r, h); p.arcTo(0, h, 0, h - r, r);
  p.lineTo(0, r); p.arcTo(0, 0, r, 0, r);
  p.closePath();

  const age = t - speech.born;
  let scale = age < 0.6 ? 1 - 0.45 * Math.exp(-age * 9) * Math.cos(age * 22) : 1;
  let alpha = Math.min(1, age / 0.12);
  if (fading) { const f = (t - speech.fadeOut) / 0.22; alpha = 1 - f; scale = 1 - 0.15 * f; }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(origin.x + w / 2, origin.y + h / 2); ctx.scale(scale, scale); ctx.translate(-w / 2, -h / 2);
  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, '#FFFFFF'); fill.addColorStop(1, '#EEF0FF');
  ctx.fillStyle = fill; ctx.fill(p);
  ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.strokeStyle = berry(1); ctx.stroke(p);
  ctx.fillStyle = INK; ctx.font = `500 ${speech.font}px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lineH = speech.font * 1.3;
  speech.lines.forEach((line, i) => ctx.fillText(line, w / 2, 15 + lineH * (i + 0.5)));
  ctx.restore();
}

// MARK: Frame loop

let lastFrame = 0;
let lastSent = 0;
function frame(ms) {
  const t = ms / 1000;
  const dt = lastFrame ? Math.min(Math.max(t - lastFrame, 1 / 480), 1 / 20) : 1 / 60;
  lastFrame = t;
  const w = window.innerWidth, h = window.innerHeight, dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const tn = now();
  engine.step(dt, tn, mouse, { w, h });
  const speed = Math.hypot(engine.velocity.x, engine.velocity.y);
  drawTrail(tn, speed);
  drawString(tn, dt);
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i]; const p = (tn - e.born) / e.life;
    if (p >= 1) effects.splice(i, 1); else e.draw(Math.max(0, p));
  }
  drawCursor(tn, dt);
  drawLabel(tn);
  drawSpeech(tn);
  if (tn - lastSent > 1 / 30) {
    lastSent = tn;
    window.bluey.overlayState({
      face: engine.face(engine.bounds, tn),
      tip: engine.tip, arriveIn: engine.timeToArrive(tn), isHome: engine.isHome, opacity: engine.opacity,
    });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// MARK: Messages from the app

window.bluey.onOverlay((m) => {
  switch (m.type) {
    case 'settings':
      Object.assign(settings, m.settings);
      break;
    case 'mouse': mouse = { x: m.x, y: m.y }; break;
    case 'mode':
      engine.mode = m.mode === 'pinned' ? { kind: 'pinned', x: m.x, y: m.y } : { kind: m.mode };
      break;
    case 'caption': setCaption(m.text); break;
    case 'speechTarget': speechTarget = m.rect || null; break;
    case 'click': clickEffect({ x: m.x, y: m.y }, !!m.right); break;
    case 'typed': typedEffect(m.text || ''); break;
    case 'label': showLabel(m.text, m.life || 1.4); break;
    case 'press': engine.press(m.depth || 0.1); break;
    case 'talkTest': engine.talkUntil = now() + (m.seconds || 3); break;
    case 'engine':
      if ('awake' in m) engine.awake = !!m.awake;
      if ('dragging' in m) engine.dragging = !!m.dragging;
      if ('brainMood' in m) engine.brainMood = m.brainMood || null;
      if ('gazeOverride' in m) engine.gazeOverride = m.gazeOverride || null;
      break;
    case 'countdown': {
      const el = document.getElementById('countdown');
      el.style.right = `${m.right ?? 32}px`; el.style.bottom = `${m.bottom ?? 24}px`;
      el.querySelector('.time').textContent = m.text || '';
      el.querySelector('.mode').textContent = m.mode || '';
      break;
    }
    default: break;
  }
});
