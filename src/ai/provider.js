'use strict';

/**
 * Unified AI chat client. Picks provider based on `AI_PROVIDER` env:
 *
 *   AI_PROVIDER=openai      + OPENAI_API_KEY    + OPENAI_MODEL    (default: gpt-4o-mini)
 *   AI_PROVIDER=anthropic   + ANTHROPIC_API_KEY + ANTHROPIC_MODEL (default: claude-haiku-4-5)
 *   AI_PROVIDER unset                             → disabled; every
 *                                                   call throws AiDisabled.
 *
 * In production, having BOTH keys set is a configuration mistake — we
 * warn at startup but still pick whichever AI_PROVIDER names (falls
 * back to 'openai' if a key is present).
 *
 * Exposes:
 *   - chat(messages, { json, maxTokens, temperature })
 *   - transcribe(audioBuffer, { mimeType, filename })   (OpenAI/Whisper only)
 *   - provider()              → 'openai' | 'anthropic' | null
 *   - enabled()               → boolean
 */

const config = require('../config');

class AiDisabled extends Error {
  constructor() { super('AI provider not configured'); this.name = 'AiDisabled'; }
}

const DEFAULTS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
};

function resolve() {
  const raw = (process.env.AI_PROVIDER || '').toLowerCase();
  const hasOpenAi = !!process.env.OPENAI_API_KEY;
  const hasAnth = !!process.env.ANTHROPIC_API_KEY;

  if (raw && !['openai', 'anthropic'].includes(raw)) {
    throw new Error(`[ai] Unknown AI_PROVIDER='${raw}' — use 'openai' or 'anthropic'.`);
  }
  if (hasOpenAi && hasAnth && !raw) {
    console.warn('[ai] Both OPENAI_API_KEY and ANTHROPIC_API_KEY are set. Pick one by setting AI_PROVIDER explicitly — defaulting to openai.');
  }

  const provider = raw || (hasOpenAi ? 'openai' : hasAnth ? 'anthropic' : null);
  if (!provider) return { provider: null };

  if (provider === 'openai' && !hasOpenAi) {
    console.warn('[ai] AI_PROVIDER=openai but OPENAI_API_KEY is missing — AI disabled.');
    return { provider: null };
  }
  if (provider === 'anthropic' && !hasAnth) {
    console.warn('[ai] AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing — AI disabled.');
    return { provider: null };
  }
  return {
    provider,
    model: provider === 'openai'
      ? (process.env.OPENAI_MODEL || DEFAULTS.openai)
      : (process.env.ANTHROPIC_MODEL || DEFAULTS.anthropic),
  };
}

const RESOLVED = resolve();

function provider() { return RESOLVED.provider; }
function enabled() { return !!RESOLVED.provider; }

/**
 * Send a chat turn. `messages` is OpenAI-format:
 *   [{ role: 'system' | 'user' | 'assistant', content: string }, ...]
 * When `json: true` we ask the model to respond with pure JSON.
 */
async function chat(messages, opts = {}) {
  if (!RESOLVED.provider) throw new AiDisabled();
  const { json = false, maxTokens = 800, temperature = 0.3 } = opts;

  if (RESOLVED.provider === 'openai') return chatOpenAi(messages, { json, maxTokens, temperature });
  if (RESOLVED.provider === 'anthropic') return chatAnthropic(messages, { json, maxTokens, temperature });
  throw new Error(`[ai] unreachable provider: ${RESOLVED.provider}`);
}

async function chatOpenAi(messages, { json, maxTokens, temperature }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: RESOLVED.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: json ? { type: 'json_object' } : undefined,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`[ai:openai] HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text, raw: data };
}

async function chatAnthropic(messages, { json, maxTokens, temperature }) {
  // Anthropic doesn't accept a 'system' role inside the messages array —
  // pull it out to a top-level field.
  const systems = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role, content: m.content,
  }));

  // When json:true, we just append a hint — Anthropic's structured-output
  // is less strict than OpenAI's, so we parse on the client side too.
  let system = systems || 'You are a helpful assistant.';
  if (json) system += '\n\nRespond ONLY with valid JSON, no prose, no markdown.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: RESOLVED.model,
      system,
      messages: rest,
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`[ai:anthropic] HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    : '';
  return { text, raw: data };
}

/**
 * Whisper audio transcription (OpenAI only). Returns plaintext.
 * Other providers aren't wired yet.
 */
async function transcribe(audioBuffer, { mimeType = 'audio/m4a', filename = 'audio.m4a', language } = {}) {
  if (!RESOLVED.provider) throw new AiDisabled();
  if (RESOLVED.provider !== 'openai') {
    throw new Error('[ai] transcription currently requires AI_PROVIDER=openai (Whisper).');
  }
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append('file', blob, filename);
  form.append('model', 'whisper-1');
  if (language) form.append('language', language);
  form.append('response_format', 'text');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`[ai:whisper] HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return (await res.text()).trim();
}

/** Strip common JSON fence / prose and try to parse. */
function parseJsonLenient(text) {
  if (!text) return null;
  // Strip markdown fences
  let s = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  // Slice between first { ... last }  / first [ ... last ]
  const first = Math.min(
    ...['{', '['].map((c) => { const i = s.indexOf(c); return i < 0 ? Infinity : i; }),
  );
  const last = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (first < Infinity && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

if (!RESOLVED.provider && config.isProd) {
  console.warn('[ai] No AI provider configured — /ai/* endpoints will return 503.');
}

module.exports = { chat, transcribe, provider, enabled, parseJsonLenient, AiDisabled };
