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
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { supabase } = require('../db/supabase');
const { resolveKey, planRecording } = require('../media/fs');
const ai = require('../ai/provider');

// Whisper hard limit is 25 MB per file. WebM/Opus is ~1 MB/min, so a normal
// meeting fits comfortably. For longer recordings we split into time-based
// segments with ffmpeg (see transcribeRecording) and transcribe each.
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;
// Segment length when a recording is too big for one Whisper call. 10 min of
// Opus is well under 25 MB with generous headroom.
const SEGMENT_SECONDS = 600;

/** Run ffmpeg with args; resolve on exit 0, reject otherwise. */
/**
 * Whisper occasionally hallucinates on near-silent / noisy audio: repeated
 * "Untertitel…", "Thank you", or — the odd one — chunks of a foreign script
 * (Chinese/Japanese/Korean/Cyrillic/Arabic) that were never spoken. This drops
 * segments that are clearly not real German/Latin speech, so the analysis
 * transcript stays clean.
 */
const CJK_ETC = /[　-鿿가-힯Ѐ-ӿ؀-ۿ぀-ヿ]/g;
const LATIN = /[A-Za-zÀ-ÿ]/g;
const WHISPER_JUNK = [
  'untertitel', 'untertitelung', 'amara', 'thank you', 'thanks for watching',
  'vielen dank', 'für die untertitel', 'copyright', 'wdr', 'zdf',
];

function isGarbageUtterance(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return true;
  const low = t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!low) return true;
  if (WHISPER_JUNK.some((j) => low === j || low.startsWith(j))) return true;
  // If a meaningful share of characters is a foreign script, it's a hallucination.
  const foreign = (t.match(CJK_ETC) || []).length;
  const latin = (t.match(LATIN) || []).length;
  if (foreign > 0 && foreign >= latin) return true;      // dominated by CJK/Cyrillic/etc.
  if (foreign > 2 && latin === 0) return true;           // pure foreign script
  return false;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Transcribe one recording file into TIMESTAMPED utterances. Returns an array of
 * { startSec, text } — start seconds are relative to the START of this speaker's
 * recording. If the file fits Whisper we ask for per-segment timestamps
 * directly; if it's too big we split with ffmpeg and add each piece's time
 * offset so the timestamps stay correct across the whole recording.
 *
 * Timestamped segments are what let us interleave everyone chronologically
 * (utterance A, utterance B, utterance A again — like a chat) instead of dumping
 * one speaker's whole block before the next.
 */
async function transcribeRecording(absPath, mimeType) {
  const buf = await fsp.readFile(absPath);
  if (buf.length === 0) return [];

  if (buf.length <= WHISPER_MAX_BYTES) {
    const r = await ai.transcribe(buf, { mimeType: mimeType || 'audio/webm', filename: 'speaker.webm', segments: true });
    return (r.segments || []).map((s) => ({ startSec: s.start, text: s.text }));
  }

  // Too big → segment with ffmpeg. Copy the audio stream (no re-encode) into
  // fixed-duration .webm pieces; add each piece's base offset to its timestamps.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'koro-seg-'));
  try {
    const pattern = path.join(tmpDir, 'seg-%04d.webm');
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-i', absPath,
      '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS),
      '-c', 'copy', '-reset_timestamps', '1', pattern,
    ]);
    const files = (await fsp.readdir(tmpDir)).filter((f) => f.endsWith('.webm')).sort();
    const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const base = i * SEGMENT_SECONDS; // this piece starts here in the full recording
      const segBuf = await fsp.readFile(path.join(tmpDir, f));
      if (segBuf.length === 0 || segBuf.length > WHISPER_MAX_BYTES) continue;
      try {
        const r = await ai.transcribe(segBuf, { mimeType: 'audio/webm', filename: f, segments: true });
        for (const s of r.segments || []) out.push({ startSec: base + s.start, text: s.text });
      } catch (err) {
        console.warn(`[meet-analysis] segment ${f} transcribe failed:`, err.message);
      }
    }
    return out;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

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
// How many times we retry a meeting before marking it failed.
const MAX_ATTEMPTS = 3;

