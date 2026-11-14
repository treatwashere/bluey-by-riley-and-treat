'use strict';
// Lets an iPhone paired with this PC talk to Bluey: the phone asks for a short-lived OpenAI Realtime key
// (the real key never leaves the PC) and sends tool calls back here. On Windows the focus tools work;
// pointing and computer control are Mac-only for now. Android phones use on-device speech instead.

const MODEL = 'gpt-realtime-2.1';

function personality(name) {
  return `You are ${name}, a small berry with big googly eyes who lives on a phone under the user's screen. ` +
    `You're a young British guy: dry, quick-witted, a bit cheeky, British phrasing. You never speak out loud: ` +
    `your replies pop up as a tiny speech bubble, so keep them to one short line, under fifteen words. Answer ` +
    `immediately with the actual answer. Never announce what you're going to do, never recap, never offer more help.`;
}

const GUIDE = `How the conversation works: the user holds the phone while speaking, then releases to send their request.
Only the held speech is sent. For a declared task, call focus_start immediately with task and duration (default 30
minutes), without confirmation. Never just say you are ready. When a request needs a tool, call the tool first with no
words before it, then reply in one short line. If a focus session already exists, a new task needs the user to end the
current one first. Pause, resume and end only when asked. One short witty British sentence. Never scold. Do not claim a
session started if its tool reports an error. When the user says goodbye or asks you to sleep, reply with a very short
goodbye and call go_to_sleep. You're running on a Windows PC: you can't point at or control the screen here.`;

const tool = (name, description, properties = {}, required = []) =>
  ({ type: 'function', name, description, parameters: { type: 'object', properties, required } });

const TOOLS = [
  tool('focus_start', 'Start focusing on the user\'s spoken task. Default 30 minutes unless they specify a duration. Call immediately when they describe what they want to work on.',
    { task: { type: 'string' }, minutes: { type: 'number' } }, ['task']),
  tool('focus_pause', 'Pause the focus timer and screenshot monitoring.'),
  tool('focus_resume', 'Resume a paused focus session.'),
  tool('focus_end', 'Finish focus and show the session timeline on the phone.'),
  tool('focus_status', 'Read the focus task, countdown and monitoring status.'),
  tool('go_to_sleep', 'Go back to quietly following the user\'s mouse with your eyes. Use when the user says bye or asks you to sleep.'),
];

async function mintToken(apiKey, name, extra, fetchImpl = globalThis.fetch) {
  if (!apiKey) throw new Error('Voice needs a ChatGPT (OpenAI) key. Add one in Bluey Settings.');
  const response = await fetchImpl('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime', model: MODEL,
        instructions: personality(name) + '\n\n' + GUIDE + (extra ? `\n\nRight now (state information only): ${extra}` : ''),
        output_modalities: ['text'],
        audio: { input: {
          format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null,
          noise_reduction: { type: 'near_field' }, transcription: { model: 'gpt-4o-mini-transcribe' },
        } },
        tools: TOOLS, tool_choice: 'auto',
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`OpenAI wouldn't start a voice session (HTTP ${response.status}).`);
  const json = await response.json();
  if (typeof json.value !== 'string') throw new Error("OpenAI wouldn't start a voice session.");
  return json.value;
}

function runTool(name, args, focus, clock) {
  switch (name) {
    case 'focus_start': return focus.start(args.task || '', Number(args.minutes ?? 30));
    case 'focus_pause': return focus.pause();
    case 'focus_resume': return focus.resume();
    case 'focus_end': return focus.end();
    case 'focus_status': {
      const s = focus.current;
      return s ? `Task: ${s.task}. ${s.status}, ${clock(s)} remaining. ${s.detail}` : 'No focus session yet.';
    }
    case 'go_to_sleep': return 'Going to sleep. Say a very short goodbye.';
    default: return `${name} isn't available on Windows yet. Tell the user in a few words.`;
  }
}

module.exports = { mintToken, runTool, TOOLS };
