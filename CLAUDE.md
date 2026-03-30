# Nexora API — Backend

## Overview
Secure E2E encrypted chat backend. Node.js + raw HTTP server + `ws` WebSocket + Supabase (PostgreSQL + Storage).

## Tech Stack
- **Runtime**: Node.js (CommonJS)
- **HTTP**: Built-in `http` module, manual routing (no Express)
- **WebSocket**: `ws` package
- **Database**: Supabase (PostgreSQL) via `@supabase/supabase-js`
- **Auth**: Phone OTP → JWT (custom HMAC-SHA256)
- **Encryption**: Server stores opaque ciphertext only. X25519 keypair generation available server-side but encryption happens client-side.
- **Storage**: Supabase Storage bucket `media`

## Project Structure
```
src/
├── index.js              # Entry: HTTP server + WS server, port 3001
├── router.js             # Manual URL routing + CORS + JSON body parsing
├── middleware/auth.js     # JWT verification middleware
├── routes/
│   ├── auth.js           # POST /auth/request-otp, /verify-otp, /complete-profile
│   ├── users.js          # GET /users/search, /users/:id/profile, PUT /users/profile, settings, blocking
│   ├── conversations.js  # GET/POST /conversations, messages, archive, delete
│   ├── groups.js         # Group management: info, update, members, roles, settings, leave
│   └── media.js          # POST /media/upload (binary stream → Supabase Storage)
├── ws/
│   ├── server.js         # WS setup, heartbeat (30s ping/pong), AUTH timeout (5s)
│   ├── handlers.js       # MESSAGE_SEND/DELIVERED/READ, TYPING, CALL/WebRTC, group events
│   └── connections.js    # In-memory Map<userId, WebSocket>
├── db/supabase.js        # Supabase client init
├── crypto/index.js       # hashOTP, generateOTP, signJWT, verifyJWT, generateKeyPair
└── utils/response.js     # JSON response helpers
migrations/
├── 001_initial (in schema.sql)
├── 002_archive_delete_block.sql
├── 003_message_type_deleted.sql
├── 004_user_settings.sql
└── 005_group_roles_voice.sql  # roles, only_admins_send/edit_info, voice type, duration
```

## Database Tables
`users`, `otps`, `conversations`, `conversation_participants`, `messages`, `blocked_users`, `user_settings`

**Key columns added in migration 005:**
- `conversation_participants.role` — enum: `owner`, `admin`, `member` (default: `member`)
- `conversations.only_admins_send` — bool, blocks members from sending
- `conversations.only_admins_edit_info` — bool, blocks members from editing group info
- `messages.message_type` — now includes `voice`
- `messages.duration` — integer seconds, for voice messages

## API Endpoints

### Public (no auth)
- `GET /health`
- `POST /auth/request-otp`
- `POST /auth/verify-otp`

### Auth
- `POST /auth/complete-profile`

### Users
- `GET /users/search?q=`, `GET /users/:id/profile`, `PUT /users/profile`
- `GET /users/settings`, `PUT /users/settings`
- `GET /users/blocked`, `POST /users/block`, `DELETE /users/:id/block`

### Conversations
- `GET /conversations`, `POST /conversations`
- `GET /conversations/:id/messages?cursor=` — paginated (50/page)
- `GET /conversations/archived`
- `PUT /conversations/:id/archive`, `PUT /conversations/:id/unarchive`
- `DELETE /conversations/:id`, `DELETE /conversations/:id/all`
- `DELETE /messages/:id` — soft delete

### Group Management (`src/routes/groups.js`)
- `GET /conversations/:id/info` — full group info with participants + roles
- `PUT /conversations/:id` — update name/avatar (respects only_admins_edit_info)
- `PUT /conversations/:id/settings` — toggle only_admins_send, only_admins_edit_info (admin+)
- `POST /conversations/:id/participants` — add members (admin+)
- `DELETE /conversations/:id/participants/:userId` — remove member (admin+)
- `PUT /conversations/:id/participants/:userId/role` — change role (owner only, can set admin/member)
- `POST /conversations/:id/leave` — leave group (auto-transfers ownership if owner)

### Media
- `POST /media/upload` — binary body, `X-File-Extension` header. Supports images + voice (m4a)

## WebSocket Messages
Connect to `/ws`, send `{ type: 'AUTH', token }` within 5 seconds.

**Chat**: MESSAGE_SEND (+ `duration` for voice), MESSAGE_RECEIVE, MESSAGE_SENT, MESSAGE_DELIVERED, MESSAGE_READ, MESSAGE_DELETE, MESSAGE_DELETED
**Typing**: TYPING_START, TYPING_STOP
**Group events**: GROUP_UPDATED, GROUP_SETTINGS_CHANGED, GROUP_MEMBER_ADDED, GROUP_MEMBER_REMOVED, GROUP_ROLE_CHANGED
**Calls**: CALL_INITIATE, CALL_INCOMING, CALL_ACCEPT, CALL_ACCEPTED, CALL_REJECT, CALL_REJECTED, CALL_END, CALL_ENDED, CALL_UNAVAILABLE
**WebRTC**: WEBRTC_OFFER, WEBRTC_ANSWER, WEBRTC_ICE_CANDIDATE

## Key Patterns
- **Routing**: `router.js` matches method+path manually. Group routes come before generic conversation routes to avoid conflicts.
- **Auth**: `middleware/auth.js` extracts `req.user = { userId, phone, accountType }` from JWT.
- **WS Auth**: First message must be `{ type: 'AUTH', token }` within 5 seconds.
- **Roles**: `getUserRole()` helper in `groups.js`. Owner > Admin > Member. Only owner can promote/demote admins.
- **only_admins_send**: WS handler checks this before saving/broadcasting a message. Returns ERROR if member tries to send.
- **Voice messages**: `message_type: 'voice'`, `media_url` = Supabase URL to .m4a, `duration` = seconds.
- **Message deletion**: Soft delete — `encrypted_content` set to `''`, `message_type` set to `'deleted'`.
- **Blocking**: Directional. Messages from blocked users are stored but not delivered via WS.
- **Direct conversations**: Deduplicated — reuses existing if both participants already have one.
- **Owner leaving**: Ownership auto-transferred to first admin or first member.

## Environment Variables
```
PORT=3001
NODE_ENV=development
SUPABASE_URL=<supabase-url>
SUPABASE_SERVICE_KEY=<service-key>
JWT_SECRET=<secret>
```

## Running
```bash
npm install
npm start        # node src/index.js
```
