# Koro API — Architecture

> Companion to `migrations/0001_core.sql`. Read both before writing server code.
> Version 0.1 · 2026-04

---

## 0. Design goals

1. **True end-to-end encryption.** The server never has access to message plaintext.
2. **Multi-client access.** The same user can read messages from mobile, web, desktop, CRM, and API bots.
3. **Metadata-searchable.** Conversation lists, unread counts, sender, timestamps, thread structure, reactions — all queryable server-side without decryption.
4. **Auditable.** Every privileged action (device enroll, message delete, role change, webhook fire) lands in `audit_events`.
5. **RLS-safe.** Postgres row-level security is enabled on every table so a leaked Supabase anon key cannot read arbitrary data.

These four combined force a specific answer: **fanout encryption per device** (the Signal / iMessage model).

---

## 1. Identity model

```
user  ─┬─ device (mobile)
       ├─ device (web browser 1)
       ├─ device (web browser 2)
       ├─ device (desktop app)
       ├─ device (crm_seat)        ← enrolled explicitly by admin
       └─ device (api_bot)         ← programmatic
```

- A **user** is a human with a phone number. That's it.
- A **device** is anything that holds a private key and wants to read plaintext.
- `device.identity_public_key` is what senders encrypt to. Private key never leaves the device.
- `device.fingerprint` is the short human-readable string shown in UI ("A9F2 · C31B · …") — derived deterministically from the public key so peers can verify out-of-band.

### Device kinds
| kind | enrolled by | typical use |
|---|---|---|
| `mobile` | OTP sign-up | iOS / Android app |
| `web` | QR pairing from mobile | Browser client |
| `desktop` | QR pairing from mobile | Native desktop app |
| `crm_seat` | workspace admin via API key | Support agent, ops team reading plaintext |
| `api_bot` | workspace admin via API key | Automation (send messages, read metadata only, or full fanout) |

**Any device kind can be a recipient.** That's how CRM/API gets plaintext *when it's supposed to* — the admin opts it in.

---

## 2. Message flow (the core of the system)

### 2.1 Sending a message

Client-side (no server help needed for the crypto):
1. Sender gathers the list of recipient **devices** for the conversation:
   `SELECT d.id, d.identity_public_key FROM devices d JOIN conversation_members cm … WHERE cm.conversation_id = $1 AND d.revoked_at IS NULL`.
2. For each recipient device, compute `ciphertext = nacl.box(plaintext, nonce, sender_sk, device_pk)`. Fresh random nonce per box.
3. POST to API:
   ```json
   {
     "conversation_id": "…",
     "kind": "text",
     "reply_to_message_id": null,
     "recipients": [
       { "device_id": "…", "ciphertext": "<base64>", "nonce": "<base64>" },
       { "device_id": "…", "ciphertext": "<base64>", "nonce": "<base64>" },
       ...
     ]
   }
   ```
4. Server validates that every `device_id` belongs to a current member of the conversation, writes one row to `messages` + N rows to `message_recipients`, and fans out over WebSocket.

Server never sees plaintext. It validates shape, ownership, and ordering only.

### 2.2 Receiving a message

Each device has a WS connection. On new `message_recipients` row for this device's id:

1. Server pushes the envelope (from `messages`) + this device's `{ciphertext, nonce}`.
2. Client decrypts locally using its private key.
3. Client acknowledges → server sets `delivered_at`.
4. Client later calls `/messages/:id/read` → server sets `read_at`.

### 2.3 Adding a new device later

Critical: **past messages were never encrypted for a device that didn't exist yet.** The new device can only read messages from enrollment forward.

Two workarounds:
- **Live sync** — QR pairing transfers the user's identity key so the new device can negotiate forward. Past messages remain unreadable on that device. (Signal behaves this way.)
- **Encrypted backup** — out of scope for v1. If we ever add it, it would be a user-key-wrapped archive stored in Supabase Storage that a new device can pull after QR verification.

For Koro v1 we ship "live sync only". The UI should tell the user this.

### 2.4 Revoking a device

`UPDATE devices SET revoked_at = now()`. The client is immediately kicked from its WS session and any future `message_recipients` fanout skips it. Already-delivered `message_recipients` rows stay in the DB but are unreadable without the private key, which was on the revoked device.

---

## 3. Who can read what

| Role | Metadata (sender, time, conv id) | Plaintext |
|---|---|---|
| Member of the conversation (any of their devices) | ✅ | ✅ (their devices get fanout) |
| Non-member user | ❌ | ❌ |
| CRM/bot with API key, no `crm_seat` device | ✅ (scoped by workspace + `scopes`) | ❌ |
| CRM with `crm_seat` device, enrolled by admin | ✅ | ✅ (gets fanout, decrypts client-side) |
| Supabase service-role key holder (backend process) | ✅ | ❌ (no private keys on server) |
| Database dump attacker | ✅ (envelopes) | ❌ |

**Principle: plaintext visibility follows private keys, not tokens.** Tokens unlock API access; keys unlock content. The two axes are orthogonal and that's the whole point.

---

## 4. Pairing protocol (QR)

Flow for web / desktop / CRM-seat enrollment:

```
┌─ new device (web) ──────┐                ┌─ existing (mobile) ─┐
│ 1. POST /pairing        │                │                     │
│    → {id, code, nonce}  │                │                     │
│ 2. gen ephemeral keys   │                │                     │
│ 3. render QR:           │ ──── scan ───► │ 4. POST …/claim     │
│    {id, code, eph_pub}  │                │                     │
│ 6. poll …/:id           │ ◄── ciphertext │ 5. encrypt user     │
│ 7. decrypt              │                │    identity key to  │
│ 8. register as device   │                │    eph_pub, POST    │
│    → own keypair        │                │    …/deliver        │
└─────────────────────────┘                └─────────────────────┘
```

