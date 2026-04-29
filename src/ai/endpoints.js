'use strict';

const { chat, transcribe, parseJsonLenient, enabled, AiDisabled } = require('./provider');
const { readJson, ok, badRequest, serverError } = require('../util/response');
const { check, send429 } = require('../middleware/rateLimit');

// Conservative rate limits — AI calls cost money.
const rl = (key, max, windowMs) => ({ key, max, windowMs });

function disabled(res) {
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'AI not configured on this server' }));
}

/**
 * POST /ai/extract-tasks  { text, context_hint? }
 *
 * Takes one plaintext message and asks the model to extract actionable
 * to-dos. Returns `[{ title, description, priority, due_at }]`. The
 * client fans this out as swipeable suggestion cards — user can edit
 * each one before creating.
 *
 * NOTE: The sender client is responsible for only sending a message it
 *       already has in plaintext on-device. We never pull ciphertext
 *       from the DB and decrypt server-side.
 */
async function extractTasks(req, res) {
  if (!enabled()) return disabled(res);
  const body = await readJson(req).catch(() => null);
  const text = (body?.text || '').toString().trim();
  if (!text) return badRequest(res, 'text required');
  if (text.length > 4000) return badRequest(res, 'text too long (max 4000 chars)');

  const gate = check([rl(`ai:extract:${req.auth.userId}`, 60, 60 * 60 * 1000)]);
  if (!gate.ok) return send429(res, gate);

  try {
    const out = await chat([
      { role: 'system', content: SYS_EXTRACT },
      { role: 'user',   content: `Nachricht:\n"""${text}"""` },
    ], { json: true, maxTokens: 700, temperature: 0.2 });

    const parsed = parseJsonLenient(out.text);
    const list = Array.isArray(parsed) ? parsed : parsed?.tasks;
    const tasks = (Array.isArray(list) ? list : [])
      .filter((t) => t && typeof t.title === 'string' && t.title.trim().length > 0)
      .slice(0, 6)
      .map((t) => ({
        title: String(t.title).trim().slice(0, 120),
        description: t.description ? String(t.description).trim().slice(0, 600) : null,
        priority: ['low', 'med', 'high', 'urgent'].includes(t.priority) ? t.priority : 'med',
        due_at: normalizeDueDate(t.due_at || t.due),
        confidence: typeof t.confidence === 'number' ? Math.max(0, Math.min(1, t.confidence)) : 0.7,
      }));
    ok(res, { tasks });
  } catch (err) {
    if (err instanceof AiDisabled) return disabled(res);
    serverError(res, 'AI extract failed', err);
  }
}

/**
 * POST /ai/smart-replies  { context: string[] }
 * `context` is the last ~10 decrypted messages in chronological order,
 * newest last. Returns 3 one-line suggested replies.
 */
async function smartReplies(req, res) {
  if (!enabled()) return disabled(res);
  const body = await readJson(req).catch(() => null);
  const ctx = Array.isArray(body?.context) ? body.context.slice(-10) : null;
  if (!ctx || ctx.length === 0) return badRequest(res, 'context[] required');

  const gate = check([rl(`ai:reply:${req.auth.userId}`, 120, 60 * 60 * 1000)]);
  if (!gate.ok) return send429(res, gate);

  try {
    const convo = ctx.map((m) => `- ${m}`).join('\n');
    const out = await chat([
      { role: 'system', content: SYS_REPLY },
      { role: 'user', content: `Letzte Nachrichten (chronologisch):\n${convo}\n\nGib 3 kurze, unterschiedliche Antworten für mich als JSON-Array zurück: ["...", "...", "..."]` },
    ], { json: true, maxTokens: 200, temperature: 0.6 });

    const parsed = parseJsonLenient(out.text);
    const list = Array.isArray(parsed) ? parsed : parsed?.replies;
    const replies = (Array.isArray(list) ? list : [])
      .filter((s) => typeof s === 'string' && s.trim().length > 0)
      .slice(0, 3)
      .map((s) => s.trim().slice(0, 180));
    ok(res, { replies });
  } catch (err) {
    if (err instanceof AiDisabled) return disabled(res);
    serverError(res, 'AI reply failed', err);
  }
}

/**
 * POST /ai/summarize  { messages: string[], locale? }
 * Condenses a long chat into a short catch-up summary for "Was habe
 * ich verpasst?".
 */
async function summarize(req, res) {
  if (!enabled()) return disabled(res);
  const body = await readJson(req).catch(() => null);
  const msgs = Array.isArray(body?.messages) ? body.messages.slice(-200) : null;
  if (!msgs || msgs.length === 0) return badRequest(res, 'messages[] required');

  const gate = check([rl(`ai:summarize:${req.auth.userId}`, 30, 60 * 60 * 1000)]);
  if (!gate.ok) return send429(res, gate);

  try {
    const out = await chat([
      { role: 'system', content: SYS_SUMMARIZE },
      { role: 'user', content: `Chatverlauf:\n${msgs.map((m, i) => `${i + 1}. ${m}`).join('\n')}` },
    ], { maxTokens: 500, temperature: 0.3 });
    ok(res, { summary: out.text.trim() });
  } catch (err) {
    if (err instanceof AiDisabled) return disabled(res);
    serverError(res, 'AI summarize failed', err);
  }
}

/**
 * POST /ai/translate  { text, target: 'de' | 'en' | 'fr' | ... }
 *
 * Returns `{ translated, source_lang, same_as_target }`. When the
 * detected source already matches the target, `translated` is just
 * the original text and `same_as_target = true` so the auto-translate
 * client logic can render the message untouched without showing a
 * "Translated from XX" badge.
 */
