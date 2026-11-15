'use strict';
const $ = (id) => document.getElementById(id);
const KEY_INFO = [
  { id: 'openai', title: 'ChatGPT (OpenAI)', placeholder: 'sk-…' },
  { id: 'anthropic', title: 'Claude (Anthropic)', placeholder: 'sk-ant-…' },
  { id: 'gemini', title: 'Gemini (Google)', placeholder: 'AIza…' },
  { id: 'deepseek', title: 'DeepSeek', placeholder: 'sk-…' },
];
const PROVIDER_KEY = { chatgpt: 'openai', claude: 'anthropic', gemini: 'gemini', deepseek: 'deepseek' };
const MODELS = [
  ['openaiDecisionModel', 'ChatGPT checks'], ['openaiModel', 'ChatGPT wording'],
  ['claudeModel', 'Claude'], ['geminiModel', 'Gemini'], ['deepseekModel', 'DeepSeek'],
];
let state = null;
let built = false;

const clock = (seconds) => {
  const n = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};
const gradient = (c) => `linear-gradient(135deg, ${c.berry[0]} 0%, ${c.berry[1]} 34%, ${c.berry[2]} 68%, ${c.berry[3]} 100%)`;
const say = (text) => { $('message').textContent = text || ''; };

function build() {
  built = true;
  for (const c of state.colours) {
    const b = document.createElement('button');
    b.className = 'swatch'; b.dataset.id = c.id;
    b.innerHTML = '<span class="dot"></span><span></span>';
    b.querySelector('.dot').style.background = gradient(c);
    b.lastChild.textContent = c.name;
    b.onclick = async () => render(await window.bluey.set('colour', c.id));
    $('swatches').append(b);
  }
  for (const p of state.providers) {
    const label = document.createElement('label');
    label.className = 'provider'; label.dataset.id = p.id;
    label.innerHTML = '<input type="radio" name="provider"><span></span><small></small>';
    label.querySelector('span').textContent = p.title;
    label.querySelector('input').onchange = async () => render(await window.bluey.set('aiProvider', p.id));
    $('providers').append(label);
  }
  for (const k of KEY_INFO) {
    const row = document.createElement('div');
    row.className = 'key';
    row.innerHTML = '<div class="name"><span></span><span class="ok"></span></div><input type="password" autocomplete="off" spellcheck="false"><button class="btn">Save</button>';
    row.querySelector('.name span').textContent = k.title;
    const input = row.querySelector('input');
    input.setAttribute('aria-label', `${k.title} API key`);
    row.querySelector('button').onclick = async () => {
      const value = input.value.trim();
      if (!value && !state.keys[k.id]) return;
      if (!value && !confirm(`Remove your ${k.title} key?`)) return;
      input.value = '';
      render(await window.bluey.setKey(k.id, value));
      say(value ? `${k.title} key saved.` : `${k.title} key removed.`);
    };
    row.dataset.id = k.id;
    $('keys').append(row);
  }
  for (const [id, title] of MODELS) {
    const span = document.createElement('span'); span.textContent = title;
    const input = document.createElement('input'); input.type = 'text'; input.id = 'model-' + id; input.spellcheck = false;
    input.onchange = async () => { if (input.value.trim()) render(await window.bluey.set(id, input.value.trim())); };
    $('models').append(span, input);
  }
  $('qr').onclick = () => $('qr').classList.toggle('shown');
  $('copyCode').onclick = async () => { await window.bluey.pairing('copy'); say('Pairing code copied. On Android you can paste it instead of scanning.'); };
  $('resetCode').onclick = async () => {
    if (!confirm('Make a new pairing code? Every paired phone will need to scan again.')) return;
    render(await window.bluey.pairing('reset')); say('New code ready.');
  };
  $('start').onclick = async () => say(await window.bluey.focus('start', { task: $('task').value, minutes: Number($('minutes').value) }));
  $('task').onkeydown = (e) => { if (e.key === 'Enter') $('start').click(); };
  $('pauseResume').onclick = async () => say(await window.bluey.focus(state.focus.status === 'running' ? 'pause' : 'resume'));
  $('end').onclick = async () => say(await window.bluey.focus('end'));
  $('developer').onchange = async (e) => say(await window.bluey.focus('developer', { enabled: e.target.checked }));
  $('testNudge').onclick = async () => say(await window.bluey.focus('testNudge'));
  for (const id of ['showCursor', 'followMouse', 'computerControl']) $(id).onchange = async (e) => render(await window.bluey.set(id, e.target.checked));
  for (const id of ['cursorSize', 'phonePosition']) $(id).onchange = async (e) => render(await window.bluey.set(id, Number(e.target.value)));
  for (const id of ['trail', 'mood']) $(id).onchange = async (e) => render(await window.bluey.set(id, e.target.value));
  for (const m of state.moods) { const o = document.createElement('option'); o.value = m; o.textContent = m[0].toUpperCase() + m.slice(1); $('mood').append(o); }
  $('savePersonality').onclick = async () => { render(await window.bluey.set('personality', $('personality').value.trim())); say('Personality saved. He picks it up next time he wakes.'); };
  $('resetPersonality').onclick = async () => { $('personality').value = ''; render(await window.bluey.set('personality', '')); say('Back to his usual self.'); };
  $('codexPath').onchange = async (e) => render(await window.bluey.set('codexPath', e.target.value.trim()));
  for (const [id, action] of [['wake', 'wake'], ['stop', 'stop'], ['talkTest', 'talkTest'], ['codexFolder', 'codexFolder'], ['openNotes', 'notes']]) {
    $(id).onclick = async () => render(await window.bluey.action(action));
  }
  window.BlueyFace.start($('face'), () => (state.colours.find((c) => c.id === state.settings.colour) || state.colours[0]));
}