async function processOnePending() {
  // Atomically claim the oldest pending row: set processing only if still
  // pending, so two ticks (or a restart) never grab the same meeting.
  const { data: candidate } = await supabase.from('meeting_analysis')
    .select('meeting_id, share_token, attempts')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1).maybeSingle();
  if (!candidate) return false;

  const { data: claimed } = await supabase.from('meeting_analysis')
    .update({ status: 'processing', attempts: (candidate.attempts || 0) + 1, updated_at: new Date().toISOString() })
    .eq('meeting_id', candidate.meeting_id)
    .eq('status', 'pending')
    .select('meeting_id, attempts').maybeSingle();
  if (!claimed) return true; // someone else claimed it; try again next tick

  const meetingId = candidate.meeting_id;
  const attempt = claimed.attempts || 1;
  try {
    await analyzeMeeting(meetingId);
    await supabase.from('meeting_analysis')
      .update({ status: 'done', error: null, updated_at: new Date().toISOString() })
      .eq('meeting_id', meetingId);
    console.log(`[meet-analysis] done ${meetingId} (attempt ${attempt})`);
    // The raw audio has served its purpose (transcript is stored) — delete it so
    // we don't retain recordings longer than necessary (storage + privacy).
    await deleteRecordingAudio(meetingId).catch((e) =>
      console.warn(`[meet-analysis] audio cleanup failed for ${meetingId}:`, e.message));
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);
    // Auto-retry transient failures (OpenAI blip, etc.) up to MAX_ATTEMPTS by
    // dropping back to 'pending'; only give up as 'failed' after that.
    const giveUp = attempt >= MAX_ATTEMPTS;
    console.error(`[meet-analysis] ${giveUp ? 'FAILED' : 'retry'} ${meetingId} (attempt ${attempt}/${MAX_ATTEMPTS}):`, msg);
    await supabase.from('meeting_analysis')
      .update({ status: giveUp ? 'failed' : 'pending', error: msg, updated_at: new Date().toISOString() })
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
    let absPath;
    try {
      absPath = resolveKey(rec.storage_key);
      await fsp.access(absPath);
    } catch (err) {
      console.warn(`[meet-analysis] missing file ${rec.storage_key}:`, err.message);
      continue;
    }

    let segments = [];
    try {
      // Timestamped utterances (small files direct, long files ffmpeg-segmented).
      segments = await transcribeRecording(absPath, rec.mime_type);
    } catch (err) {
      console.warn(`[meet-analysis] transcribe failed for ${rec.storage_key}:`, err.message);
      continue;
    }
    if (!segments.length) continue;

    // When this speaker's recording began, relative to the meeting start. Each
    // utterance's absolute meeting offset = that base + the utterance's time in
    // the recording. This is what interleaves speakers chronologically.
    const startedMs = rec.started_at ? new Date(rec.started_at).getTime() : null;
    const baseMs = (meetingStartMs != null && startedMs != null)
      ? Math.max(0, startedMs - meetingStartMs) : 0;

    for (const seg of segments) {
      const text = (seg.text || '').trim();
      if (!text) continue;
      if (isGarbageUtterance(text)) continue;   // drop Whisper hallucinations / foreign-script junk
      transcriptRows.push({
        meeting_id: meetingId,
        recording_id: rec.id,
        speaker_display_name: rec.participant_display_name || 'Teilnehmer',
        speaker_device_id: rec.participant_device_id,
        text,
        started_offset_ms: baseMs + Math.round((seg.startSec || 0) * 1000),
      });
    }
  }

  // Sort ALL utterances across ALL speakers chronologically so the transcript
  // reads like a chat (A, B, A, C, …) rather than one speaker's whole block.
  transcriptRows.sort((a, b) => a.started_offset_ms - b.started_offset_ms);

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

/**
 * Delete the raw audio files for a meeting (and its now-empty directory). The
 * transcript is already persisted in meeting_transcripts, so the audio is no
 * longer needed. Best-effort; also zeros the recording rows' storage so nothing
 * dangles.
 */
async function deleteRecordingAudio(meetingId) {
  const { data: recs } = await supabase.from('meeting_recordings')
    .select('storage_key').eq('meeting_id', meetingId);
  let dir = null;
  for (const rec of recs || []) {
    if (!rec.storage_key) continue;
    try {
      const abs = resolveKey(rec.storage_key);
      dir = path.dirname(abs);
      await fsp.unlink(abs).catch(() => {});
    } catch { /* ignore bad key */ }
  }
  // Remove the (now empty) meetings/<id> dir.
  if (dir) await fsp.rmdir(dir).catch(() => {});
}

