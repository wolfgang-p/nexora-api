'use strict';

const crypto = require('node:crypto');
const { readJson, ok, badRequest } = require('../util/response');

/**
 * POST /sms/twilio-status   (unauthed; verified via Twilio signature)
 *
 * Twilio delivery callback. Body is application/x-www-form-urlencoded with
 * fields: MessageSid, From, To, MessageStatus, ErrorCode, etc.
 * We don't persist bounce state in this module beyond a log — the attempt
 * counter on the OTP already fails the user out after 5 tries, and the
 * rate-limiter prevents resend-spam. This endpoint is the hook for future
 * suppression-list work.
 */
async function twilioStatus(req, res) {
  const signature = req.headers['x-twilio-signature'];
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return badRequest(res, 'Twilio not configured');

  // Buffer the raw body for signature validation.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  // Parse form data.
  const params = Object.fromEntries(new URLSearchParams(raw));

  // Twilio signature = HMAC-SHA1 of (url + sorted key+value). If
  // TWILIO_STATUS_CALLBACK is set to this route, validate it.
  const expectedUrl = process.env.TWILIO_STATUS_CALLBACK;
  if (expectedUrl && signature) {
    const data = expectedUrl + Object.keys(params).sort()
      .map((k) => k + params[k]).join('');
    const computed = crypto
      .createHmac('sha1', authToken).update(data).digest('base64');
    if (computed !== signature) return badRequest(res, 'Invalid signature');
  }

  const status = String(params.MessageStatus || '').toLowerCase();
  const to = params.To;
  if (['failed', 'undelivered'].includes(status)) {
    console.error('[sms:twilio] delivery failed', { to, status, err: params.ErrorCode });
  }
  ok(res, { received: true });
}

module.exports = { twilioStatus };
