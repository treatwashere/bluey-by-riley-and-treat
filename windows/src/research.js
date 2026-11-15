'use strict';
// Looks things up on the web with OpenAI's Responses API and its web search tool (Mac/WebResearch.swift).
const MODEL = 'gpt-5.5';

async function research(apiKey, question, context, fetchImpl = globalThis.fetch) {
  if (!apiKey) throw new Error('I need a ChatGPT (OpenAI) key for research. Add one in Bluey Settings.');
  let input = question;
  if (context) input += `\n\nWhat's on the user's screen, for context: ${context}`;
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, reasoning: { effort: 'low' }, tools: [{ type: 'web_search' }],
      instructions: 'Research the question on the web and write a short, friendly report for a busy person. ' +
        'First line: a plain title of under eight words. Then one to four short paragraphs (four at most), ' +
        'leading with the direct answer, then the most useful details. Plain text only: no markdown, ' +
        'no headings, no bullet lists, and no links or citations in the text.',
      input,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(`The research didn't come back (HTTP ${response.status}).`);
  const json = await response.json();
  let text = '';
  const sources = [];
  for (const item of json.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      text += part.text || '';
      for (const note of part.annotations || []) {
        if (!note.url) continue;
        let url;
        try { url = new URL(note.url); url.searchParams.delete('utm_source'); url = url.toString(); } catch { continue; }
        if (!sources.some((s) => s.url === url)) sources.push({ title: note.title || new URL(url).host, url });
      }
    }
  }
  text = text.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s*\[https?:\/\/[^\]]*\]/g, '').replace(/\*\*/g, '').replace(/#/g, '');
  const blocks = text.split('\n').map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) throw new Error("The research didn't come back: empty answer.");
  return { question, title: blocks[0], paragraphs: blocks.slice(1, 5), sources: sources.slice(0, 5),
    get plainText() { return [this.title, ...this.paragraphs].join('\n\n'); } };
}

module.exports = { research, MODEL };
