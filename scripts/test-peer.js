#!/usr/bin/env node
/**
 * Koro test peer — simulates a second user chatting with you from the terminal.
 *
 * Usage:
 *   node scripts/test-peer.js                     → registers/logs in as +4915100000000
 *   node scripts/test-peer.js --phone +4912345    → use a different phone
 *   node scripts/test-peer.js --echo              → auto-echoes every incoming message
 *
 * The script:
 *   1. Requests an OTP (backend prints it to its stderr), reads it from stdin
 *   2. Verifies, creates a keypair, stores state in ./scripts/.peer-state.json
 *   3. Connects WebSocket
 *   4. Lets you type messages (interactive) or auto-replies with --echo
 *
 * Tip: run `npm run dev` in one terminal (backend + peer get OTPs there),
 *      and this script in a second terminal.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const nacl = require('tweetnacl');

// ---------- config ----------
const API = process.env.KORO_API || 'http://localhost:3001';
const WS_URL = API.replace(/^http/, 'ws') + '/ws';
const STATE_FILE = path.join(__dirname, '.peer-state.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const phone = opt('--phone') || '+4915100000000';
const peerLabel = opt('--label') || 'Test Peer';
const echo = flag('--echo');

// ---------- helpers ----------
async function jfetch(pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + pathname, {
    method, headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

const b64 = {
  enc: (u) => Buffer.from(u).toString('base64'),
  dec: (s) => new Uint8Array(Buffer.from(s, 'base64')),
};

const utf8 = {
  enc: (s) => new Uint8Array(Buffer.from(s, 'utf8')),
  dec: (u) => Buffer.from(u).toString('utf8'),
};

// ---------- register / login flow ----------
async function login(rl) {
  let state = loadState();

  if (state?.phone !== phone) state = null; // switched phone → fresh state

  if (state?.access_token) {
    // Try reuse
    try {
      const me = await jfetch('/users/me', { token: state.access_token });
      console.log(`\n🔑 Logged in as ${me.user.display_name || me.user.phone_e164} (${me.user.id})`);
      return state;
    } catch {
      console.log('\n🔁 Stored token expired, re-authenticating…');
    }
  }

  console.log(`\n📱 Requesting OTP for ${phone}`);
  await jfetch('/auth/request-otp', { method: 'POST', body: { phone_e164: phone } });
  console.log('  → Check the backend console for a line like [DEV OTP] +49… → 123456');
  const code = await ask(rl, '  Enter OTP: ');

  // Fresh keypair for this peer device
  const kp = nacl.box.keyPair();
  const res = await jfetch('/auth/verify-otp', {
    method: 'POST',
    body: {
      phone_e164: phone,
      code,
      device: {
        kind: 'mobile',
        label: peerLabel,
        identity_public_key: b64.enc(kp.publicKey),
      },
    },
  });

  state = {
    phone,
    user: res.user,
    device: res.device,
    access_token: res.access_token,
    refresh_token: res.refresh_token,
    secret_key_b64: b64.enc(kp.secretKey),
    public_key_b64: b64.enc(kp.publicKey),
  };

  // Set display name if new user
  if (res.is_new_user) {
    const displayName = await ask(rl, '  Display name (defaults to "Test Peer"): ') || peerLabel;
    const updated = await jfetch('/users/me', {
      method: 'PUT', token: res.access_token,
      body: { display_name: displayName, username: `peer_${Math.random().toString(36).slice(2, 6)}` },
    });
    state.user = updated.user;
  }

  saveState(state);
  console.log(`\n✅ Registered as ${state.user.display_name} (${state.user.id})`);
  console.log(`   device: ${state.device.fingerprint}`);
  return state;
}

// ---------- crypto helpers ----------
function encryptForDevice(plaintext, recipientPkB64, senderSkB64) {
  const nonce = crypto.randomBytes(24);
  const msg = utf8.enc(plaintext);
  const ct = nacl.box(msg, nonce, b64.dec(recipientPkB64), b64.dec(senderSkB64));
  return { ciphertext: b64.enc(ct), nonce: b64.enc(nonce) };
}

function decryptFromDevice(ciphertextB64, nonceB64, senderPkB64, recipientSkB64) {
  const pt = nacl.box.open(
    b64.dec(ciphertextB64), b64.dec(nonceB64),
    b64.dec(senderPkB64), b64.dec(recipientSkB64),
  );
  if (!pt) return null;
  return utf8.dec(pt);
}

// ---------- core loop ----------
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const state = await login(rl);

  // Cache device public keys we see, so we can decrypt + fan out
  const devicePk = new Map(); // deviceId → base64 pubkey
  devicePk.set(state.device.id, state.public_key_b64);

  async function ensureConvDevices(convId) {
    const res = await jfetch(`/conversations/${convId}/devices`, { token: state.access_token });
    for (const d of res.devices) devicePk.set(d.id, d.identity_public_key);
    return res.devices;
  }

  // Preload conversations + their device keys
  const convList = await jfetch('/conversations', { token: state.access_token });
  const convs = convList.conversations;
  console.log(`\n💬 You are in ${convs.length} conversation(s):`);
  for (const c of convs) {
    const name = c.kind === 'direct'
      ? (c.peer?.display_name || c.peer?.username || 'unknown')
      : (c.title || 'group');
    console.log(`   • ${name}  (${c.id.slice(0, 8)}…)`);
    await ensureConvDevices(c.id);
  }

  let activeConv = convs[0] || null;

  // WebSocket
  const ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token: state.access_token }));
  });

  ws.on('message', async (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }

    if (ev.type === 'auth.ok') {
      console.log('🔌 WebSocket connected\n');
      return;
    }

    if (ev.type === 'message.new') {
      const m = ev.message;
      const senderPk = devicePk.get(m.sender_device_id);
      if (!senderPk) await ensureConvDevices(m.conversation_id);
      const senderPk2 = senderPk || devicePk.get(m.sender_device_id);

      let text = '(no key)';
      if (senderPk2 && ev.ciphertext && ev.nonce) {
        text = decryptFromDevice(ev.ciphertext, ev.nonce, senderPk2, state.secret_key_b64) || '(decrypt failed)';
      }

      // Figure out who sent it
      const convName = convs.find((c) => c.id === m.conversation_id);
      const header = convName?.kind === 'direct'
        ? (convName.peer?.display_name || convName.peer?.username || 'peer')
        : (convName?.title || 'chat');
      console.log(`\n← ${header}: ${text}`);

      // Auto-ack
      fetch(`${API}/messages/${m.id}/delivered`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.access_token}` },
      }).catch(() => {});

      if (echo && m.sender_user_id !== state.user.id) {
        // Auto-reply
        setTimeout(() => sendTo(m.conversation_id, `echo: ${text}`), 400);
      }
    }
  });

  ws.on('close', () => console.log('\n🔌 WS closed'));

  async function sendTo(convId, text) {
    const devices = await ensureConvDevices(convId);
    const recipients = devices.map((d) => {
      const { ciphertext, nonce } = encryptForDevice(text, d.identity_public_key, state.secret_key_b64);
      return { device_id: d.id, ciphertext, nonce };
    });
    await jfetch('/messages', {
      method: 'POST',
      token: state.access_token,
      body: { conversation_id: convId, kind: 'text', recipients },
    });
    console.log(`→ sent: ${text}`);
  }

  if (echo) {
    console.log('👂 Auto-echo mode — every incoming message gets a reply. Ctrl+C to quit.\n');
    return;
  }

  // Interactive prompt
  console.log('\nCommands:');
  console.log('  :list           — re-list conversations');
  console.log('  :use <prefix>   — switch active conversation (uses first match of id prefix or name)');
  console.log('  :find <query>   — search users');
  console.log('  :new <user_id>  — create direct chat with user id');
  console.log('  anything else   — send to active conversation');
  console.log('');

  const prompt = () => {
    const label = activeConv
      ? (activeConv.kind === 'direct'
          ? (activeConv.peer?.display_name || activeConv.peer?.username || 'peer')
          : (activeConv.title || 'chat'))
      : '(no chat)';
    rl.setPrompt(`[${label}] › `);
    rl.prompt();
  };
  prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    try {
      if (!input) { /* noop */ }
      else if (input === ':list') {
        const res = await jfetch('/conversations', { token: state.access_token });
        convs.length = 0;
        for (const c of res.conversations) convs.push(c);
        console.log(`${convs.length} conversation(s):`);
        for (const c of convs) {
          const name = c.kind === 'direct'
            ? (c.peer?.display_name || c.peer?.username || 'unknown')
            : (c.title || 'group');
          console.log(`  • ${name}  (${c.id})`);
        }
      }
      else if (input.startsWith(':use ')) {
        const q = input.slice(5).trim().toLowerCase();
        const hit = convs.find((c) => {
          const name = c.kind === 'direct'
            ? (c.peer?.display_name || c.peer?.username || '').toLowerCase()
            : (c.title || '').toLowerCase();
          return c.id.startsWith(q) || name.includes(q);
        });
        if (!hit) console.log('no match');
        else { activeConv = hit; console.log('switched'); }
      }
      else if (input.startsWith(':find ')) {
        const q = input.slice(6).trim();
        const res = await jfetch(`/users/search?q=${encodeURIComponent(q)}`, { token: state.access_token });
        for (const u of res.users) console.log(`  • ${u.display_name || u.username || '—'}  (${u.id})`);
      }
      else if (input.startsWith(':new ')) {
        const userId = input.slice(5).trim();
        const res = await jfetch('/conversations', {
          method: 'POST', token: state.access_token,
          body: { kind: 'direct', member_user_ids: [userId] },
        });
        activeConv = res.conversation;
        if (!convs.find((c) => c.id === res.conversation.id)) convs.push(res.conversation);
        await ensureConvDevices(res.conversation.id);
        console.log(`created ${res.conversation.id}`);
      }
      else if (activeConv) {
        await sendTo(activeConv.id, input);
      }
      else {
        console.log('(no active chat — use :list or :new)');
      }
    } catch (err) {
      console.error('err:', err.message);
    }
    prompt();
  });

  rl.on('close', () => {
    try { ws.close(); } catch {}
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
