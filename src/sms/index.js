'use strict';

/**
 * Send an OTP code via SMS.
 *   - SMS_PROVIDER unset          → dev mode, prints to stderr
 *   - SMS_PROVIDER='twilio'       → Twilio REST
 *   - SMS_PROVIDER='messagebird'  → MessageBird REST
 */
async function sendOtp(phoneE164, code) {
  const provider = (process.env.SMS_PROVIDER || '').toLowerCase();
  const body = `Dein Koro-Code: ${code} (läuft in 5 Minuten ab). Gib ihn nie weiter.`;

  if (!provider) {
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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`twilio ${res.status}: ${text.slice(0, 200)}`);
  }
  return { mode: 'twilio' };
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
    throw new Error(`messagebird ${res.status}: ${text.slice(0, 200)}`);
  }
  return { mode: 'messagebird' };
}

module.exports = { sendOtp };
