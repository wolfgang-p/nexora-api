-- 0031_device_history_request.sql
-- History sync signal ("koro nudges phone"): when a freshly linked device (e.g.
-- the /koro web client) detects it is missing decryptable history, it stamps
-- this column. A device that CAN decrypt the history (the phone) reads the
-- pending requests among its own devices and runs the re-seal backfill, then
-- clears the stamp. Additive, nullable — no data change, safe to re-run.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS history_requested_at TIMESTAMPTZ;
