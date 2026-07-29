'use strict';

/**
 * Live meeting AI copilot — server side.
 *
 * A PRIVATE, in-meeting sales/negotiation assistant. The client taps two audio
 * streams ("self" = the local mic, "remote" = the mixed audio of everyone else),
 * encodes each as short webm/opus chunks (~3–4 s) and ships them over the WS as
 * base64 in a JSON envelope. We transcribe each chunk with Whisper (the existing
 * `ai.transcribe`), keep a rolling, speaker-labelled transcript, and — debounced
 * — ask `ai.chat` for short, actionable suggestions (objection handling, next
 * question, closing nudge) toward a user-supplied GOAL.
 *
 * Everything is per-connection and ephemeral (RAM only, no DB): the transcript is
 * private and never persisted. Suggestions are pushed back to the SAME socket that
 * sent the audio, so only that user ever sees them.
 *
 * Cost control: the copilot only runs while the user has it switched on, and each
 * session has hard caps (max duration, transcript window). Whisper chunking is
 * ~10× cheaper than the Realtime API and 2–3 s latency is plenty for a copilot.
 */

const ai = require('../ai/provider');

// ── Guards ──────────────────────────────────────────────────────────────────
const MAX_SESSION_MS = 90 * 60 * 1000;   // auto-stop a copilot after 90 min
const TRANSCRIPT_MAX = 60;                // keep the last N utterances in RAM
const TRANSCRIPT_CHARS = 6000;            // …and cap the prompt size
const SUGGEST_DEBOUNCE_MS = 1800;         // wait this long after new remote speech
const SUGGEST_MIN_GAP_MS = 4000;          // never suggest more often than this
const PROACTIVE_MS = 25000;               // proactively nudge if idle this long
const GOAL_MAX = 600;                     // clamp the goal text
const CHUNK_MAX_BYTES = 2 * 1024 * 1024;  // reject oversized audio chunks (~2 MB)

/** deviceId -> AssistantSession */
const sessions = new Map();

class AssistantSession {
  constructor(deviceId, send) {
    this.deviceId = deviceId;
    this.send = send;                 // (payload) => void  — replies to THIS socket
    this.goal = '';
    this.utterances = [];             // [{ who:'self'|'remote', text, at }]
    this.startedAt = Date.now();
    this.lastSuggestAt = 0;
    this.lastRemoteAt = 0;
    this.pendingTranscribe = 0;       // in-flight Whisper calls
    this.suggestTimer = null;
    this.proactiveTimer = null;
    this.closed = false;
    this.maxTimer = setTimeout(() => this.stop('max_duration'), MAX_SESSION_MS);
    this.scheduleProactive();
  }

  setGoal(goal) {
    this.goal = String(goal || '').slice(0, GOAL_MAX);
  }

  scheduleProactive() {
    if (this.closed) return;
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = setTimeout(() => {
      // Only nudge proactively if there's actually something to work with.
      if (this.utterances.length) this.requestSuggestions('proactive');
      this.scheduleProactive();
    }, PROACTIVE_MS);
  }

  /**
   * A base64 webm/opus chunk arrived for one speaker. Transcribe it, append to
   * the rolling transcript, and (for remote speech) schedule a suggestion.
   */
  async pushAudio(who, b64, mimeType) {
    if (this.closed) return;
    if (who !== 'self' && who !== 'remote') return;
    if (!b64 || typeof b64 !== 'string') return;

    let buf;
    try { buf = Buffer.from(b64, 'base64'); }
    catch { return; }
    if (!buf.length || buf.length > CHUNK_MAX_BYTES) return;

    if (!ai.enabled()) {
      this.send({ type: 'assistant.error', error: 'ai_disabled' });
      return;
    }

    this.pendingTranscribe++;
    try {
      const text = await ai.transcribe(buf, {
        mimeType: mimeType || 'audio/webm',
        filename: 'chunk.webm',
        language: 'de',
      });
      const clean = (text || '').trim();
      if (clean && !isNoise(clean)) this.addUtterance(who, clean);
    } catch (err) {
      // Transcription of one chunk failing is non-fatal — drop it and go on.
      console.error('[assistant] transcribe error:', err?.message || err);
    } finally {
      this.pendingTranscribe--;
    }
  }

  addUtterance(who, text) {
    if (this.closed) return;
    const at = Date.now();
    this.utterances.push({ who, text, at });
    if (this.utterances.length > TRANSCRIPT_MAX) {
      this.utterances.splice(0, this.utterances.length - TRANSCRIPT_MAX);
    }
    // Stream the live transcript line to the panel (dezente Mitschrift).
    this.send({ type: 'assistant.transcript', payload: { who, text, at } });

    if (who === 'remote') {
      this.lastRemoteAt = at;
      this.scheduleSuggest();
    }
  }

  scheduleSuggest() {
    if (this.closed) return;
    clearTimeout(this.suggestTimer);
    this.suggestTimer = setTimeout(() => this.requestSuggestions('reactive'), SUGGEST_DEBOUNCE_MS);
  }

  async requestSuggestions(reason) {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastSuggestAt < SUGGEST_MIN_GAP_MS) return;
    if (!this.utterances.length) return;
    if (!ai.enabled()) return;
    this.lastSuggestAt = now;

