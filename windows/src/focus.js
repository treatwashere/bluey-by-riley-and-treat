'use strict';
// A port of Shared/FocusSession.swift and Mac/FocusCompanion.swift. The computer owns the clock, the check
// cadence and cancellation; the phone sends commands and renders the snapshots it receives.
// JSON matches Swift's Codable output exactly (dates are seconds since 2001-01-01, ids are uppercase UUIDs),
// so an iPhone can't tell a Windows PC from a Mac.
const crypto = require('crypto');
const fs = require('fs');

const APPLE_EPOCH = 978307200; // 2001-01-01T00:00:00Z in Unix seconds
const appleNow = () => Date.now() / 1000 - APPLE_EPOCH;
const uuid = () => crypto.randomUUID().toUpperCase();

function newSession(task, duration = 1800, developerMode = false) {
  const s = {
    id: uuid(), task: String(task).slice(0, 500), duration: Math.min(14400, Math.max(60, duration)),
    startedAt: appleNow(), elapsed: 0, status: 'running', detail: '', checks: [],
    developerMode, usedDeveloperMode: developerMode, realElapsed: 0,
  };
  s.detail = `First check in ${checkInterval(s)} seconds`;
  return s;
}
const clockRate = (s) => (s.developerMode ? 4 : 1);
const checkInterval = (s) => (s.developerMode ? 10 : 30);
const observationDuration = (s) => checkInterval(s) * clockRate(s);
const remaining = (s) => Math.max(0, s.duration - s.elapsed);
const clock = (seconds) => {
  const n = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};
function advance(s, seconds) {
  if (s.status !== 'running' || !Number.isFinite(seconds) || seconds <= 0) return;
  s.realElapsed = (s.realElapsed ?? s.elapsed) + Math.min(seconds, remaining(s) / clockRate(s));
  s.elapsed = Math.min(s.duration, s.elapsed + seconds * clockRate(s));
  if (s.elapsed >= s.duration) { s.status = 'ended'; s.detail = "Time's up. Lovely bit of focus."; }
}
const check = (elapsed, activity, extra = {}) => Object.assign(
  { id: uuid(), elapsed, activity, probability: 0, confidence: 0, nudged: false }, extra);

/// Consecutive fresh majority off-task checks spanning enough focus time trigger a nudge (Swift FocusNudgePolicy).
class NudgePolicy {
  constructor(maximumGap = 45, developerMode = false) {
    this.run = []; this.lastNudge = -Infinity; this.maximumGap = maximumGap; this.developerMode = developerMode;
  }
  reset() { this.run = []; }
  observe(c, age) {
    const ok = age >= 0 && age <= 20 && Number.isFinite(c.elapsed) && c.activity === 'off_task'
      && Number.isFinite(c.probability) && Number.isFinite(c.confidence)
      && c.probability >= 0.5 && c.probability <= 1 && c.confidence >= 0 && c.confidence <= 1;
    if (!ok) { this.reset(); return false; }
    const last = this.run[this.run.length - 1];
    if (last) {
      if (!(c.elapsed > last.elapsed)) { this.reset(); return false; }
      if (c.elapsed - last.elapsed > this.maximumGap) this.reset();
    }
    this.run.push(c);
    const strength = this.run.reduce((a, x) => a + x.probability, 0) / this.run.length;
    const minimum = this.developerMode ? 40 : 120;
    const maximum = this.developerMode ? 80 : 240;
    const required = strength >= 0.95 ? minimum : maximum - Math.max(0, strength - 0.5) / 0.45 * (maximum - minimum);
    if (this.run.length < 2 || c.elapsed - this.run[0].elapsed < Math.max(minimum, required) || c.elapsed - this.lastNudge < 120) return false;
    this.lastNudge = c.elapsed; this.reset(); return true;
  }
}

