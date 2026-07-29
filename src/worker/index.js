'use strict';

/**
 * koro meeting-analysis worker — a standalone process.
 *
 * The API runs blue+green (two instances), so background jobs that must NOT
 * double-fire live here instead: a SINGLE worker container. It polls for
 * meetings whose analysis is `pending` and processes them one at a time
 * (transcription + AI summary — see meetingAnalysis.js).
 *
 * Run: `node src/worker/index.js`  (docker-compose service `meeting-worker`).
 * Shares the same image, .env and the `koro-uploads` volume as the API so it
 * can read the recording files off disk.
 */

// Loads dotenv (via config) and lets supabase/ai init off the same env.
require('../config');
const { processOnePending } = require('./meetingAnalysis');

const IDLE_MS = 15_000; // poll interval when there's nothing to do
const BUSY_MS = 500;    // brief gap between back-to-back jobs

process.on('unhandledRejection', (err) => console.error('[worker:unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[worker:uncaughtException]', err));

let stopping = false;

async function loop() {
  console.log('[worker] meeting-analysis worker started');
  while (!stopping) {
    let handled = false;
    try {
      handled = await processOnePending();
    } catch (err) {
      console.error('[worker] tick error:', err?.message || err);
    }
    // If we just processed one, come back quickly (there may be more);
    // otherwise idle-poll.
    await sleep(handled ? BUSY_MS : IDLE_MS);
  }
  console.log('[worker] stopped');
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the process alive purely for a pending idle timer on shutdown.
    if (typeof t.unref === 'function') t.unref();
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) process.exit(0);
    console.log(`[worker] ${sig} received, finishing current job…`);
    stopping = true;
  });
}

loop();
