#!/usr/bin/env node
'use strict';

/**
 * Complete Bot Setup
 * - Creates bot user + device
 * - Generates keypair
 * - Adds bot to all conversations
 * - Updates .env file
 *
 * Usage: node scripts/setup-complete.js
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Load .env file manually
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach((line) => {
    const [key, ...valueParts] = line.split('=');
    if (key && !process.env[key.trim()]) {
      const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
      process.env[key.trim()] = value;
    }
  });
}

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function main() {
  console.log('🤖 Setting up Bot for Message History Sync...\n');

  // Check env
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 1. Generate keypair
  console.log('1️⃣  Generating bot keypair...');
  const keypair = nacl.box.keyPair();
  const publicKeyB64 = b64(keypair.publicKey);
  const privateKeyB64 = b64(keypair.secretKey);
  const botDeviceId = crypto.randomUUID();
  const botUserId = '00000000-0000-0000-0000-000000000001';

  console.log(`   ✓ Bot Device ID: ${botDeviceId}`);
  console.log(`   ✓ Public Key: ${publicKeyB64.substring(0, 20)}...`);

  // 2. Create bot user (if not exists)
  console.log('\n2️⃣  Creating bot user...');
  const { error: userErr } = await supabase.from('users').insert(
    {
      id: botUserId,
      phone_e164: '+bot',
      display_name: 'Encryption Bot',
      locale: 'en',
    },
    { onConflict: 'id' },
  );
  if (userErr && !userErr.message.includes('duplicate')) {
    console.error('   ❌ Error creating bot user:', userErr);
    process.exit(1);
  }
  console.log('   ✓ Bot user created/exists');

  // 3. Create bot device
  console.log('\n3️⃣  Creating bot device...');
  const { error: deviceErr } = await supabase.from('devices').insert({
    id: botDeviceId,
    user_id: botUserId,
    kind: 'api_bot',
    label: 'Encryption Bot',
    identity_public_key: publicKeyB64,
    fingerprint: 'BOT-ENCRYPTION',
    enrolled_at: new Date().toISOString(),
  });

  if (deviceErr) {
    console.error('   ❌ Error creating bot device:', deviceErr);
    process.exit(1);
  }
  console.log(`   ✓ Bot device created: ${botDeviceId}`);

  // 4. Add bot to all conversations
  console.log('\n4️⃣  Adding bot to all conversations...');
  const { data: conversations } = await supabase.from('conversations').select('id').is('deleted_at', null);

  if (conversations && conversations.length > 0) {
    const botMembers = conversations.map((c) => ({
      conversation_id: c.id,
      user_id: botUserId,
      role: 'member',
      joined_at: new Date().toISOString(),
    }));

    const { error: memberErr } = await supabase.from('conversation_members').upsert(botMembers, {
      onConflict: 'conversation_id,user_id',
    });

    if (memberErr) {
      console.error('   ⚠️  Could not add bot to all conversations:', memberErr);
    } else {
      console.log(`   ✓ Bot added to ${conversations.length} conversations`);
    }
  } else {
    console.log('   ℹ️  No conversations found yet');
  }

  // 5. Update .env
  console.log('\n5️⃣  Updating .env file...');
  const envFile = path.join(__dirname, '..', '.env');
  let envContent = '';

  if (fs.existsSync(envFile)) {
    envContent = fs.readFileSync(envFile, 'utf-8');
  }

  // Remove existing BOT entries
  envContent = envContent
    .split('\n')
    .filter((line) => !line.startsWith('BOT_DEVICE_ID=') && !line.startsWith('BOT_DEVICE_PRIVATE_KEY='))
    .join('\n')
    .trim();

  // Add new entries
  envContent += `\n\n# Bot Device for Message History Sync\nBOT_DEVICE_ID=${botDeviceId}\nBOT_DEVICE_PRIVATE_KEY="${privateKeyB64}"\n`;

  fs.writeFileSync(envFile, envContent);
  console.log('   ✓ .env updated with bot credentials');

  console.log('\n✅ Bot setup complete!\n');
  console.log('Summary:');
  console.log(`  Bot Device ID: ${botDeviceId}`);
  console.log(`  Bot User ID:   ${botUserId}`);
  console.log(`  .env file:     Updated with credentials\n`);
  console.log('Next: Restart the API server for changes to take effect.');
}

main().catch((err) => {
  console.error('❌ Setup failed:', err.message);
  process.exit(1);
});
