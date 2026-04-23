#!/usr/bin/env node
'use strict';

/**
 * Setup script: Create bot device and generate encryption keypair
 * Usage: node scripts/setup-bot.js
 *
 * Outputs the bot device ID and private key (base64) for storage in .env
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');
const { randomBytes } = crypto;

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function main() {
  console.log('🤖 Generating bot encryption keypair...\n');

  // Generate keypair
  const keypair = nacl.box.keyPair();
  const publicKeyB64 = b64(keypair.publicKey);
  const privateKeyB64 = b64(keypair.secretKey);

  const botDeviceId = crypto.randomUUID();
  const botUserId = '00000000-0000-0000-0000-000000000001';

  console.log('Bot Device Setup:');
  console.log('================\n');
  console.log(`Bot User ID:      ${botUserId}`);
  console.log(`Bot Device ID:    ${botDeviceId}`);
  console.log(`Public Key (B64): ${publicKeyB64}`);
  console.log(`\nPrivate Key (B64, keep secret!):`);
  console.log(`${privateKeyB64}\n`);

  console.log('Next steps:');
  console.log('===========');
  console.log('1. Add to .env:');
  console.log(`   BOT_DEVICE_ID=${botDeviceId}`);
  console.log(`   BOT_DEVICE_PRIVATE_KEY="${privateKeyB64}"`);
  console.log('\n2. Run migration:');
  console.log('   psql $DATABASE_URL -f migrations/0005_bot_device.sql');
  console.log('\n3. Create bot device in database (run in psql):');
  console.log(`   INSERT INTO devices (id, user_id, kind, label, identity_public_key, fingerprint) VALUES`);
  console.log(`   ('${botDeviceId}'::UUID, '${botUserId}'::UUID, 'api_bot', 'Encryption Bot', decode('${publicKeyB64}', 'base64'), 'BOT-ENCRYPTION');`);
}

main();