    const transcript = this.renderTranscript();
    const goal = this.goal || '(kein Ziel angegeben — leite es aus dem Gespräch ab)';
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `ZIEL DES NUTZERS:\n${goal}\n\n` +
          `GESPRÄCHSVERLAUF (Ich = der Nutzer, Gegenüber = Gesprächspartner):\n${transcript}\n\n` +
          `Der Auslöser war: ${reason === 'proactive' ? 'proaktiver Vorschlag (keine neue Frage)' : 'das Gegenüber hat gerade gesprochen'}.\n` +
          `Gib 1–2 kurze, sofort umsetzbare Vorschläge als JSON.`,
      },
    ];

    try {
      const { text } = await ai.chat(messages, { json: true, maxTokens: 400, temperature: 0.4 });
      const parsed = ai.parseJsonLenient(text);
      const items = normaliseSuggestions(parsed);
      if (items.length && !this.closed) {
        this.send({ type: 'assistant.suggestion', payload: { items, at: Date.now(), reason } });
      }
    } catch (err) {
      console.error('[assistant] suggest error:', err?.message || err);
    }
  }

  renderTranscript() {
    // Newest last; trim from the front to stay under the char budget.
    let lines = this.utterances.map((u) => `${u.who === 'self' ? 'Ich' : 'Gegenüber'}: ${u.text}`);
    let joined = lines.join('\n');
    while (joined.length > TRANSCRIPT_CHARS && lines.length > 1) {
      lines.shift();
      joined = lines.join('\n');
    }
    return joined;
  }

  stop(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.maxTimer);
    clearTimeout(this.suggestTimer);
    clearTimeout(this.proactiveTimer);
    sessions.delete(this.deviceId);
    try { this.send({ type: 'assistant.stopped', payload: { reason: reason || 'stopped' } }); } catch {}
  }
}

// ── Public API (called from the WS router) ───────────────────────────────────

function startSession(deviceId, send, { goal } = {}) {
  if (!deviceId) return;
  // Restart cleanly if one already exists (e.g. reconnect).
  const existing = sessions.get(deviceId);
  if (existing) existing.stop('restart');
  const s = new AssistantSession(deviceId, send);
  s.setGoal(goal);
  sessions.set(deviceId, s);
  send({ type: 'assistant.started', payload: { at: s.startedAt } });
}

function updateGoal(deviceId, goal) {
  const s = sessions.get(deviceId);
  if (s) s.setGoal(goal);
}

function pushAudio(deviceId, who, b64, mimeType) {
  const s = sessions.get(deviceId);
  if (s) s.pushAudio(who, b64, mimeType);
}

function stopSession(deviceId, reason) {
  const s = sessions.get(deviceId);
  if (s) s.stop(reason);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'Du bist "Koro Copilot", ein diskreter Echtzeit-Assistent, der einem Nutzer WÄHREND ' +
  'eines Live-Gesprächs (z. B. Verkauf/Verhandlung) hilft. Du hörst beide Seiten mit. ' +
  'Deine Aufgabe: Einwände des Gegenübers erkennen und dem Nutzer knappe, konkrete ' +
  'Gegenargumente, gute Rückfragen oder den nächsten Schritt liefern — immer im Dienst ' +
  'des Nutzer-ZIELS. Sei kurz und umsetzbar (der Nutzer redet gleichzeitig). Erfinde keine ' +
  'Fakten. Antworte auf Deutsch.\n\n' +
  'Antworte AUSSCHLIESSLICH mit JSON in genau dieser Form:\n' +
  '{"items":[{"type":"objection"|"suggestion"|"nudge","title":"kurzer Titel","text":"1-2 Sätze konkret"}]}\n' +
  '- "objection": Reaktion auf einen erkannten Einwand ("Akku schlecht" → Gegenargument).\n' +
  '- "suggestion": eine gute nächste Frage oder ein Argument Richtung Ziel.\n' +
  '- "nudge": ein taktischer Hinweis (z. B. "Jetzt zum Abschluss kommen").\n' +
  'Maximal 2 items. Keine Wiederholung von bereits Offensichtlichem.';

/** Filter out Whisper's silence/hallucination artefacts on tiny chunks. */
function isNoise(text) {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (t.length < 2) return true;
  // Common Whisper hallucinations on near-silent audio.
  const junk = ['untertitel', 'untertitelung', 'amara', 'thank you', 'thanks for watching', 'vielen dank'];
  return junk.some((j) => t === j || t.startsWith(j));
}

function normaliseSuggestions(parsed) {
  const arr = Array.isArray(parsed?.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
  const out = [];
  for (const it of arr) {
    if (!it) continue;
    const type = ['objection', 'suggestion', 'nudge'].includes(it.type) ? it.type : 'suggestion';
    const title = String(it.title || '').slice(0, 120).trim();
    const text = String(it.text || '').slice(0, 600).trim();
    if (!text) continue;
    out.push({ type, title, text });
    if (out.length >= 2) break;
  }
  return out;
}

module.exports = { startSession, updateGoal, pushAudio, stopSession };
