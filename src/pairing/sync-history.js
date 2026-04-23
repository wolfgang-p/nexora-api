'use strict';

const { supabase } = require('../db/supabase');
const { ok, forbidden, serverError } = require('../util/response');
const nacl = require('tweetnacl');

/**
 * POST /pairing/sessions/:id/sync-history (authed as new device)
 * After pairing completes, fetch old messages and re-encrypt them for this new device.
 * Uses the bot device's private key to decrypt old messages and encrypt for new device.
 */
async function syncHistory(req, res, { params }) {
  const sessionId = params.id;
  const newDeviceId = req.auth.deviceId;

  console.log('[Sync History] Starting for session', sessionId, 'device', newDeviceId);

  // Get pairing session
  const { data: sess } = await supabase
    .from('pairing_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (!sess) {
    console.log('[Sync History] Session not found');
    return forbidden(res, 'Pairing session not found');
  }
  if (!sess.completed_at) {
    console.log('[Sync History] Session not completed');
    return forbidden(res, 'Pairing not completed');
  }
  if (sess.resulting_device_id !== newDeviceId) {
    console.log('[Sync History] Device mismatch', sess.resulting_device_id, 'vs', newDeviceId);
    return forbidden(res, 'Device mismatch');
  }

  // Get bot device
  const botPrivateKeyB64 = process.env.BOT_DEVICE_PRIVATE_KEY;
  if (!botPrivateKeyB64) {
    console.error('[Sync History] Bot private key not configured');
    return serverError(res, 'Bot not configured');
  }

  console.log('[Sync History] Bot private key configured, looking for bot device...');
  const botPrivateKey = Buffer.from(botPrivateKeyB64, 'base64');
  const { data: botDevice, error: botDeviceErr } = await supabase
    .from('devices')
    .select('id, identity_public_key')
    .eq('kind', 'api_bot')
    .maybeSingle();

  if (botDeviceErr) {
    console.error('[Sync History] Error fetching bot device:', botDeviceErr);
    return serverError(res, 'Could not fetch bot device', botDeviceErr);
  }

  if (!botDevice) {
    console.error('[Sync History] Bot device not found. Run setup-complete.js');
    return serverError(res, 'Bot device not found. Run setup-complete.js');
  }

  console.log('[Sync History] Bot device found:', botDevice.id);

  // Get new device's public key
  const { data: newDevice } = await supabase
    .from('devices')
    .select('id, identity_public_key')
    .eq('id', newDeviceId)
    .maybeSingle();

  if (!newDevice) {
    return serverError(res, 'New device not found');
  }

  const newDevicePublicKey = Buffer.from(newDevice.identity_public_key, 'base64');

  // Get all conversations for this user
  const { data: convMembers } = await supabase
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', req.auth.userId)
    .is('left_at', null);

  if (!convMembers || convMembers.length === 0) {
    return ok(res, { synced: 0 });
  }

  const convIds = convMembers.map((m) => m.conversation_id);

  // For each conversation, get messages that the bot has (messages sent before this device existed)
  const { data: botMessages } = await supabase
    .from('message_recipients')
    .select(
      `message_id,
       ciphertext,
       nonce,
       messages!inner(id, conversation_id, kind)`,
    )
    .eq('recipient_device_id', botDevice.id)
    .in('messages.conversation_id', convIds);

  if (!botMessages || botMessages.length === 0) {
    return ok(res, { synced: 0 });
  }

  console.log(`[Sync History] Re-encrypting ${botMessages.length} messages for device ${newDeviceId}`);

  // Re-encrypt each message for the new device
  const newRecipients = botMessages
    .map((br) => {
      try {
        const ciphertext = Buffer.from(br.ciphertext, 'base64');
        const nonce = Buffer.from(br.nonce, 'base64');

        // Decrypt with bot's key
        const plaintext = nacl.box.open(ciphertext, nonce, newDevicePublicKey, botPrivateKey);
        if (!plaintext) {
          console.error(`[Sync History] Failed to decrypt message ${br.message_id}`);
          return null;
        }

        // Generate new nonce and re-encrypt for new device
        const newNonce = nacl.randomBytes(nacl.box.nonceLength);
        const newCiphertext = nacl.box(plaintext, newNonce, botPrivateKey, newDevicePublicKey);

        return {
          message_id: br.message_id,
          recipient_device_id: newDeviceId,
          ciphertext: Buffer.from(newCiphertext).toString('base64'),
          nonce: Buffer.from(newNonce).toString('base64'),
        };
      } catch (err) {
        console.error(`[Sync History] Error re-encrypting message ${br.message_id}:`, err.message);
        return null;
      }
    })
    .filter(Boolean);

  if (newRecipients.length === 0) {
    return ok(res, { synced: 0 });
  }

  // Insert new message_recipients rows
  const { error } = await supabase.from('message_recipients').insert(newRecipients);
  if (error) {
    console.error('[Sync History] Insert error:', error);
    return serverError(res, 'Could not sync history', error);
  }

  console.log(`[Sync History] Successfully synced ${newRecipients.length} messages`);
  ok(res, { synced: newRecipients.length });
}

module.exports = { syncHistory };
