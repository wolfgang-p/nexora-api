'use strict';

/**
 * Meeting analysis job — the post-processing brain of koro-meet.
 *
 * For every meeting whose analysis row is `pending`, it:
 *   1. flips it to `processing`,
 *   2. transcribes each per-speaker recording file via Whisper (auto language),
 *   3. writes one meeting_transcripts row per speaker (with a rough start
 *      offset derived from when that speaker's recording began, relative to the
 *      meeting start — enough for a "who spoke when" timeline),
 *   4. builds a chronological transcript and asks the AI for a German summary,
 *   5. flips it to `done` (or `failed` + error on a hard failure).
 *
 * Because each participant records their OWN mic to a separate file, speaker
 * attribution is exact and needs no diarization.
 *
 * Runs in the dedicated worker process (src/worker/index.js) — a SINGLE
 * instance, so no job double-fires even though the API runs blue+green.
 */

const fsp = require('node:fs/promises');
const { supabase } = require('../db/supabase');
const { resolveKey } = require('../media/fs');
const ai = require('../ai/provider');

// Whisper hard limit is 25 MB per file. WebM/Opus is ~1 MB/min, so a normal
// meeting fits comfortably; we skip (and note) anything larger rather than
// pulling in ffmpeg for the first version.
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;

const SYS_MEETING_SUMMARY =
  'Du bist ein Assistent, der Meeting-Transkripte zusammenfasst. Fasse das ' +
  'folgende Meeting in klarem Deutsch zusammen: die wichtigsten besprochenen ' +
  'Themen, getroffene Entscheidungen und offene To-dos. Nutze Markdown mit ' +
  'kurzen Überschriften und Stichpunkten. Sei prägnant, erfinde nichts hinzu, ' +
  'was nicht im Transkript steht.';

/**
 * Process exactly one pending meeting analysis (the oldest). Returns true if it
 * handled one, false if there was nothing to do — lets the loop back off.
 */
async function processOnePending() {
  // Atomically claim the oldest pending row: set processing only if still
  // pending, so two ticks (or a restart) never grab the same meeting.
  const { data: candidate } = await supabase.from('meeting_analysis')
    .select('meeting_id, share_token')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1).maybeSingle();
  if (!candidate) return false;

  const { data: claimed } = await supabase.from('meeting_analysis')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('meeting_id', candidate.meeting_id)
    .eq('status', 'pending')
    .select('meeting_id').maybeSingle();
  if (!claimed) return true; // someone else claimed it; try again next tick

  const meetingId = candidate.meeting_id;
  try {
    await analyzeMeeting(meetingId);
    await supabase.from('meeting_analysis')
      .update({ status: 'done', error: null, updated_at: new Date().toISOString() })
      .eq('meeting_id', meetingId);
    console.log(`[meet-analysis] done ${meetingId}`);
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);
    console.error(`[meet-analysis] FAILED ${meetingId}:`, msg);
    await supabase.from('meeting_analysis')
      .update({ status: 'failed', error: msg, updated_at: new Date().toISOString() })
      .eq('meeting_id', meetingId);
  }
  return true;
}

async function analyzeMeeting(meetingId) {
  const { data: meeting } = await supabase.from('meetings')
    .select('id, title, started_at, ended_at').eq('id', meetingId).maybeSingle();
  if (!meeting) throw new Error('meeting gone');

  const { data: recordings } = await supabase.from('meeting_recordings')
    .select('*').eq('meeting_id', meetingId);
  const recs = recordings || [];

  const meetingStartMs = meeting.started_at ? new Date(meeting.started_at).getTime() : null;

  // Clear any prior transcript rows (idempotent re-run after a failure).
  await supabase.from('meeting_transcripts').delete().eq('meeting_id', meetingId);

  const transcriptRows = [];
  for (const rec of recs) {
    let buf;
    try {
      buf = await fsp.readFile(resolveKey(rec.storage_key));
    } catch (err) {
      console.warn(`[meet-analysis] missing file ${rec.storage_key}:`, err.message);
      continue;
    }
    if (buf.length === 0) continue;
    if (buf.length > WHISPER_MAX_BYTES) {
      console.warn(`[meet-analysis] recording too large for Whisper (${buf.length} bytes), skipping ${rec.storage_key}`);
      continue;
    }

    let text = '';
    try {
      // No `language` → Whisper auto-detects.
      text = await ai.transcribe(buf, { mimeType: rec.mime_type || 'audio/webm', filename: 'speaker.webm' });
    } catch (err) {
      console.warn(`[meet-analysis] transcribe failed for ${rec.storage_key}:`, err.message);
      continue;
    }
    text = (text || '').trim();
    if (!text) continue;

    // Rough start offset: when this speaker's recording began, relative to the
    // meeting start. Good enough to order speakers on a timeline.
    const startedMs = rec.started_at ? new Date(rec.started_at).getTime() : null;
    const offsetMs = (meetingStartMs != null && startedMs != null)
      ? Math.max(0, startedMs - meetingStartMs) : 0;

    transcriptRows.push({
      meeting_id: meetingId,
      recording_id: rec.id,
      speaker_display_name: rec.participant_display_name || 'Teilnehmer',
      speaker_device_id: rec.participant_device_id,
      text,
      started_offset_ms: offsetMs,
    });
  }

  if (transcriptRows.length) {
    const { error } = await supabase.from('meeting_transcripts').insert(transcriptRows);
    if (error) throw new Error(`transcript insert: ${error.message}`);
  }

  // Build a chronological transcript for the summary prompt.
  const ordered = [...transcriptRows].sort((a, b) => a.started_offset_ms - b.started_offset_ms);
  const transcriptText = ordered
    .map((r) => `${r.speaker_display_name}: ${r.text}`)
    .join('\n\n');

  let summary = null;
  if (transcriptText.trim()) {
    try {
      const out = await ai.chat([
        { role: 'system', content: SYS_MEETING_SUMMARY },
        { role: 'user', content: `Meeting: ${meeting.title || 'Ohne Titel'}\n\nTranskript:\n${transcriptText.slice(0, 24000)}` },
      ], { maxTokens: 900, temperature: 0.3 });
      summary = (out.text || '').trim() || null;
    } catch (err) {
      // Summary is best-effort; a transcript-only result is still useful.
      console.warn(`[meet-analysis] summary failed:`, err.message);
    }
  } else {
    summary = '_Kein gesprochener Inhalt aufgezeichnet._';
  }

  await supabase.from('meeting_analysis')
    .update({ summary_md: summary, updated_at: new Date().toISOString() })
    .eq('meeting_id', meetingId);
}

module.exports = { processOnePending };
