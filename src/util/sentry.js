'use strict';

/**
 * Sentry wiring. Lazy-required so the dep is optional — if `SENTRY_DSN`
 * is unset OR `@sentry/node` isn't installed, this module degrades to
 * no-ops and nothing crashes.
 *
 * Operators add the DSN + run `npm i @sentry/node` when ready to turn
 * it on; no code change required.
 */

const logger = require('./logger');

let sentry = null;
try {
  if (process.env.SENTRY_DSN) {
    // eslint-disable-next-line global-require
    sentry = require('@sentry/node');
    sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
      // Before sending any event, run every field through our PII
      // scrubber. Sentry already redacts some patterns but phone_hash
      // and identity_public_key aren't on their default list.
      beforeSend(event) {
        try {
          event.extra = logger.scrub(event.extra);
          event.contexts = logger.scrub(event.contexts);
          event.tags = logger.scrub(event.tags);
          if (event.request) {
            event.request.headers = logger.scrub(event.request.headers);
            event.request.data = logger.scrub(event.request.data);
          }
        } catch { /* ignore scrubber errors */ }
        return event;
      },
    });
    logger.info('[sentry] initialized');
  }
} catch (err) {
  logger.warn('[sentry] init skipped', err?.message || err);
  sentry = null;
}

function captureException(err, context) {
  if (sentry) sentry.captureException(err, context ? { extra: logger.scrub(context) } : undefined);
  else logger.error(err);
}

function captureMessage(msg, level = 'info', context) {
  if (sentry) sentry.captureMessage(msg, { level, extra: context ? logger.scrub(context) : undefined });
}

module.exports = { captureException, captureMessage, sentry };
