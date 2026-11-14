'use strict';
// Same colours as Shared/Palette.swift and the Android app. 0xRRGGBB as hex strings.
const COLOURS = [
  { id: 'bluey',   name: 'Bluey',   berry: ['#A9BCFF', '#6C86F5', '#4254D6', '#2B2F8F'], nose: '#1C1F66' },
  { id: 'greenie', name: 'Greenie', berry: ['#B6F2B0', '#6FD873', '#34A853', '#1E6B34'], nose: '#0F3D1D' },
  { id: 'reddie',  name: 'Reddie',  berry: ['#FFB3B3', '#F2706E', '#D63C3C', '#8F1F2B'], nose: '#5A0F18' },
  { id: 'azure',   name: 'Azure',   berry: ['#B3ECFF', '#5CC8F5', '#1E9BD7', '#0F5E8F'], nose: '#083A5A' },
  { id: 'purply',  name: 'Purply',  berry: ['#D9BBFF', '#A779F5', '#7442D6', '#452B8F'], nose: '#2A1766' },
  { id: 'pinky',   name: 'Pinky',   berry: ['#FFC2E5', '#F57FC0', '#D6409A', '#8F2265'], nose: '#5A1240' },
  { id: 'sunny',   name: 'Sunny',   berry: ['#FFF0A8', '#FFD84D', '#F2B01E', '#A8700A'], nose: '#5E3D05' },
  { id: 'orangey', name: 'Orangey', berry: ['#FFD0A8', '#FFA05C', '#F07222', '#A8460A'], nose: '#5E2505' },
];
const named = (id) => COLOURS.find((c) => c.id === String(id || '').toLowerCase()) || null;

const PROVIDERS = [
  { id: 'chatgpt',  title: 'ChatGPT (OpenAI)' },
  { id: 'claude',   title: 'Claude (Anthropic)' },
  { id: 'gemini',   title: 'Gemini (Google)' },
  { id: 'deepseek', title: 'DeepSeek' },
  { id: 'all',      title: 'All 4 combined' },
];
const members = (id) => (id === 'all' ? ['chatgpt', 'claude', 'gemini', 'deepseek'] : [id]);

module.exports = { COLOURS, named, PROVIDERS, members };
