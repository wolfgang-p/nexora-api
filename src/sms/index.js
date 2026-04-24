'use strict';

const config = require('../config');

/**
 * Send an OTP code via SMS.
 *
 *   - SMS_PROVIDER='twilio'       → Twilio REST (production default)
 *   - SMS_PROVIDER='messagebird'  → MessageBird REST
 *   - SMS_PROVIDER unset (dev)    → prints the OTP to stderr so a developer
 *                                   can finish the flow without wiring SMS.
 *                                   HARD-FAILS in production (NODE_ENV=production).
 *
 * Returns `{ mode, sid? }`. Throws if SMS cannot be delivered.
 */
async function sendOtp(phoneE164, code) {
  const provider = (process.env.SMS_PROVIDER || '').toLowerCase();
  const body = `Dein Koro-Code: ${code} (läuft in 5 Minuten ab). Gib ihn nie weiter.`;

  if (!provider) {
    // Production must always have a real provider wired. Refuse to run the
    // dev logger — OTPs on stderr in production would be a critical leak.
    if (config.isProd) {
      throw new Error(
        '[sms] SMS_PROVIDER not configured. Refusing to log OTP to stderr in production.',
      );
    }
    // Dev-only console echo. Intentionally not routed through any logger
    // that might ship to Sentry/Datadog — dev OTPs must never hit a
    // centralized log.
    // eslint-disable-next-line no-console
    console.error(`[DEV OTP] ${phoneE164} → ${code}`);
    return { mode: 'dev' };
  }
  if (provider === 'twilio') return twilio(phoneE164, body);
  if (provider === 'messagebird') return messagebird(phoneE164, body);
  throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
}

async function twilio(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from) throw new Error('TWILIO_* env vars missing');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${tok}`).toString('base64');
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  // Optional: if TWILIO_STATUS_CALLBACK is set, Twilio POSTs delivery status
  // (sent, delivered, failed, undelivered) to that URL. Wire it to an API
  // route to track bounces and retry.
  if (process.env.TWILIO_STATUS_CALLBACK) {
    params.set('StatusCallback', process.env.TWILIO_STATUS_CALLBACK);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Carrier error is safe to log. The *outgoing* body (with OTP) is never logged.
    console.error(`[sms:twilio] HTTP ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`twilio ${res.status}`);
  }
  const json = await res.json().catch(() => ({}));
  return { mode: 'twilio', sid: json.sid || null };
}

async function messagebird(to, body) {
  const key = process.env.MESSAGEBIRD_KEY;
  const from = process.env.MESSAGEBIRD_FROM || 'Koro';
  if (!key) throw new Error('MESSAGEBIRD_KEY missing');

  const res = await fetch('https://rest.messagebird.com/messages', {
    method: 'POST',
    headers: {
      Authorization: `AccessKey ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ originator: from, recipients: [to], body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[sms:messagebird] HTTP ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`messagebird ${res.status}`);
  }
  return { mode: 'messagebird' };
}

module.exports = { sendOtp };