async function translate(req, res) {
  if (!enabled()) return disabled(res);
  const body = await readJson(req).catch(() => null);
  const text = (body?.text || '').toString().trim();
  const target = (body?.target || 'en').toString();
  if (!text) return badRequest(res, 'text required');
  if (text.length > 4000) return badRequest(res, 'text too long');

  const gate = check([rl(`ai:translate:${req.auth.userId}`, 400, 60 * 60 * 1000)]);
  if (!gate.ok) return send429(res, gate);

  try {
    const out = await chat([
      { role: 'system', content:
        `You translate user-submitted chat messages. Reply STRICTLY as JSON with shape ` +
        `{"source_lang":"<ISO 639-1 code>","translated":"<text>"}. ` +
        `If the source language is already the same as the requested target, set translated equal ` +
        `to the original text. Preserve emojis, formatting, line breaks, mentions, urls.` },
      { role: 'user', content: `Target language: ${target}\n\nMessage:\n${text}` },
    ], { json: true, maxTokens: 700, temperature: 0 });

    let parsed = null;
    try { parsed = JSON.parse(out.text); } catch { /* fall through */ }
    const sourceLang = (parsed?.source_lang || '').toString().slice(0, 8).toLowerCase() || null;
    const translated = (parsed?.translated || out.text || '').toString().trim();
    const sameAsTarget = !!sourceLang && sourceLang.split('-')[0] === target.split('-')[0].toLowerCase();
    ok(res, { translated, source_lang: sourceLang, same_as_target: sameAsTarget });
  } catch (err) {
    if (err instanceof AiDisabled) return disabled(res);
    serverError(res, 'AI translate failed', err);
  }
}

/**
 * POST /ai/transcribe  (multipart: field `audio`)
 * For voice-note transcription. Whisper via OpenAI. Returns plain text.
 */
async function transcribeVoice(req, res) {
  if (!enabled()) return disabled(res);
  const gate = check([rl(`ai:transcribe:${req.auth.userId}`, 60, 60 * 60 * 1000)]);
  if (!gate.ok) return send429(res, gate);

  // Buffer raw body (octet-stream upload)
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 25 * 1024 * 1024) return badRequest(res, 'audio too large (25 MB max)');
    chunks.push(c);
  }
  const audio = Buffer.concat(chunks);
  if (audio.length === 0) return badRequest(res, 'empty upload');

  const mime = req.headers['content-type'] || 'audio/m4a';
  const lang = req.headers['x-audio-lang'] || undefined;

  try {
    const text = await transcribe(audio, { mimeType: mime, filename: 'clip.m4a', language: lang });
    ok(res, { text });
  } catch (err) {
    if (err instanceof AiDisabled) return disabled(res);
    serverError(res, 'AI transcribe failed', err);
  }
}

/**
 * GET /ai/status — clients check this on launch.
 */
async function status(req, res) {
  const { provider } = require('./provider');
  ok(res, { enabled: enabled(), provider: provider() });
}

// ── Prompts ──────────────────────────────────────────────────────────────

const SYS_EXTRACT = `Du bist ein Assistent, der aus einer Nachricht konkrete Aufgaben (To-dos) extrahiert.
Antwortformat: EIN JSON-Objekt { "tasks": [ ... ] }. Jeder Eintrag hat:
  - title (max 120 Zeichen, klar, handlungsorientiert)
  - description (optional, max 600 Zeichen, zusätzlicher Kontext)
  - priority ("low" | "med" | "high" | "urgent")
  - due_at (ISO 8601 Datum ODER null; interpretiere "heute", "morgen", "nächsten Montag" in Europa/Berlin-Zeit)
  - confidence (0..1)

Regeln:
- Wenn nichts konkret zu tun ist: gib "tasks": [] zurück.
- Keine erfundenen Namen, keine Erklärungen außerhalb des JSON.
- Wenn mehrere Aufgaben erkennbar sind (Aufzählung, mehrere Sätze): alle einzeln extrahieren.
- Sehr kurze oder mehrdeutige Nachrichten: lieber null zurückgeben statt raten.
- Nur die JSON-Antwort ausgeben, nichts drumherum.`;

const SYS_REPLY = `Du bist ein freundlicher Chat-Assistent. Schlage mir als Antwortender drei kurze, unterschiedliche Antworten auf die letzte Nachricht vor.
Regeln:
- Jede Antwort maximal 14 Wörter.
- Zwei direkte, eine optional humorvoll.
- Sprache der letzten Nachricht anpassen (DE bleibt DE, EN bleibt EN).
- Ausgabe als JSON-Array von Strings. Kein Prosa, keine Erklärung.`;

const SYS_SUMMARIZE = `Du bist ein Assistent, der lange Chatverläufe zusammenfasst.
Regel: Kurz halten (max 5 Bullet-Points), nur faktisch, kein "Der User sagt...", in derselben Sprache wie der Verlauf.`;

function normalizeDueDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  // Clamp to +/- 2 years sanity bounds.
  const now = Date.now();
  if (d.getTime() < now - 7 * 86400_000) return null; // past dates beyond a week are bogus
  if (d.getTime() > now + 2 * 365 * 86400_000) return null;
  return d.toISOString();
}

module.exports = {
  extractTasks, smartReplies, summarize, translate, transcribeVoice, status,
};