class FocusCompanion {
  /// deps: { now(), capture(), classify(screen, session, idle), prepareNudge(screen, task), hasKey(), missingKey(),
  ///         idleSeconds(), historyFile, developerMode, onChange(sync), onNudge(text), onSettings(devMode) }
  constructor(deps) {
    this.d = deps;
    this.current = null;
    this.history = [];
    this.connected = false;
    this.developerMode = !!deps.developerMode;
    this.lastPing = -Infinity;
    this.lastTick = deps.now();
    this.lastCheck = 0;
    this.policy = new NudgePolicy();
    this.generation = 0;
    this.working = false;
    this.revision = 0;
    this.locked = false;
    if (deps.historyFile) {
      try { this.history = JSON.parse(fs.readFileSync(deps.historyFile, 'utf8')); } catch { this.history = []; }
    }
  }
  startService() { this.timer = setInterval(() => this.tick(), 1000); }
  shutdown() { this.pause('Bluey closed'); clearInterval(this.timer); this.cancel(); }
  heartbeat() { this.lastPing = this.d.now(); this.connected = true; if (!this.monitoring) this.publish(); }
  disconnected() { this.connected = false; this.pause('Phone disconnected. Reconnect, then resume.'); }
  sync() { this.publish(); }
  get monitoring() { return this.current?.status === 'running'; }
  get hasSession() { return !!this.current && this.current.status !== 'ended'; }
  get freshConnection() { return this.connected && this.d.now() - this.lastPing < 5; }
  get allowed() { return this.monitoring && this.freshConnection && !this.locked; }
  cancel() { this.generation += 1; }

  setDeveloperMode(enabled) {
    enabled = !!enabled;
    if (enabled === this.developerMode) return `Developer Mode is already ${enabled ? 'on' : 'off'}.`;
    if (this.monitoring) this.advanceClock();
    this.cancel();
    this.developerMode = enabled;
    this.d.onSettings?.(enabled);
    if (this.hasSession) {
      this.current.developerMode = enabled;
      if (enabled) this.current.usedDeveloperMode = true;
      this.current.detail = enabled ? 'Developer Mode: clock 4×, next check in 10 seconds' : 'Normal speed. Next check in 30 seconds';
    }
    this.policy = new NudgePolicy((this.current ? observationDuration(this.current) : (enabled ? 40 : 30)) * 1.5, enabled);
    this.lastTick = this.d.now(); this.lastCheck = this.current?.elapsed ?? 0;
    if (this.current?.status === 'ended') this.finish(); else { this.publish(); this.persist(); }
    return enabled ? 'Developer Mode on: clock 4×, checks every 10 seconds.' : 'Developer Mode off: normal clock, checks every 30 seconds.';
  }
  start(task, minutes = 30) {
    task = String(task || '').trim();
    if (!task) return 'Tell me the task first.';
    if (!Number.isFinite(minutes)) return 'Use a duration between 1 and 240 minutes.';
    if (this.hasSession) return "There's already a focus session. End it before starting another.";
    if (!this.freshConnection) return 'Connect the paired phone first.';
    if (!this.d.hasKey()) return this.d.missingKey();
    this.cancel();
    const m = Math.min(240, Math.max(1, minutes));
    this.current = newSession(task, m * 60, this.developerMode);
    this.policy = new NudgePolicy(observationDuration(this.current) * 1.5, this.developerMode);
    this.lastTick = this.d.now(); this.lastCheck = 0;
    this.publish(); this.persist();
    return `Focus started: ${task}, ${Math.round(m)} minutes.`;
  }
  pause(reason = 'Paused') {
    if (this.current?.status !== 'running') return 'Focus is already paused or ended.';
    this.advanceClock();
    this.current.status = 'paused'; this.current.detail = reason;
    this.current.checks.push(check(this.current.elapsed, 'paused'));
    this.cancel(); this.policy.reset(); this.publish(); this.persist();
    return 'Focus paused.';
  }
  resume() {
    if (this.current?.status !== 'paused') return "There's no paused focus session.";
    if (!this.freshConnection) return 'Reconnect the paired phone before resuming.';
    this.current.status = 'running';
    this.current.detail = `Resumed. Next check in ${checkInterval(this.current)} seconds`;
    this.policy.reset(); this.cancel();
    this.lastTick = this.d.now(); this.lastCheck = this.current.elapsed;
    this.publish(); this.persist();
    return 'Focus resumed.';
  }
  end() {
    if (!this.hasSession) return "There's no running focus session.";
    this.advanceClock();
    this.current.status = 'ended'; this.current.detail = 'Session finished';
    this.finish();
    return 'Focus finished. Your timeline is on the phone.';
  }
  testNudge() {
    if (!this.developerMode || !this.freshConnection) return 'Enable Developer Mode and connect the phone first.';
    this.d.onNudge?.('Oi, back to the mission. This is your test nudge.');
    return 'Test nudge sent to the computer and phone.';
  }
  lock(reason) { this.locked = true; this.pause(reason); }
  unlock() { this.locked = false; }

