# "Login with Koro" (OAuth) — Deploy & Publish

Everything for the feature ships across four repos. Do the steps in this order.

## 1. Database migration (nexora-api)

Apply the new migration against your Supabase Postgres:

```bash
psql "$SUPABASE_DB_URL" -f migrations/0029_oauth.sql
```

It creates `oauth_clients`, `oauth_grants`, `oauth_tokens`, adds the `oauth`
value to the `device_kind` enum, and enables RLS. It's idempotent — safe to
re-run.

> Note: `ALTER TYPE device_kind ADD VALUE 'oauth'` must run **outside** a
> transaction block. Running the file directly with `psql -f` (as above) is
> fine. If your tooling wraps migrations in a transaction, split that one
> statement out.

## 2. API config (nexora-api)

No new **required** env vars — the OAuth tokens reuse `JWT_SECRET`. Optional
tuning (defaults shown):

```bash
OAUTH_GRANT_TTL=300        # consent-QR session lifetime (s)
OAUTH_CODE_TTL=120         # authorization code lifetime after approval (s)
OAUTH_ACCESS_TTL=3600      # OAuth access-token lifetime (s)
OAUTH_REFRESH_TTL=2592000  # OAuth refresh-token lifetime (s, 30d, sliding)
```

Then **restart the API server** so the new `/oauth/*` routes load:

```bash
# on the server
docker compose restart koro-api      # or your usual restart
```

Smoke-test:

```bash
curl -s -X POST https://api.koro.chat:3001/oauth/authorize \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"does_not_exist","scopes":["profile:read"]}'
# → 404 {"error":"Unknown client_id"}  (route is live)
```

## 3. Mobile app (nexora-mobile)

Rebuild / reload the app. New pieces:
- Scanning a `koro_oauth` QR opens `app/oauth-consent.tsx` (in-app consent).
- `app/connected-apps.tsx` (Settings → "Verbundene Apps") lists & revokes apps.

No env changes.

## 4. Developer portal (koro-developer)

Deploy as usual (it reads `NEXT_PUBLIC_API_URL`). New page: **Login mit Koro**
(`/dashboard/oauth`) to register & manage OAuth apps. The `/docs` page now
includes the OAuth section (rendered from `API.md`).

## 5. SDK publish (koro-sdk)

Version is bumped to **0.2.0** (adds `Koro.oauth()`, `Koro.fromUserToken()`,
the `OAuth` class).

```bash
cd koro-sdk
npm run build           # tsup → dist (ESM + CJS + d.ts)
npm publish             # (npm login first if needed; add --access public for first publish)
```

Then bump the consumer:

```bash
cd koro-sdk-test
npm i koro-sdk@latest
```

## 6. Test the end-to-end flow (koro-sdk-test)

1. In the portal, create an OAuth app. Add redirect URI
   `http://localhost:3000/login-demo`. Copy the `client_id` (+ secret).
2. In `koro-sdk-test/.env.local` set `KORO_CLIENT_ID` (and
   `KORO_CLIENT_SECRET` for a confidential app).
3. `npm run dev`, open `/login-demo`, click **Login mit Koro starten**, scan the
   QR with the Koro app, approve on the consent screen → you're redirected back
   and the page shows the user fetched with the scoped token.

## How it stays end-to-end encrypted

The approval provisions a per-grant `oauth` **device owned by the user** with its
own identity key. Peers seal message copies to that key as usual. The user's app
seals the per-grant **secret** to the developer app's ephemeral key, so the
developer (and only the developer) can derive it and open those copies — the
server never sees plaintext. Revoking the connection revokes the device, so the
app stops receiving new sealed copies immediately.
```
