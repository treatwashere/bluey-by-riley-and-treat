'use strict';
// The original Bluey face (iOS/Sources/FaceView.swift), drawn on a canvas in any colour. Used for the live
// preview in Settings. Same springs, blinks, brows, googly eyes, cheeks, crown and nose-mouth as the phone.
(function () {
  const rand = (a, b) => a + Math.random() * (b - a);
  class Spring {
    constructor(value, stiffness = 200, damping = 0.7) { this.value = value; this.velocity = 0; this.stiffness = stiffness; this.damping = damping; }
    step(target, dt) {
      const c = 2 * Math.sqrt(this.stiffness) * this.damping;
      this.velocity += (this.stiffness * (target - this.value) - c * this.velocity) * dt;
      this.value += this.velocity * dt;
    }
  }

  class FaceAnimator {
    constructor() {
      this.target = { gazeX: 0, gazeY: 0, mood: 'listening', talk: 0 }; this.lastPacket = -100;
      this.gazeX = new Spring(0, 260, 0.82); this.gazeY = new Spring(0, 260, 0.82); this.pupil = new Spring(1, 160, 0.5);
      this.browLift = new Spring(0, 180, 0.55); this.browTilt = new Spring(0, 150, 0.6); this.lean = new Spring(0, 60, 0.8);
      this.hop = new Spring(0, 260, 0.35); this.blush = new Spring(0.25, 40, 1); this.squint = new Spring(0, 150, 0.7);
      this.talk = 0; this.mood = 'listening'; this.blinkStart = -1; this.doubleBlink = false; this.nextBlink = 2;
      this.lastTime = null; this.nextSaccade = 0; this.wander = { x: 0, y: -0.3 }; this.jitter = { x: 0, y: 0 }; this.nextJitter = 0; this.nextHop = 6;
      this.localMood = null; this.awake = false;
    }
    receive(face, time) { this.target = face; this.lastPacket = time; }
    step(now) {
      const dt = Math.min(now - (this.lastTime ?? now), 1 / 20); this.lastTime = now;
      const live = now - this.lastPacket < 2.5;
      const wanted = this.localMood || (live ? this.target.mood : 'listening');
      if (wanted !== this.mood) {
        this.mood = wanted; this.blinkStart = now;
        if (this.mood !== 'sleepy' && this.mood !== 'resting') { this.hop.velocity += 260; this.pupil.velocity += 3; }
      }
      let want;
      if (live) want = { x: this.target.gazeX, y: this.target.gazeY };
      else {
        if (now > this.nextSaccade) { this.wander = { x: rand(-0.9, 0.9), y: rand(-0.9, 0.4) }; this.nextSaccade = now + rand(0.6, 2.2); }
        want = this.wander;
      }
      if (this.mood === 'thinking') want = { x: 0.6 + 0.08 * Math.sin(now * 1.3), y: -0.85 };
      if (now > this.nextJitter) {
        const amount = !this.awake ? 0.015 : this.mood === 'talking' ? 0.07 : this.mood === 'thinking' ? 0.05 : 0.02;
        this.jitter = { x: rand(-amount, amount), y: rand(-amount, amount) }; this.nextJitter = now + rand(0.5, 1.4);
      }
      this.gazeX.step(want.x + this.jitter.x, dt); this.gazeY.step(want.y + this.jitter.y, dt);
      const wantTalk = live ? this.target.talk : 0;
      this.talk += (wantTalk - this.talk) * Math.min(1, dt * 25);
      let p = 1, lift = 0, tilt = 0, blush = 0.25, squint = 0;
      switch (this.mood) {
        case 'listening': p = 1.12; lift = 10; break;
        case 'talking': p = 1.05; lift = 6 + this.talk * 18; tilt = 0.05 * Math.sin(now * 2.3); break;
        case 'pointing': p = 0.95; lift = -4; tilt = -0.14; break;
        case 'thinking': p = 0.9; lift = 4; tilt = 0.22; break;
        case 'happy': p = 1.2; lift = 16; blush = 0.85; squint = 1; break;
        case 'resting': p = 0.9; lift = -8; blush = 0.15; break;
        case 'sleepy': p = 0.88; lift = -10; tilt = 0.12; blush = 0.15; break;
        default: break;
      }
      this.pupil.step(p, dt); this.browLift.step(lift, dt); this.browTilt.step(tilt, dt); this.blush.step(blush, dt); this.squint.step(squint, dt);
      this.lean.step(-this.gazeX.value * 0.045, dt);
      if (now > this.nextHop) {
        if (this.talk < 0.05 && this.mood !== 'sleepy' && this.mood !== 'resting') this.hop.velocity += rand(180, 320);
        this.nextHop = now + rand(7, 14);
      }
      this.hop.step(0, dt);
      const drowsy = this.mood === 'sleepy';
      if (now > this.nextBlink) {
        this.blinkStart = now; this.doubleBlink = !drowsy && Math.random() < 0.25;
        this.nextBlink = now + (drowsy ? rand(1.6, 3.0) : rand(2.0, 5.0));
      }
      const b = (now - this.blinkStart) / (drowsy ? 0.7 : 0.15);
      let closed = b >= 0 && b <= 1 ? Math.sin(Math.PI * b) : 0;
      if (this.doubleBlink && b >= 1.3 && b <= 2.3) closed = Math.sin(Math.PI * (b - 1.3));
      return { gaze: { x: this.gazeX.value, y: this.gazeY.value }, mood: this.mood, talk: this.talk, closed,
        breathe: Math.sin(now * (this.mood === 'resting' ? 1.1 : 1.8)), time: now, pupil: this.pupil.value,
        browLift: this.browLift.value, browTilt: this.browTilt.value, lean: this.lean.value, hop: this.hop.value,
        blush: this.blush.value, squint: Math.max(0, Math.min(1, this.squint.value)) };
    }
  }

  function blob(r) {
    const { x, y, w, h } = r; const k = 0.5523;
    const tl = [0.52 * w, 0.58 * h], tr = [0.48 * w, 0.56 * h], br = [0.46 * w, 0.44 * h], bl = [0.54 * w, 0.42 * h];
    const p = new Path2D();
    p.moveTo(x + tl[0], y);
    p.lineTo(x + w - tr[0], y);
    p.bezierCurveTo(x + w - tr[0] * (1 - k), y, x + w, y + tr[1] * (1 - k), x + w, y + tr[1]);
    p.lineTo(x + w, y + h - br[1]);
    p.bezierCurveTo(x + w, y + h - br[1] * (1 - k), x + w - br[0] * (1 - k), y + h, x + w - br[0], y + h);
    p.lineTo(x + bl[0], y + h);
    p.bezierCurveTo(x + bl[0] * (1 - k), y + h, x, y + h - bl[1] * (1 - k), x, y + h - bl[1]);
    p.lineTo(x, y + tl[1]);
    p.bezierCurveTo(x, y + tl[1] * (1 - k), x + tl[0] * (1 - k), y, x + tl[0], y);
    p.closePath();
    return p;
  }
  function crown(r) {
    const pts = [[30, 4], [36, 16], [52, 12], [40, 24], [46, 36], [30, 28], [14, 36], [20, 24], [8, 12], [24, 16]];
    const p = new Path2D();
    pts.forEach(([px, py], i) => { const X = r.x + px / 60 * r.w, Y = r.y + py / 40 * r.h; if (i) p.lineTo(X, Y); else p.moveTo(X, Y); });
    p.closePath();
    return p;
  }
  const ellipse = (x, y, w, h) => { const p = new Path2D(); p.ellipse(x + w / 2, y + h / 2, Math.max(0.01, w / 2), Math.max(0.01, h / 2), 0, 0, Math.PI * 2); return p; };
  const INK = '#17151F';

  /** Draws one frame. `size` is the canvas size in CSS pixels. Mirrors FaceView.draw. */
  function draw(ctx, f, size, colour) {
    const W = 844, H = 390;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size.w, size.h);
    const scale = Math.max(size.w / W, size.h / H);
    ctx.save();
    ctx.translate((size.w - W * scale) / 2, size.h - H * scale);
    ctx.scale(scale, scale);
    const bounce = -f.talk * 16 + f.breathe * 3 - f.hop;
    const body = { x: 12, y: 44 + bounce, w: 820, h: 700 };
    const pivot = { x: body.x + body.w / 2, y: body.y + body.h };
    ctx.translate(pivot.x, pivot.y); ctx.rotate(f.lean);
    const stretch = 1 + Math.min(0.03, Math.max(-0.03, f.hop / 900));
    ctx.scale(2 - stretch, stretch);
    ctx.translate(-pivot.x, -pivot.y);

    const skin = ctx.createLinearGradient(body.x + 0.25 * body.w, body.y + 0.067 * body.h, body.x + 0.75 * body.w, body.y + 0.933 * body.h);
    [0, 0.34, 0.68, 1].forEach((s, i) => skin.addColorStop(s, colour.berry[i]));
    const shine = ctx.createRadialGradient(body.x + 246, body.y + 126, 0, body.x + 246, body.y + 126, 243);
    shine.addColorStop(0, 'rgba(255,255,255,0.5)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
    const fillSkin = (path) => { ctx.fillStyle = skin; ctx.fill(path); ctx.fillStyle = shine; ctx.fill(path); };

    const shape = blob(body);
    ctx.fillStyle = colour.berry[2]; ctx.fill(shape);
    ctx.fillStyle = skin; ctx.fill(shape);
    ctx.save(); ctx.clip(shape);
    ctx.fillStyle = shine; ctx.fill(shape);
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill(ellipse(body.x + 190, body.y + 40, 46, 22));
    ctx.restore();

    const navy = colour.nose;
    ctx.fillStyle = navy; ctx.fill(crown({ x: body.x + 368, y: body.y - 20 - f.browLift * 0.3, w: 84, h: 56 }));
    const eyeY = body.y + 157;
    const eyes = [{ x: body.x + 280, y: eyeY }, { x: body.x + 540, y: eyeY }];
    const squash = 1 - f.talk * 0.12;

    eyes.forEach((c, i) => {
      const side = i === 0 ? -1 : 1;
      ctx.save(); ctx.filter = 'blur(10px)';
      ctx.fillStyle = `rgba(243,166,216,${0.25 + 0.45 * f.blush})`;
      ctx.fill(ellipse(c.x - 45 + side * 62, c.y + 96, 90, 42));
      ctx.restore();
    });

    eyes.forEach((c, i) => {
      const side = i === 0 ? -1 : 1;
      ctx.save();
      const browY = c.y - 112 - Math.min(18, Math.max(-10, f.browLift)) * 0.7;
      ctx.translate(c.x + side * 6, browY);
      ctx.rotate(f.browTilt * side * -1 + (f.mood === 'thinking' && i === 1 ? -0.25 : 0));
      ctx.strokeStyle = navy; ctx.lineWidth = 14; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-38, 6); ctx.quadraticCurveTo(0, -12, 38, 6); ctx.stroke();
      ctx.restore();

      ctx.lineCap = 'round';
      if (f.mood === 'resting') {
        ctx.strokeStyle = INK; ctx.lineWidth = 18;
        ctx.beginPath(); ctx.moveTo(c.x - 62, c.y + 6); ctx.quadraticCurveTo(c.x, c.y + 52, c.x + 62, c.y + 6); ctx.stroke();
        return;
      }
      if (f.mood === 'happy' && f.squint > 0.6) {
        ctx.strokeStyle = INK; ctx.lineWidth = 24;
        ctx.beginPath(); ctx.moveTo(c.x - 60, c.y + 34); ctx.quadraticCurveTo(c.x, c.y - 54, c.x + 60, c.y + 34); ctx.stroke();
        return;
      }
      const open = Math.max(0.06, 1 - f.closed) * squash;
      const white = { x: c.x - 95, y: c.y - 95 * open, w: 190, h: 190 * open };
      const whitePath = ellipse(white.x, white.y, white.w, white.h);
      ctx.fillStyle = '#fff'; ctx.fill(whitePath);
      if (open <= 0.2) return;
      let g = { ...f.gaze }; const len = Math.hypot(g.x, g.y);
      if (len > 1) g = { x: g.x / len, y: g.y / len };
      const r = 46 * f.pupil;
      const px = c.x + g.x * 50 - side * 3;
      let py = c.y + g.y * 50 * open;
      if (f.mood === 'sleepy') py = Math.max(py, c.y) + 28;
      ctx.save(); ctx.clip(whitePath);
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fill(ellipse(px - r * 0.58, py - r * 0.72, r * 0.56, r * 0.56));
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill(ellipse(px + r * 0.28, py + r * 0.22, r * 0.24, r * 0.24));
      if (f.squint > 0.02) fillSkin(ellipse(c.x - 110, c.y + 95 * open - 70 * f.squint, 220, 160));
      if (f.mood === 'sleepy') {
        const droop = 0.5 + 0.06 * Math.sin(f.time * 1.3);
        const lid = new Path2D(); lid.rect(c.x - 100, white.y - 10, 200, white.h * droop + 10); fillSkin(lid);
        ctx.strokeStyle = navy; ctx.globalAlpha = 0.7; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(c.x - 92, white.y + white.h * droop); ctx.lineTo(c.x + 92, white.y + white.h * droop); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (f.mood === 'pointing') { const lid = new Path2D(); lid.rect(c.x - 100, white.y - 20, 200, 40); fillSkin(lid); }
      ctx.restore();
    });

    if (f.mood === 'resting') {
      for (let i = 0; i < 3; i++) {
        const phase = (f.time * 0.35 + i / 3) % 1;
        ctx.fillStyle = `rgba(255,255,255,${0.9 * Math.sin(Math.PI * phase)})`;
        ctx.font = `700 ${26 + i * 8}px Fredoka, "Segoe UI", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('z', body.x + 660 + phase * 70 + Math.sin(phase * 6) * 8, body.y + 90 - phase * 110);
      }
    }
    if (f.mood === 'thinking') {
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = `rgba(255,255,255,${1 - i * 0.3})`;
        ctx.fill(ellipse(body.x + 690 + i * 26, body.y + 40 - i * 12 + Math.sin(f.time * 3 + i) * 4, 16, 16));
      }
    }
    const noseW = 60 - f.talk * 8, noseH = 38 + f.talk * 34;
    const nose = { x: body.x + 410 - noseW / 2, y: body.y + 272 - f.talk * 6, w: noseW, h: noseH };
    ctx.fillStyle = navy;
    if (f.mood === 'happy' && f.talk < 0.1) {
      ctx.beginPath(); ctx.moveTo(nose.x - 8, nose.y + 8); ctx.quadraticCurveTo(nose.x + nose.w / 2, nose.y + 58, nose.x + nose.w + 8, nose.y + 8); ctx.closePath(); ctx.fill();
    } else {
      ctx.fill(ellipse(nose.x, nose.y, nose.w, nose.h));
      if (f.talk > 0.25) { ctx.fillStyle = 'rgba(229,139,196,0.9)'; ctx.fill(ellipse(nose.x + nose.w / 2 - noseW * 0.28, nose.y + nose.h - noseH * 0.38, noseW * 0.56, noseH * 0.3)); }
    }
    ctx.restore();
  }

  /** Starts an animated face on a canvas. getColour() returns {berry:[4], nose}. Eyes follow the mouse over the page. */
  function start(canvas, getColour, options = {}) {
    const animator = new FaceAnimator();
    const ctx = canvas.getContext('2d');
    let mouse = null;
    window.addEventListener('mousemove', (e) => { mouse = { x: e.clientX, y: e.clientY, t: performance.now() / 1000 }; });
    function frame() {
      const t = performance.now() / 1000;
      const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(rect.width * dpr)) { canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); }
      if (options.mood) animator.localMood = options.mood();
      if (mouse && t - mouse.t < 4) {
        animator.receive({ gazeX: Math.max(-1, Math.min(1, (mouse.x - rect.left - rect.width / 2) / (rect.width * 0.8))),
          gazeY: Math.max(-1, Math.min(1, (mouse.y - rect.top - rect.height / 2) / (rect.height * 1.2))), mood: 'listening', talk: 0 }, t);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, animator.step(t), { w: rect.width, h: rect.height }, getColour());
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return animator;
  }

  window.BlueyFace = { start, draw, FaceAnimator };
})();
