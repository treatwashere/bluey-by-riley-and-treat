'use strict';
// The research report card (Mac/ReportPanel.swift): shows while he researches, then previews the first lines.
// Click to expand; it stays until you press the minus button.
const card = document.getElementById('card');
let state = { question: '', report: null, error: null, expanded: false, colour: null };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

function render() {
  if (state.colour) document.documentElement.style.setProperty('--berry', state.colour.berry[1]);
  card.textContent = '';
  const header = el('header');
  const r = state.report;
  header.append(el('h1', '', r ? r.title : state.error ? 'Research' : 'Researching…'));
  const close = el('button', '', '−'); close.title = 'Close';
  close.onclick = (e) => { e.stopPropagation(); window.bluey.reportAction('close'); };
  header.append(close);
  card.append(header);
  if (r) {
    if (state.expanded) {
      const body = el('div', 'body');
      for (const p of r.paragraphs) body.append(el('p', '', p));
      if (r.sources.length) {
        body.append(el('div', 'label', 'SOURCES'));
        for (const s of r.sources) {
          const a = el('a', '', s.title); a.href = '#';
          a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); window.bluey.reportAction('open', s.url); };
          body.append(a);
        }
      }
      card.append(body);
    } else {
      card.append(el('div', 'preview', r.paragraphs.join(' ')), el('div', 'more', 'Click to read more'));
    }
  } else if (state.error) {
    card.append(el('div', 'preview', state.error));
  } else {
    const loading = el('div', 'loading'); loading.append(el('div', 'spinner'), el('span', '', `Doing some research on “${state.question}”`));
    card.append(loading);
  }
}
card.addEventListener('click', () => { if (state.report) window.bluey.reportAction('toggle'); });
window.bluey.onReport((s) => { state = s; render(); });
