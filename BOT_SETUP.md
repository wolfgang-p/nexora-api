# Bot Device Setup für Message History Sync

## Overview
Der Bot ist ein `api_bot` Device, das alle Nachrichten entschlüsselt und für neue Devices wieder-encryptet.

## Setup-Schritte

### 1. Migration ausführen
```bash
psql $DATABASE_URL -f migrations/0005_bot_device.sql
```

### 2. Bot-Keypair generieren
```bash
node scripts/setup-bot.js
```

Das gibt dir:
- `BOT_DEVICE_ID`
- `BOT_DEVICE_PRIVATE_KEY` (base64)

### 3. Bot-Device in der DB erstellen

Ersetze die UUIDs mit der Output vom Script:

```sql
INSERT INTO devices (id, user_id, kind, label, identity_public_key, fingerprint, enrolled_at) VALUES
('YOUR_BOT_DEVICE_ID'::UUID, '00000000-0000-0000-0000-000000000001'::UUID, 'api_bot', 'Encryption Bot', decode('YOUR_PUBLIC_KEY_B64', 'base64'), 'BOT-ENC', now());
```

### 4. .env updaten
```
BOT_DEVICE_ID=<device-id>
BOT_DEVICE_PRIVATE_KEY=<private-key-base64>
```

### 5. Bot zu allen Conversations hinzufügen

Damit der Bot zukünftige Nachrichten entschlüsseln kann:

```sql
INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
SELECT c.id, '00000000-0000-0000-0000-000000000001'::UUID, 'member', now()
FROM conversations c
WHERE NOT EXISTS (
  SELECT 1 FROM conversation_members cm 
  WHERE cm.conversation_id = c.id 
  AND cm.user_id = '00000000-0000-0000-0000-000000000001'::UUID
)
AND c.deleted_at IS NULL;
```

### 6. Server neustarten
Der API braucht den `BOT_DEVICE_PRIVATE_KEY` aus .env.

## Wie es funktioniert

1. **Nachricht senden**: Client encryptet für alle Members + Bot
2. **Neue Device paired**: Bot entschlüsselt alte Nachrichten + re-encryptet für neue Device
3. **Web-App lädt**: Kann jetzt alle Nachrichten entschlüsseln (hat ciphertext/nonce vom Bot)

## Security Note

Der Bot-Private-Key ist auf dem Server. Das ist ein Kompromiss für die Message History Sync.

- Der Server kann alte Nachrichten lesen (aber nicht sehen, wer sie gelesen hat)
- Der Server kann neue Geräte registrieren (aber nicht alte Geräte impersonieren)
- Wenn der Server kompromittiert wird, sind alle Nachrichten lesbar

Das ist ein Risiko-Nutzen-Trade-off für diese Version.