function render(next) {
  state = next;
  if (!built) build();
  const colour = state.colours.find((c) => c.id === state.settings.colour) || state.colours[0];
  document.documentElement.style.setProperty('--berry', colour.berry[1]);
  document.documentElement.style.setProperty('--berry-deep', colour.berry[2]);
  $('title').textContent = `${colour.name} · focus friend`;
  document.title = `${colour.name} Settings`;
  $('status').textContent = state.phones.length ? `Phone connected: ${state.phones.join(', ')}` : 'Waiting for your phone. Pair it below.';
  for (const b of document.querySelectorAll('.swatch')) b.setAttribute('aria-pressed', String(b.dataset.id === colour.id));
  for (const label of document.querySelectorAll('.provider')) {
    const id = label.dataset.id;
    const on = state.settings.aiProvider === id;
    label.classList.toggle('on', on);
    label.querySelector('input').checked = on;
    const needed = id === 'all' ? Object.values(PROVIDER_KEY) : [PROVIDER_KEY[id]];
    const have = needed.filter((k) => state.keys[k]).length;
    label.querySelector('small').textContent = id === 'all' ? `${have} of 4 keys added` : have ? 'Key added' : 'Needs a key';
  }
  for (const row of document.querySelectorAll('.key')) {
    const has = state.keys[row.dataset.id];
    row.querySelector('.ok').textContent = has ? '✓ Saved' : '';
    row.querySelector('input').placeholder = has ? 'Saved · paste a new key to replace, or Save empty to remove' : KEY_INFO.find((k) => k.id === row.dataset.id).placeholder;
  }
  for (const [id] of MODELS) { const input = $('model-' + id); if (document.activeElement !== input) input.value = state.settings[id] || ''; }
  $('qr').src = state.pairing.qr;
  $('pairName').textContent = `This PC appears as “${state.pairing.name}”.`;
  const s = state.focus && state.focus.status !== 'ended' ? state.focus : null;
  $('startRow').hidden = !!s; $('sessionRow').hidden = !s;
  if (s) {
    $('sessionTask').textContent = s.task;
    $('sessionClock').textContent = `${s.status === 'paused' ? 'Paused · ' : ''}${clock(s.duration - s.elapsed)} left`;
    $('pauseResume').textContent = s.status === 'running' ? 'Pause' : 'Resume';
    $('sessionDetail').textContent = s.detail;
  } else $('sessionDetail').textContent = state.active.length ? '' : 'Add a key for your chosen AI before starting.';
  $('developer').checked = state.developerMode;
  $('testNudge').hidden = !state.developerMode;
  $('showCursor').checked = state.settings.showCursor !== false;
  $('followMouse').checked = state.settings.followMouse !== false;
  $('computerControl').checked = state.settings.computerControl !== false;
  $('computerControl').disabled = !state.windows;
  $('cursorSize').value = String(state.settings.cursorSize || 72);
  $('trail').value = state.settings.trail || 'comet';
  $('phonePosition').value = String(state.settings.phonePosition ?? 0.5);
  $('mood').value = state.settings.mood || 'listening';
  if (document.activeElement !== $('personality')) $('personality').value = state.settings.personality || state.defaultPersonality;
  if (document.activeElement !== $('codexPath')) $('codexPath').value = state.settings.codexPath || '';
  $('codexHint').textContent = state.codexInstalled
    ? 'Codex is installed. Ask him to get Codex to do something; jobs run in Documents\\Bluey and he tells you when they finish.'
    : 'Codex isn\u2019t installed. Install it with “npm install -g @openai/codex”, sign in with “codex login”, then restart Bluey.';
  const jobs = $('codexJobs'); jobs.textContent = '';
  for (const j of state.codexJobs) { const d = document.createElement('div'); d.textContent = `${j.project}: ${j.prompt} (${j.status})`; jobs.append(d); }
  $('notesHint').textContent = `When the iPhone app records a session, transcripts with speaker labels are saved to ${state.notesFolder}. Uses your ChatGPT key.`;
  $('wake').textContent = state.awake ? 'Go to Sleep' : 'Wake Up and Talk';
  $('wake').disabled = !state.phones.length;
  const hist = $('history'); hist.textContent = '';
  for (const h of state.history.slice(0, 5)) {
    const div = document.createElement('div'); div.className = 'hist';
    const checks = h.checks.filter((c) => c.activity !== 'paused');
    const on = checks.filter((c) => c.activity === 'on_task').length;
    div.textContent = `${h.task} · ${clock(h.elapsed)} focused · ${checks.length ? Math.round(100 * on / checks.length) + '% on task' : 'no checks'}`;
    const bar = document.createElement('div'); bar.className = 'timeline';
    for (const c of checks) { const i = document.createElement('i'); i.className = ['on_task', 'off_task'].includes(c.activity) ? c.activity : 'other'; bar.append(i); }
    hist.append(div, bar);
  }
}

window.bluey.onState(render);
window.bluey.state().then(render);
