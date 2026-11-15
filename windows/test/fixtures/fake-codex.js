#!/usr/bin/env node
// A pretend `codex app-server` for tests: answers initialize, thread/start and turn/start, then finishes the turn.
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thr_1' } } });
  else if (m.method === 'turn/start') {
    send({ id: m.id, result: {} });
    send({ method: 'turn/started', params: { threadId: m.params.threadId, turn: { id: 'turn_1' } } });
    send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: m.params.threadId } });
    setTimeout(() => send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'Made the README friendlier.' }] } } }), 50);
  } else if (m.id === 99) process.stderr.write('approval answered ' + JSON.stringify(m.result) + '\n');
});
