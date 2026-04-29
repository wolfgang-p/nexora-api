'use strict';

const config = require('../config');

/**
 * Send a transactional email. SMTP via nodemailer (recommended for
 * self-hosted), or a no-op dev mode that logs to stderr.
 *
 * Required env vars when sending real mail:
 *   EMAIL_PROVIDER=smtp
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   EMAIL_FROM=Koro <noreply@koro.chat>
 *
 * Throws on delivery failure. Returns provider metadata on success.
 */
async function sendEmail({ to, subject, text, html }) {
  const provider = (process.env.EMAIL_PROVIDER || '').toLowerCase();
  if (!provider) {
    if (config.isProd) throw new Error('[email] EMAIL_PROVIDER not configured');
    // eslint-disable-next-line no-console
    console.error(`[DEV EMAIL] to=${to} subject=${subject}\n${text || html}`);
    return { mode: 'dev' };
  }
  if (provider === 'smtp') return smtp({ to, subject, text, html });
  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
}

async function smtp({ to, subject, text, html }) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch { throw new Error('[email] nodemailer not installed — `npm i nodemailer`'); }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === '1',
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    } : undefined,
  });
  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'Koro <noreply@koro.chat>',
    to,
    subject,
    text,
    html,
  });
  return { mode: 'smtp', messageId: info.messageId };
}

module.exports = { sendEmail };