  advanceClock() {
    const now = this.d.now();
    const delta = now - this.lastTick; this.lastTick = now;
    if (delta <= 3 && this.current) advance(this.current, delta); // a suspended timer isn't focus time
  }
  tick() {
    if (!this.monitoring) return;
    if (!this.freshConnection) { this.pause('Phone disconnected. Reconnect, then resume.'); return; }
    if (this.locked) { this.pause('Computer locked. Resume when ready.'); return; }
    if (this.d.now() - this.lastTick > 3) { this.pause('Computer was inactive. Resume when ready.'); return; }
    this.advanceClock();
    if (this.current.status === 'ended') { this.finish(); return; }
    this.publish();
    const s = this.current;
    if (s.elapsed - this.lastCheck >= observationDuration(s) && !this.working) {
      this.lastCheck = s.elapsed;
      this.runCheck(JSON.parse(JSON.stringify(s)));
    }
  }
  async runCheck(session) {
    const token = this.generation;
    const began = this.d.now();
    const live = () => this.allowed && this.generation === token;
    this.working = true;
    try {
      if (!live()) return;
      const screen = await this.d.capture();
      if (!live()) return;
      const answer = await this.d.classify(screen, session, this.d.idleSeconds());
      if (!live()) return;
      const age = this.d.now() - began;
      const c = check(session.elapsed, age <= 20 ? answer.activity : 'unavailable', {
        probability: answer.probability, confidence: answer.confidence, sampleDuration: observationDuration(session),
      });
      if (age <= 20) c.probabilities = answer.probabilities;
      if (answer.providers) c.providers = answer.providers; // extra key: ignored by iPhones, shown on Android
      const shouldNudge = this.policy.observe(c, age);
      this.current.detail = age > 20 ? 'Last check was stale; skipped'
        : answer.activity === 'uncertain' ? 'Not enough context to judge'
          : answer.activity === 'on_task' ? 'On task' : 'Off task · checking again before nudging';
      this.current.checks.push(c);
      this.publish(); this.persist();
      if (shouldNudge && live()) {
        let message = "Are you sure you're on task right now?";
        this.current.detail = 'Off task · preparing a gentle nudge'; this.publish();
        try {
          const fresh = await this.d.capture();
          if (!live()) return;
          message = await this.d.prepareNudge(fresh, session.task);
        } catch {
          this.current.detail = 'Off task · using a gentle reminder';
        }
        if (!live()) return;
        this.d.onNudge?.(message);
        this.current.detail = 'Off task · Bluey nudged you';
        const stored = this.current.checks.find((x) => x.id === c.id);
        if (stored) stored.nudged = true;
        this.publish(); this.persist();
      }
    } catch (error) {
      if (!live()) return;
      this.policy.reset();
      this.current.checks.push(check(session.elapsed, 'unavailable', { sampleDuration: observationDuration(session) }));
      this.current.detail = `Check unavailable: ${String(error && error.message || error).slice(0, 180)}`;
      this.publish(); this.persist();
      if (error && error.needsUser) this.pause(this.current.detail);
    } finally {
      if (this.generation === token) this.working = false;
    }
  }
  finish() {
    this.cancel(); this.policy.reset(); this.working = false;
    if (this.current) {
      this.history = [this.current, ...this.history.filter((h) => h.id !== this.current.id)].slice(0, 30);
    }
    this.publish(); this.persist();
  }
  persist() {
    if (!this.d.historyFile) return;
    let saved = this.history;
    if (this.current && this.current.status !== 'ended') {
      const copy = Object.assign({}, this.current, { status: 'ended', detail: 'App closed or restarted' });
      saved = [copy, ...saved.filter((h) => h.id !== copy.id)];
    }
    try { fs.writeFileSync(this.d.historyFile, JSON.stringify(saved.slice(0, 30)), { mode: 0o600 }); } catch {}
  }
  snapshot() {
    return { current: this.current, history: this.history, revision: this.revision, sentAt: appleNow(), developerMode: this.developerMode };
  }
  publish() {
    this.revision += 1;
    this.d.onChange?.(this.snapshot());
  }
}

module.exports = { FocusCompanion, NudgePolicy, newSession, advance, clock, remaining, observationDuration, appleNow, APPLE_EPOCH };
