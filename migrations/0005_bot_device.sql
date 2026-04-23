-- Create bot user and device for message re-encryption
BEGIN;

-- Bot user (special account for encryption operations)
INSERT INTO users (id, phone_e164, display_name, locale)
VALUES (
  '00000000-0000-0000-0000-000000000001'::UUID,
  '+bot',
  'Encryption Bot',
  'en'
)
ON CONFLICT DO NOTHING;

-- Bot device will be created by setup script with actual keypair
-- For now, just a placeholder to avoid FK issues

COMMIT;
