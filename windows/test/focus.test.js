'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FocusCompanion, NudgePolicy, newSession, advance, APPLE_EPOCH } = require('../src/focus');

test('developer clock runs 4x and pause freezes it', () => {
  const s = newSession('Test', 60, true);
  advance(s, 1);
  assert.strictEqual(s.elapsed, 4); assert.strictEqual(s.realElapsed, 1);
  s.status = 'paused'; advance(s, 100); assert.strictEqual(s.elapsed, 4);
  s.status = 'running'; advance(s, 20);
  assert.strictEqual(s.status, 'ended'); assert.strictEqual(s.elapsed, 60); assert.strictEqual(s.realElapsed, 15);
});

test('nudge needs consecutive majority off-task evidence over the required span', () => {
  const p = new NudgePolicy(45, false);
  const off = (elapsed, probability = 0.97) => ({ elapsed, activity: 'off_task', probability, confidence: 0.8 });
  assert.strictEqual(p.observe(off(30), 1), false);
  assert.strictEqual(p.observe(off(60), 1), false);
  assert.strictEqual(p.observe(off(90), 1), false);
  assert.strictEqual(p.observe(off(120), 1), false);
  assert.strictEqual(p.observe(off(150), 1), true); // 120 s span at strength ≥ 0.95
  // cooldown, stale and on-task results reset
  assert.strictEqual(p.observe(off(180), 25), false);
  assert.strictEqual(p.observe({ elapsed: 210, activity: 'on_task', probability: 0.1, confidence: 0.9 }, 1), false);
});

test('snapshots use Swift Codable conventions', () => {
  let synced;
  let t = 100;
  const c = new FocusCompanion({ now: () => t, hasKey: () => true, missingKey: () => '', onChange: (s) => { synced = s; } });
  c.heartbeat();
  assert.match(c.start('Write the README', 25), /Focus started/);
  const json = JSON.parse(JSON.stringify(synced));
  assert.match(json.current.id, /^[0-9A-F-]{36}$/);
  const unix = json.current.startedAt + APPLE_EPOCH;
  assert.ok(Math.abs(unix - Date.now() / 1000) < 5);
  for (const key of ['id', 'task', 'duration', 'startedAt', 'elapsed', 'status', 'detail', 'checks']) assert.ok(key in json.current, key);
  assert.strictEqual(json.current.duration, 1500);
  t += 1; c.tick();
  assert.strictEqual(c.current.elapsed, 1);
  assert.match(c.pause(), /paused/);
  assert.strictEqual(c.current.checks.at(-1).activity, 'paused');
  assert.match(c.end(), /finished/);
  assert.strictEqual(c.history.length, 1);
});

test('a check runs through capture, classify and nudge, then stops when disconnected', async () => {
  let t = 0; const nudges = [];
  const c = new FocusCompanion({
    now: () => t, hasKey: () => true, missingKey: () => '', idleSeconds: () => 0,
    capture: async () => ({ jpeg: Buffer.alloc(1) }),
    classify: async () => ({ activity: 'off_task', probability: 0.99, confidence: 0.9, probabilities: { on_task: 0, off_task: 0.99, uncertain: 0.01 } }),
    prepareNudge: async () => 'Oi, back to it.',
    onNudge: (m) => nudges.push(m), developerMode: true,
  });
  c.heartbeat(); c.start('Code', 30);
  for (let i = 0; i < 60; i++) {
    c.heartbeat(); t += 1; c.tick();
    for (let j = 0; j < 5; j++) await new Promise((r) => setImmediate(r));
  }
  assert.ok(c.current.checks.some((x) => x.activity === 'off_task'));
  assert.ok(nudges.length >= 1, 'nudged');
  assert.ok(c.current.checks.some((x) => x.nudged));
  t += 10; c.tick();
  assert.strictEqual(c.current.status, 'paused');
});