/**
 * Safety-net sweep: delete any meeting recording audio older than RETENTION_DAYS
 * regardless of analysis status (e.g. a meeting that never got processed, or
 * whose cleanup failed). Runs periodically from the worker loop.
 */
const RETENTION_DAYS = 7;
async function sweepOldRecordings() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: old } = await supabase.from('meeting_recordings')
    .select('meeting_id, storage_key, started_at')
    .lt('started_at', cutoff)
    .limit(200);
  const byMeeting = new Set();
  for (const rec of old || []) {
    if (!rec.storage_key) continue;
    try { await fsp.unlink(resolveKey(rec.storage_key)).catch(() => {}); } catch { /* ignore */ }
    byMeeting.add(rec.meeting_id);
  }
  for (const mId of byMeeting) {
    // Best-effort dir removal + drop the DB rows so we don't sweep them again.
    try {
      const { data: one } = await supabase.from('meeting_recordings')
        .select('storage_key').eq('meeting_id', mId).limit(1).maybeSingle();
      if (one?.storage_key) await fsp.rmdir(path.dirname(resolveKey(one.storage_key))).catch(() => {});
    } catch { /* ignore */ }
  }
  if ((old || []).length) console.log(`[meet-analysis] swept ${old.length} old recording file(s)`);
  return (old || []).length;
}

/**
 * Finalize meeting FULL recordings that are stuck in 'recording'/'processing'
 * (e.g. the host's tab closed, the client finalize was lost, or the meeting
 * ended before the server-side safety net existed). For each such meeting whose
 * meeting has already ended, register whatever full.webm is on disk as a public
 * media object and flip the status to 'ready' (or 'failed' if there are no
 * bytes). Idempotent — skips rows that already have a media id.
 */
async function finalizeStuckRecordings() {
  const { data: stuck } = await supabase.from('meeting_analysis')
    .select('meeting_id, full_recording_status, full_recording_media_id')
    .in('full_recording_status', ['recording', 'processing'])
    .is('full_recording_media_id', null)
    .limit(20);
  if (!stuck?.length) return 0;

  let fixed = 0;
  for (const row of stuck) {
    // Only finalize once the meeting is actually over — an in-progress recording
    // should keep its 'recording' status.
    const { data: meeting } = await supabase.from('meetings')
      .select('ended_at').eq('id', row.meeting_id).maybeSingle();
    if (!meeting || !meeting.ended_at) continue;

    const p = planRecording(row.meeting_id, 'full', 'webm');
    const abs = resolveKey(p.storageKey);
    let size = 0;
    try { size = (await fsp.stat(abs)).size; } catch { size = 0; }

    if (size <= 0) {
      await supabase.from('meeting_analysis')
        .update({ full_recording_status: 'failed', updated_at: new Date().toISOString() })
        .eq('meeting_id', row.meeting_id);
      continue;
    }
    // media_objects.sha256 is NOT NULL — hash the file first.
    let sha256;
    try {
      const h = crypto.createHash('sha256');
      h.update(await fsp.readFile(abs));
      sha256 = h.digest('hex');
    } catch (err) { console.warn('[meet-analysis] fullrec hash failed:', err.message); continue; }

    const { data: media, error } = await supabase.from('media_objects').insert({
      conversation_id: null, storage_key: p.storageKey, mime_type: 'video/webm', size_bytes: size, sha256,
    }).select('id').single();
    if (error) { console.warn('[meet-analysis] fullrec insert failed:', error.message); continue; }
    await supabase.from('meeting_analysis')
      .update({ full_recording_media_id: media.id, full_recording_status: 'ready', updated_at: new Date().toISOString() })
      .eq('meeting_id', row.meeting_id);
    fixed++;
  }
  if (fixed) console.log(`[meet-analysis] finalized ${fixed} stuck full recording(s)`);
  return fixed;
}

module.exports = { processOnePending, sweepOldRecordings, finalizeStuckRecordings };
