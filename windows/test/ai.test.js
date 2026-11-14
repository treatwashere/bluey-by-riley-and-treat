'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AI, parseDecision, combine, parseOpenAIDecision } = require('../src/ai');

const fakeStore = (keys, settings) => ({
  get: (k) => Object.assign({ claudeModel: 'claude-opus-5-5', geminiModel: 'gemini-flash-latest', deepseekModel: 'deepseek-chat', openaiDecisionModel: 'gpt-6-luna', openaiModel: 'gpt-5.5' }, settings)[k],
  getKey: (k) => keys[k] || null, hasKey: (k) => !!keys[k],
});
const answer = (activity, on, off, unc) => JSON.stringify({ activity, probabilities: { on_task: on, off_task: off, uncertain: unc }, confidence: 0.8 });

test('parses fenced JSON and renormalises', () => {
  const d = parseDecision('```json\n' + answer('off_task', 0.2, 0.7, 0.2) + '\n```');
  assert.strictEqual(d.activity, 'off_task');
  assert.ok(Math.abs(d.probability - 0.7 / 1.1) < 1e-9);
  assert.throws(() => parseDecision('{"activity":"browsing"}'));
  assert.throws(() => parseDecision('hello'));
});

test('OpenAI Decisions answers are accepted', () => {
  const d = parseOpenAIDecision({ answers: [{ name: 'activity', type: 'choice', choice: 'on_task', confidence: 0.9,
    probabilities: [{ value: 'on_task', probability: 0.8 }, { value: 'off_task', probability: 0.15 }, { value: 'uncertain', probability: 0.05 }] }] });
  assert.strictEqual(d.activity, 'on_task');
});

test('all 4 combined averages and picks the majority', () => {
  const c = combine([parseDecision(answer('off_task', 0.1, 0.9, 0)), parseDecision(answer('on_task', 0.8, 0.1, 0.1)), parseDecision(answer('on_task', 0.8, 0.1, 0.1))]);
  assert.strictEqual(c.activity, 'on_task');
  assert.ok(Math.abs(c.probability - 1.1 / 3) < 1e-9);
});

test('each provider is called with the right endpoint and auth, and All 4 combines them', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url); calls.push({ url: u, headers: init.headers, body: JSON.parse(init.body) });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } });
    if (u.includes('api.openai.com/v1/decisions')) return json({ answers: [{ name: 'activity', type: 'choice', choice: 'off_task', confidence: 0.9, probabilities: [{ value: 'on_task', probability: 0.1 }, { value: 'off_task', probability: 0.9 }, { value: 'uncertain', probability: 0 }] }] });
    if (u.includes('api.anthropic.com')) return json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: answer('off_task', 0.2, 0.8, 0) }], usage: { input_tokens: 1, output_tokens: 1 } });
    if (u.includes('generativelanguage')) return json({ candidates: [{ content: { parts: [{ text: answer('on_task', 0.7, 0.2, 0.1) }] } }] });
    if (u.includes('deepseek')) return json({ choices: [{ message: { content: answer('off_task', 0.3, 0.6, 0.1) } }] });
    return new Response('{}', { status: 404 });
  };
  const ai = new AI(fakeStore({ openai: 'sk-o', anthropic: 'sk-ant', gemini: 'AIza', deepseek: 'sk-d' }, { aiProvider: 'all' }), fetch);
  const session = { task: 'Code the app', elapsed: 60, realElapsed: 60, checks: [] };
  const result = await ai.classify({ jpeg: Buffer.from('jpg'), app: 'Code', title: 'main.js' }, session, 3);
  assert.deepStrictEqual(result.providers, ['chatgpt', 'claude', 'gemini', 'deepseek']);
  assert.strictEqual(result.activity, 'off_task');
  assert.ok(Math.abs(result.probability - (0.9 + 0.8 + 0.2 + 0.6) / 4) < 1e-9);
  const claude = calls.find((c) => c.url.includes('anthropic'));
  assert.strictEqual(claude.body.model, 'claude-opus-5-5');
  assert.strictEqual(claude.body.content, undefined);
  assert.strictEqual(claude.body.messages[0].content[0].type, 'image');
  assert.strictEqual(claude.body.fallbacks, 'default');
  const ds = calls.find((c) => c.url.includes('deepseek'));
  assert.strictEqual(ds.headers.authorization, 'Bearer sk-d');
  assert.ok(!JSON.stringify(ds.body).includes('base64'), 'DeepSeek gets text only');
  const gm = calls.find((c) => c.url.includes('generativelanguage'));
  assert.strictEqual(gm.headers['x-goog-api-key'], 'AIza');

  // Only providers with keys take part; a missing key for a single choice is reported clearly.
  const onlyClaude = new AI(fakeStore({ anthropic: 'k' }, { aiProvider: 'all' }), fetch);
  assert.deepStrictEqual(onlyClaude.activeProviders(), ['claude']);
  const none = new AI(fakeStore({}, { aiProvider: 'gemini' }), fetch);
  await assert.rejects(none.classify({ jpeg: Buffer.alloc(1) }, session, 0), /Gemini \(Google\) key/);
});
