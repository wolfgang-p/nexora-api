# koro-api — Backend

## Source of truth
- `ARCHITECTURE.md` — crypto model, data flow, pairing protocol, CRM tiers
- `migrations/0001_core.sql` — full schema
- `migrations/0002_rls_policies.sql` — per-table row-level security
- `../nexora-mobile/design.md` — product-level design (mobile, web, CRM)

Read `ARCHITECTURE.md` before generating server code — the encryption model
is the reason the schema has `devices`, `message_recipients`, and
`media_recipients` shaped the way they are.

## Stack
- Node.js 20+ (no framework; raw `http` + `ws`)
- Supabase Postgres via `@supabase/supabase-js` service-role key
- `jsonwebtoken` for access tokens (HS256, exp-enforced)
- `expo-server-sdk` for push notifications (not yet wired)

## Layout
```
src/
├── index.js                 # http + ws bootstrap
├── config.js                # env loader
├── router.js                # HTTP route matcher
├── db/supabase.js           # service-role client
├── util/                    # response, audit, crypto helpers
├── auth/                    # otp, jwt, middleware
├── api_keys/                # CRM / integration key auth
├── pairing/                 # QR flow: create, claim, deliver, poll
├── users/
├── devices/
├── conversations/
├── messages/                # send (fanout), list, delivered, read, delete
├── reactions/
├── media/                   # signed upload/download URLs, per-device wrapped keys
├── workspaces/
├── tasks/
├── calls/
├── webhooks/                # register + outbound dispatcher
└── ws/                      # server + router + per-device dispatch
```

## Running
```bash
cp .env.example .env                         # fill in secrets
psql $SUPABASE_DB_URL -f migrations/0001_core.sql
psql $SUPABASE_DB_URL -f migrations/0002_rls_policies.sql
npm run dev                                  # watch mode
# or
npm start
```

Without `SMS_PROVIDER` set, OTPs are printed to stderr (dev mode only).

## Endpoint surface (high level)
Full route list lives in `src/router.js`. Summary:

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/request-otp`, `POST /auth/verify-otp`, `POST /auth/refresh`, `POST /auth/logout` |
| Pairing | `POST /pairing/sessions`, `GET /pairing/sessions/:id`, `POST /pairing/sessions/:id/claim`, `POST /pairing/sessions/:id/deliver` |
| Users | `GET /users/me`, `PUT /users/me`, `GET /users/search`, `GET /users/:id` |
| Devices | `GET /devices`, `PUT /devices/:id`, `DELETE /devices/:id`, `GET /conversations/:id/devices` |
| Conversations | `GET /conversations`, `POST /conversations`, `PUT /conversations/:id`, members add/remove/role |
| Messages | `POST /messages` (fanout), `GET /conversations/:id/messages`, delivered/read/delete |
| Reactions | `GET/POST/DELETE /messages/:id/reactions[/…]` |
| Media | `POST /media/upload-url`, `POST /media/:id/recipients`, `GET /media/:id/download-url` |
| Workspaces | `GET/POST /workspaces`, `PUT/DELETE /workspaces/:id`, invites, join |
| Tasks | `GET/POST /tasks`, `PUT/DELETE /tasks/:id`, lists |
| Calls | `POST /calls`, join/leave/end |
| Webhooks | `GET/POST /webhooks`, `DELETE /webhooks/:id` |
| API keys | `GET/POST /workspaces/:id/api-keys`, `DELETE /api-keys/:id` |

WebSocket is at `/ws`. First message must be `{type:"auth", token}` within 5s.
Subsequent messages: `ping`, `typing.start`, `typing.stop`, `webrtc.offer`,
`webrtc.answer`, `webrtc.ice`, `presence.update`.

## Security posture
- JWTs have `exp` claim; access tokens short-lived, refresh rotation.
- OTPs are hashed (SHA-256 + pepper) and capped per phone.
- Server holds only ciphertext for messages; no plaintext path.
- RLS enabled on every user-visible table (service-role bypasses).
- Audit log for every privileged action (see `util/audit.js`).
- CORS allowlist from `CORS_ORIGINS` env.
- API keys are hashed; key secret shown only once at creation.

## Known TODOs before production
- Wire a real SMS provider.
- Rate-limit auth + send endpoints (Redis or Supabase Realtime).
- Push-notification dispatch (send Expo push when target device is offline and `push_tokens` has a token).
- Webhook retry worker (persisted in `webhook_deliveries`; currently best-effort).
- Per-table RLS policy unit tests.
- Dockerfile + CI.
