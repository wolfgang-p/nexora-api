# koro-api — Backend

## Status
Fresh slate. The prior Nexora backend has been wiped. `node_modules/` and
`package.json` are preserved; all source + migrations + tests are gone.

## Source of truth
- `ARCHITECTURE.md` — crypto model, data flow, why the schema looks the way it does
- `migrations/0001_core.sql` — the full Postgres/Supabase schema (runnable as one script)
- `../nexora-mobile/design.md` — product-level design doc covering mobile, web, CRM

Read `ARCHITECTURE.md` before generating code — the encryption model is the
reason the schema has `devices`, `message_recipients`, and `media_objects`
shaped the way they are.

## Stack
- Node.js (>=20) — `http` + `ws` modules (no framework yet)
- Supabase Postgres via `@supabase/supabase-js` (service role)
- `expo-server-sdk` for push notifications
- Deployment target TBD (likely Docker behind a reverse proxy)

## What is NOT here yet
- Actual server source (`src/`)
- Routes, WS handlers, auth middleware
- Tests, CI, Dockerfile
- SMS provider wiring

Rebuild these per `ARCHITECTURE.md` when ready. Do not reintroduce the old
Nexora code paths verbatim — several had security issues documented in
`../nexora-mobile/design.md` §1.2.

## Quick start (when ready to build)
```bash
cp .env.example .env                         # fill in secrets
psql $SUPABASE_DB_URL -f migrations/0001_core.sql
npm run dev
```
