#!/usr/bin/env bash
# Copy the DB SCHEMA ONLY (tables, functions, triggers, RLS policies, types,
# sequences, indexes) from the old Supabase Cloud project to the new
# self-hosted Postgres. NO rows / NO content are transferred.
#
# Usage:
#   SRC_DB_URL="postgresql://postgres.<ref>:<pw>@<host>:5432/postgres" \
#   DST_DB_URL="postgresql://postgres:<pw>@localhost:5432/postgres" \
#   ./deploy/migrate-schema.sh
#
# Requires the postgresql client tools (pg_dump / psql). A client >= the server
# major version works for both dump and restore.
#   Ubuntu 24.04 (Noble):  apt-get install -y postgresql-client-16
set -euo pipefail

: "${SRC_DB_URL:?set SRC_DB_URL to the OLD (cloud) connection string}"
: "${DST_DB_URL:?set DST_DB_URL to the NEW (self-hosted) connection string}"

OUT="schema-$(date +%Y%m%d-%H%M%S).sql"

echo ">>> Dumping schema only (no data) from source ..."
# --schema=public      : only our app schema (skip supabase-internal schemas
#                        like auth/storage that already exist on the target)
# --schema-only        : structure only, zero rows
# --no-owner/--no-acl  : don't try to reassign cloud-specific roles/grants
# --no-comments        : keep it lean (optional; remove if you want comments)
pg_dump \
  --schema=public \
  --schema-only \
  --no-owner \
  --no-privileges \
  "$SRC_DB_URL" > "$OUT"

echo ">>> Wrote $OUT ($(wc -l < "$OUT") lines)."
echo ">>> Applying to destination ..."
psql -v ON_ERROR_STOP=1 "$DST_DB_URL" -f "$OUT"

echo ">>> Reloading PostgREST schema cache ..."
psql "$DST_DB_URL" -c "NOTIFY pgrst, 'reload schema';" || true

echo ">>> Done. Verify with:  psql \"\$DST_DB_URL\" -c '\\dt public.*'"