- Session expires in 120 s.
- `code` is a 5-char string (`7F2KD`) shown under the QR — user verifies it matches on both screens before accepting.
- `/claim` and `/deliver` are one-shot per session.
- After success, the new device registers itself with its own keypair (not the user's). The mobile device only passed the *user's identity key* so the new device can derive how to sign under the same user identity.

See `pairing_sessions` table.

---

## 5. Media

Same fanout idea, slightly different:

1. Sender generates a random content key `K`.
2. Sender encrypts the file with `K` (XChaCha20-Poly1305, streaming), uploads ciphertext blob to Supabase Storage under `MEDIA_BUCKET`.
3. Sender wraps `K` per recipient device: `wrapped = nacl.box(K, nonce, sender_sk, device_pk)`. Writes `media_recipients` rows.
4. Writes a `messages` row with `kind='image'|'voice'|…` and `media_object_id` pointing at the blob.
5. Recipient: pull message → look up `media_recipients` row for own device → unwrap K → fetch blob (signed URL) → decrypt locally.

Signed URL mint is the API layer's job (authorize by conversation membership + not-revoked device).

---

## 6. CRM integration

Two tiers. An operator picks which one they need.

### Tier A — Metadata mode (default)

- Admin creates an `api_key` with scopes like `conversations:read`, `tasks:write`.
- No device enrolled.
- CRM can list conversations, see sender names, timestamps, reactions, task events.
- Message body comes back as `{ "encrypted": true, "kind": "text" }` — no plaintext.
- Good for: SLA reporting, assigning tasks, firing workflows on metadata events.

### Tier B — Agent seat

- Admin explicitly enrolls a `crm_seat` device for a specific agent (e.g. "Support-Bot-1"). This device gets its own keypair, generated by the CRM and published to the API.
- The CRM is now a member device like any other. It receives fanout.
- Legally significant: this must be surfaced in product UI. End users should see "CRM has plaintext access" as a warning label on any workspace where a `crm_seat` exists.

`api_keys.crm_device_id` ties the key to a specific device so fanout is easy to verify.

---

## 7. Webhooks

`webhooks` + `webhook_deliveries` implement a retry-with-backoff dispatcher.

Payloads default to metadata only:
```json
{
  "event": "message.created",
  "message_id": "…",
  "conversation_id": "…",
  "sender_user_id": "…",
  "kind": "text",
  "created_at": "…",
  "has_media": false
}
```

If the webhook is associated with a `crm_seat` device (optional column, not in the base schema — add in a follow-up migration), payloads can additionally include `{ciphertext, nonce}` for that device.

All payloads are HMAC-SHA256 signed with `webhooks.secret` in the `X-Koro-Signature` header.

---

## 8. Rate limiting & abuse

Not enforced by the schema. Plan for:
- `otps.attempts` — cap per phone per hour.
- Per-IP and per-user budget in Redis (or Supabase Realtime) for OTP requests, pairing attempts, message sends, media uploads.
- Media size cap enforced by the upload route (25 MB default).

---

## 9. What's intentionally *not* in the schema

- **Message edits** — we record `edited_at` but store only the latest ciphertext. An edit is a new fanout to all recipients. We do not keep history server-side.
- **Typing indicators, presence** — ephemeral, WS-only, not persisted.
- **Call recordings** — out of scope.
- **AI-extracted task storage beyond what the client sends.** If you ever add server-side AI, spell out the data flow explicitly — anything AI reads, the server reads, and that breaks the E2E promise for that data.
- **Tasks / system messages are plaintext by design.** They are *outcomes of* a conversation, not the conversation itself. If a user converts a message into a task, the client sends the title as plaintext.

---

## 10. File layout (once the server exists)

```
src/
├── index.js                 # http + ws bootstrap
├── config.js                # env loader
├── db/
│   └── supabase.js          # service-role client
├── auth/
│   ├── otp.js               # request/verify OTP, issue access+refresh tokens
│   ├── jwt.js               # sign/verify access tokens (exp!)
│   └── middleware.js        # extract Bearer token, load device+user
├── pairing/
│   ├── create.js            # POST /pairing/sessions
│   ├── claim.js             # POST /pairing/sessions/:id/claim
│   ├── deliver.js           # POST /pairing/sessions/:id/deliver
│   └── poll.js              # GET  /pairing/sessions/:id
├── messages/
│   ├── send.js              # POST /messages (validates fanout shape)
│   ├── list.js              # GET  /conversations/:id/messages
│   ├── delete.js
│   └── read.js
├── media/
│   ├── upload.js            # signed URL or direct proxy upload
│   └── download.js          # signed URL mint
├── conversations/ ...
├── workspaces/ ...
├── tasks/ ...
├── calls/ ...
├── webhooks/
│   ├── register.js
│   └── dispatcher.js        # background worker firing deliveries
├── ws/
│   ├── server.js            # WS upgrade + auth
│   └── router.js            # message routing per event type
├── api_keys/
│   └── middleware.js        # alternative auth path for CRM/integrations
└── util/
    ├── response.js
    └── audit.js             # helper to write audit_events
```

---

## 11. Migrations convention

- One file per migration. Numbered `0001_`, `0002_`, never renumbered.
- Migrations are additive. To change a column, add a new migration.
- Every migration is wrapped in `BEGIN; … COMMIT;`.
- Use a runner (node-pg-migrate, graphile-migrate, or a hand-rolled script that tracks `schema_migrations`).

Current migrations:
- `0001_core.sql` — everything above

Next planned:
- `0002_rls_policies.sql` — per-table RLS policies once session context is pinned
- `0003_indexes_perf.sql` — tuning after load-testing
