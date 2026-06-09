-- =============================================================================
-- Koro — Zero-knowledge E2E key backup
-- =============================================================================
-- Speichert pro User EINEN opaken Blob (salt + nonce + wrapped_secret), mit dem
-- ein neu registriertes/zusätzliches Gerät — zusammen mit der vom Nutzer
-- gewählten Recovery-Passphrase — seinen Device-Secret-Key wiederherstellt, um
-- die Nachrichten-Historie zu entschlüsseln. Der Server sieht NIE die Passphrase
-- oder den Klartext-Key. Siehe src/keys/backup.js (GET/PUT/DELETE /keys/backup).
--
-- Diese Tabelle existierte bisher nur in der Cloud-DB; beim Migrieren über
-- migrations/0001…0025 fehlte sie -> "Backup save failed". Diese Migration holt
-- das nach.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS key_backups (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  salt           TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  wrapped_secret TEXT NOT NULL,
  kdf            TEXT NOT NULL DEFAULT 'pbkdf2-sha256-210k',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defense-in-depth: nur der service_role-Key (Backend) darf ran; ein geleakter
-- anon-Key kommt damit nicht an die wrapped Keys. Das Backend nutzt service_role
-- und umgeht RLS ohnehin.
ALTER TABLE key_backups ENABLE ROW LEVEL SECURITY;

COMMIT;
