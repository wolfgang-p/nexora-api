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
    this.recentSuggestions = [];      // last suggestion texts (for de-duplication)
    this.askSeq = 0;                  // id counter for "Ask Copilot" answers
    this.summarySeq = 0;              // id counter for "Wo stehen wir?" statuses
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
    // Show the model what it has ALREADY said, so it doesn't repeat itself.
    const alreadySaid = this.recentSuggestions.length
      ? `\n\nDU HAST BEREITS FOLGENDES VORGESCHLAGEN — wiederhole es NICHT und ` +
        `bringe keine leichten Umformulierungen davon. Bringe etwas inhaltlich NEUES ` +
        `oder gib "items":[] zurück:\n${this.recentSuggestions.map((s) => `- ${s}`).join('\n')}`
      : '';
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `ZIEL DES NUTZERS:\n${goal}\n\n` +
          `GESPRÄCHSVERLAUF (Ich = der Nutzer, Gegenüber = Gesprächspartner):\n${transcript}` +
          alreadySaid + '\n\n' +
          `Der Auslöser war: ${reason === 'proactive' ? 'proaktiver Vorschlag (keine neue Frage)' : 'das Gegenüber hat gerade gesprochen'}.\n` +
          `Gib 1–2 kurze, sofort umsetzbare Vorschläge als JSON.`,
      },
    ];

    try {
      // Higher temperature = more varied phrasing/angles between calls.
      const { text } = await ai.chat(messages, { json: true, maxTokens: 400, temperature: 0.8 });
      const parsed = ai.parseJsonLenient(text);
      let items = normaliseSuggestions(parsed);
      // Drop anything too similar to what we've already sent this session.
      items = items.filter((it) => !this.isDuplicate(it.text));
      if (items.length && !this.closed) {
        for (const it of items) this.rememberSuggestion(it.text);
        this.send({ type: 'assistant.suggestion', payload: { items, at: Date.now(), reason } });
      }
    } catch (err) {
      console.error('[assistant] suggest error:', err?.message || err);
    }
  }

  /**
   * The user typed a direct question to the copilot ("Ask Copilot"). Answer it
   * with the full meeting context. Replies with its OWN message type so the UI
   * can show it as a chat answer, not a suggestion card.
   */
  async askQuestion(question) {
    if (this.closed) return;
    const q = String(question || '').trim().slice(0, 500);
    if (!q) return;
    if (!ai.enabled()) { this.send({ type: 'assistant.error', error: 'ai_disabled' }); return; }
    const qId = ++this.askSeq;
    this.send({ type: 'assistant.answer', payload: { qId, question: q, answer: null, pending: true } });

    const transcript = this.renderTranscript();
    const goal = this.goal || '(kein Ziel angegeben)';
    const messages = [
      { role: 'system', content: ASK_PROMPT },
      {
        role: 'user',
        content:
          `ZIEL DES NUTZERS:\n${goal}\n\n` +
          `GESPRÄCHSVERLAUF (Ich = der Nutzer, Gegenüber = Gesprächspartner):\n${transcript || '(noch nichts gesprochen)'}\n\n` +
          `FRAGE DES NUTZERS AN DICH:\n${q}`,
      },
    ];
    try {
      const { text } = await ai.chat(messages, { maxTokens: 500, temperature: 0.5 });
      const answer = (text || '').trim() || 'Dazu habe ich gerade keine gute Antwort.';
      if (!this.closed) this.send({ type: 'assistant.answer', payload: { qId, question: q, answer, pending: false } });
    } catch (err) {
      console.error('[assistant] ask error:', err?.message || err);
      if (!this.closed) this.send({ type: 'assistant.answer', payload: { qId, question: q, answer: 'Fehler beim Beantworten.', pending: false } });
    }
  }

  /**
   * "Wo stehen wir?" — a short live status of the conversation on demand.
   */
  async summarize() {
    if (this.closed) return;
    if (!ai.enabled()) { this.send({ type: 'assistant.error', error: 'ai_disabled' }); return; }
    const sId = ++this.summarySeq;
    this.send({ type: 'assistant.status', payload: { sId, text: null, pending: true } });

    const transcript = this.renderTranscript();
    if (!transcript) {
      this.send({ type: 'assistant.status', payload: { sId, text: 'Noch nichts gesagt — sobald gesprochen wird, fasse ich zusammen.', pending: false } });
      return;
    }
    const goal = this.goal || '(kein Ziel angegeben)';
    const messages = [
      { role: 'system', content: STATUS_PROMPT },
      { role: 'user', content: `ZIEL:\n${goal}\n\nGESPRÄCHSVERLAUF:\n${transcript}` },
    ];
    try {
      const { text } = await ai.chat(messages, { maxTokens: 300, temperature: 0.4 });
      const out = (text || '').trim() || 'Keine Zusammenfassung möglich.';
      if (!this.closed) this.send({ type: 'assistant.status', payload: { sId, text: out, pending: false } });
    } catch (err) {
      console.error('[assistant] status error:', err?.message || err);
      if (!this.closed) this.send({ type: 'assistant.status', payload: { sId, text: 'Fehler bei der Zusammenfassung.', pending: false } });
    }
  }

  isDuplicate(text) {
    const a = normText(text);
    if (!a) return true;
    return this.recentSuggestions.some((prev) => {
      const b = normText(prev);
      return b === a || jaccard(a, b) >= 0.6;   // ≥60% word overlap = "same"
    });
  }

  rememberSuggestion(text) {
    this.recentSuggestions.push(text);
    if (this.recentSuggestions.length > 12) this.recentSuggestions.shift();
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

function ask(deviceId, question) {
  const s = sessions.get(deviceId);
  if (s) s.askQuestion(question);
}

function summarize(deviceId) {
  const s = sessions.get(deviceId);
  if (s) s.summarize();
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
  'WICHTIG: Gib nur den EINEN besten, relevantesten Vorschlag zurück (maximal 2, ' +
  'und nur wenn wirklich zwei verschiedene Dinge JETZT wichtig sind). Lieber ein ' +
  'exzellenter Vorschlag als mehrere mittelmäßige. Keine Wiederholung von bereits ' +
  'Gesagtem oder Offensichtlichem — wenn es gerade nichts Wertvolles zu sagen gibt, ' +
  'gib "items":[] zurück.\n' +
  'Jeder Vorschlag muss sich im ANSATZ unterscheiden — variiere zwischen: eine ' +
  'konkrete Frage stellen · ein Nutzenargument · ein Beleg/Zahl · ein Vergleich · ' +
  'ein Zugeständnis/Angebot · eine emotionale Ansprache. Bringe nie zweimal denselben ' +
  'Denkweg, auch nicht anders formuliert.';

const ASK_PROMPT =
  'Du bist "Koro Copilot", der private Assistent eines Nutzers in einem Live-Gespräch ' +
  '(z. B. Verkauf/Verhandlung). Der Nutzer stellt dir mitten im Gespräch eine Frage. ' +
  'Beantworte sie kurz, konkret und sofort umsetzbar, im Kontext des Gesprächsverlaufs ' +
  'und des Ziels. Wenn passend, gib eine nummerierte Liste (z. B. „3 Argumente"). Keine ' +
  'Fakten erfinden. Klartext auf Deutsch, keine Einleitung wie „Gerne".';

const STATUS_PROMPT =
  'Du bist "Koro Copilot". Fasse den aktuellen Stand des Live-Gesprächs in maximal ' +
  '3 kurzen Punkten zusammen: (1) Was will/braucht das Gegenüber? (2) Welche Einwände ' +
  'oder offenen Punkte gibt es? (3) Was ist der beste nächste Schritt Richtung Ziel? ' +
  'Sehr knapp, Stichworte reichen. Deutsch, keine Einleitung.';

const CJK_ETC = /[　-鿿가-힯Ѐ-ӿ؀-ۿ぀-ヿ]/g;
const LATIN = /[A-Za-zÀ-ÿ]/g;

/** Filter out Whisper's silence/hallucination artefacts on tiny chunks. */
function isNoise(text) {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (t.length < 2) return true;
  // Common Whisper hallucinations on near-silent audio.
  const junk = ['untertitel', 'untertitelung', 'amara', 'thank you', 'thanks for watching', 'vielen dank'];
  if (junk.some((j) => t === j || t.startsWith(j))) return true;
  // Foreign-script hallucination (Chinese/Japanese/Korean/Cyrillic/Arabic) in a
  // German meeting → drop it.
  const foreign = (raw.match(CJK_ETC) || []).length;
  const latin = (raw.match(LATIN) || []).length;
  if (foreign > 0 && foreign >= latin) return true;
  return false;
}

/** Lowercase, strip punctuation — for fuzzy duplicate detection. */
function normText(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Word-set Jaccard similarity (0..1). Used to catch reworded repeats. */
function jaccard(a, b) {
  const A = new Set(a.split(' ').filter((w) => w.length > 3));
  const B = new Set(b.split(' ').filter((w) => w.length > 3));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
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

module.exports = { startSession, updateGoal, pushAudio, ask, summarize, stopSession };
