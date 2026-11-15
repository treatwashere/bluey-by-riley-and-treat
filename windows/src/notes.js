'use strict';
// Meeting notes (Mac/MeetingNotes.swift for Windows): turns the phone's recorded audio into a transcript with
// speaker labels and keeps each session as plain files any agent can read: Documents\Bluey Notes\<date> <id>\.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL = 'gpt-4o-transcribe-diarize';
const FALLBACK = 'gpt-transcribe';
const root = () => path.join(os.homedir(), 'Documents', 'Bluey Notes');
const pad = (n) => String(n).padStart(2, '0');
const folderName = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;

function writeReadme() {
  const file = path.join(root(), 'README.md');
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, `# Bluey Notes

Meeting notes recorded by the Bluey phone app. One folder per listening session, named by start time.

In each session folder:
- \`notes.md\`: the full transcript with timestamps and speaker labels, plus your questions to Bluey, Bluey's replies and any research reports, in time order. Start here.
- \`session.json\`: the same data, structured.
- \`audio/\`: the raw recording, as five-minute AAC chunks.

Speaker letters (A, B, …) are assigned per five-minute chunk, so the same letter can mean different people in different chunks. Lines marked "(live)" are a rough live transcript for audio that hasn't been fully transcribed yet.
`);
}

/** The session's folder, made the first time it's needed. */
function folder(session, started) {
  fs.mkdirSync(root(), { recursive: true });
  writeReadme();
  const tag = String(session).slice(0, 8).toLowerCase();
  const existing = fs.readdirSync(root()).find((n) => n.endsWith(tag));
  if (existing) return path.join(root(), existing);
  const dir = path.join(root(), `${folderName(started)} ${tag}`);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  return dir;
}

async function post(apiKey, audio, fields, fetchImpl) {
  if (!apiKey) throw new Error('Meeting notes need a ChatGPT (OpenAI) key. Add one in Bluey Settings.');
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([audio], { type: 'audio/mp4' }), 'chunk.m4a');
  const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`transcription HTTP ${response.status}`);
  return response.json();
}

/** Saves the chunk's audio into the session folder and transcribes it (with speakers, or plain as a fallback). */
async function transcribe(apiKey, { audio, session, index, sessionStarted }, fetchImpl = globalThis.fetch) {
  const dir = folder(session, sessionStarted);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio', `chunk-${String(index).padStart(3, '0')}.m4a`), audio);
  let segments;
  try {
    const json = await post(apiKey, audio, { model: MODEL, response_format: 'diarized_json', chunking_strategy: 'auto' }, fetchImpl);
    const turns = [];
    for (const s of json.segments || []) {
      const seg = { speaker: s.speaker || '?', start: s.start || 0, end: s.end || 0, text: String(s.text || '').trim() };
      if (!seg.text) continue;
      const last = turns[turns.length - 1];
      if (last && last.speaker === seg.speaker && seg.start - last.end < 2.5) { last.text += ' ' + seg.text; last.end = seg.end; }
      else turns.push(seg);
    }
    segments = turns;
  } catch {
    const json = await post(apiKey, audio, { model: FALLBACK, response_format: 'json' }, fetchImpl);
    const text = String(json.text || '').trim();
    segments = text ? [{ speaker: '?', start: 0, end: 0, text }] : [];
  }
  return { segments, folder: dir };
}

/** Writes session.json and notes.md from the phone's copy of the session. Returns the folder. */
function write(json) {
  if (!json || typeof json.id !== 'string' || typeof json.started !== 'number') return null;
  const started = new Date(json.started * 1000);
  const dir = folder(json.id, started);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(dir, 'notes.md'), markdown(json, started));
  return dir;
}

function markdown(json, started) {
  const clock = (t) => new Date(t * 1000).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  const entries = json.entries || [];
  const out = [`# Bluey session: ${started.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}`, ''];
  if (typeof json.ended === 'number') {
    const minutes = Math.round((json.ended * 1000 - started.getTime()) / 60000);
    out.push(`Ended ${clock(json.ended)} (${Math.floor(minutes / 60)}h ${minutes % 60}m).`);
  } else out.push('Still recording.');
  if (json.transcribing > 0) out.push(`${json.transcribing} recording chunk(s) still being transcribed; this file updates when they're done.`);
  const asked = entries.filter((e) => e.kind === 'asked').length;
  if (asked) out.push(`You asked Bluey ${asked} question(s); they're marked inline below.`);
  out.push('', '## Transcript', '');
  for (const e of entries) {
    const text = String(e.text || '').trim();
    if (!text) continue;
    const time = typeof e.time === 'number' ? clock(e.time) : '';
    switch (e.kind) {
      case 'transcript': out.push(`**[${time}] Speaker ${e.speaker || '?'}:** ${text}`); break;
      case 'heard': out.push(`[${time}] (live) ${text}`); break;
      case 'asked': out.push(`> **[${time}] You asked Bluey:** ${text}`); break;
      case 'reply': out.push(`> **Bluey:** ${text}`); break;
      case 'codex': out.push(`> **[${time}] Codex:** ${text}`); break;
      case 'report': out.push('> **Research report:**\n' + text.split('\n').map((l) => '> ' + l).join('\n')); break;
      default: out.push(`[${time}] ${text}`);
    }
    out.push('');
  }
  return out.join('\n');
}

module.exports = { transcribe, write, root, markdown };
