# Meeting per API anlegen

Wie man über die nexora-API ein (geplantes) koro-meet-Meeting erstellt und
die fertige Beitritts-URL zurückbekommt.

Das relevante Backend liegt in `src/meetings/index.js` (Handler `create`),
geroutet in `src/router.js`:

```
POST /meetings   →  meetings.create   { auth: false, optionalAuth: true }
```

`optionalAuth: true` bedeutet: ein Bearer-Token ist **optional**. Ohne Token
wird das Meeting als „Gast-Meeting" angelegt – genau das, was man für eine
externe/programmatische Terminbuchung braucht. Mit Token wird der
eingeloggte Koro-Account als Gastgeber hinterlegt.

---

## Endpoint

```
POST {API_BASE_URL}/meetings
Content-Type: application/json
```

- **Lokal (Dev):** `API_BASE_URL = http://localhost:3001`
- **Produktion:** `API_BASE_URL = https://api.koro.chat:3001`

---

## Request-Body

| Feld               | Typ     | Pflicht | Beschreibung |
|--------------------|---------|---------|--------------|
| `title`            | string  | **Ja**  | Titel des Meetings (max. 200 Zeichen). |
| `host_name`        | string  | **Ja*** | Name des Gastgebers (max. 64 Zeichen). *Pflicht, wenn **ohne** Koro-Account erstellt wird. Mit eingeloggtem Account wird stattdessen der Account als Gastgeber genutzt und das Feld ignoriert. |
| `scheduled_at`     | string  | Nein    | Startzeitpunkt als vollständiger ISO-8601-Zeitstempel inkl. Zeitzone, z. B. `2026-06-01T15:00:00Z` oder `2026-06-01T15:00:00+02:00`. |
| `date` + `time`    | string  | Nein    | Alternative zu `scheduled_at`: Datum `YYYY-MM-DD` **und** Uhrzeit `HH:MM` (Sekunden optional). Müssen **zusammen** übergeben werden. |
| `utc_offset`       | string  | Nein    | Zeitzonen-Offset für `date`+`time`, z. B. `+02:00`. **Default: `Z` (UTC)** – immer angeben, sonst wird die Zeit als UTC interpretiert! |
| `description`      | string  | Nein    | Beschreibung/Agenda (max. 2000 Zeichen). |
| `max_participants` | number  | Nein    | Teilnehmerlimit, 2–50. Default 50. |
| `allow_guests`     | boolean | Nein    | Ob Gäste (ohne Account) beitreten dürfen. Default `true`. |
| `workspace_id`     | string  | Nein    | Zuordnung zu einem Workspace (optional). |

> **Datum + Uhrzeit getrennt übergeben:** Nutze `date`, `time` und
> `utc_offset` zusammen. Ohne `utc_offset` wird die Uhrzeit als **UTC**
> gewertet – für deutsche Ortszeit also `"+02:00"` (Sommerzeit) bzw.
> `"+01:00"` (Winterzeit) setzen, oder gleich `scheduled_at` mit Offset
> verwenden.

Wird **weder** `scheduled_at` **noch** `date`/`time` übergeben, entsteht ein
„Sofort-Meeting" ohne geplanten Start (jeder kann direkt beitreten).

---

## Response — `201 Created`

```json
{
  "meeting": {
    "id": "f1e2d3c4-…",
    "room_id": "abc-defg-hij",
    "title": "Quartals-Review",
    "description": null,
    "host_user_id": null,
    "host_name": "Anna Beispiel",
    "scheduled_at": "2026-06-01T13:00:00.000Z",
    "started_at": null,
    "ended_at": null,
    "max_participants": 50,
    "allow_guests": true,
    "locked": false,
    "created_at": "2026-05-27T10:00:00.000Z"
  },
  "room_id": "abc-defg-hij",
  "url": "https://meet.koro.chat/m/abc-defg-hij"
}
```

Das, was du brauchst, ist **`url`** – die fertige Beitritts-URL. `room_id`
ist die gleiche Kennung nochmal separat (z. B. zum Speichern in der eigenen DB).

### Marken-/Domain-Logik der URL (wichtig)

koro-meet ist **ein Frontend unter zwei Domains** (Marken):

| Marke  | Frontend-Domain        |
|--------|------------------------|
| Koro   | `https://meet.koro.chat`  |
| Nexoro | `https://meet.nexoro.net` |

Die API wählt die Domain der zurückgegebenen `url` **automatisch anhand der
aufrufenden Domain** (`Origin`- bzw. `Referer`-Header des Requests):

- Request kommt von **`koro.chat`** (inkl. Subdomains wie `meet.koro.chat`)
  → `url` zeigt auf **`https://meet.koro.chat/m/…`**
- Request kommt von **irgendeiner anderen Domain** (z. B. `nexoro.net`)
  → `url` zeigt auf **`https://meet.nexoro.net/m/…`**
- Kein `Origin`/`Referer` ermittelbar (z. B. reiner Server-zu-Server-Call
  ohne diese Header) → Fallback **`https://meet.koro.chat`**

Da Browser bei `fetch`/XHR automatisch den `Origin`-Header mitschicken,
funktioniert das für Frontend-Aufrufe ohne weiteres Zutun: ein Aufruf aus
der Nexoro-Oberfläche liefert eine `meet.nexoro.net`-URL zurück, ein Aufruf
aus der Koro-Oberfläche eine `meet.koro.chat`-URL.

> **Domains überschreiben (z. B. Staging):** Per Env-Variablen im
> nexora-API-Prozess:
> - `MEET_BASE_URL_KORO`   (Default `https://meet.koro.chat`)
> - `MEET_BASE_URL_NEXORO` (Default `https://meet.nexoro.net`)
>
> `MEET_BASE_URL` wird als Alt-Fallback für die Koro-Basis weiterhin
> akzeptiert.

> **Server-zu-Server eine bestimmte Marke erzwingen:** Setze einfach den
> `Origin`-Header passend, z. B. `-H "Origin: https://meet.nexoro.net"` für
> eine Nexoro-Link-Ausgabe (siehe Beispiel 5 unten).

---

## Beispiele

### 1) Geplant – Datum + Uhrzeit getrennt (deutsche Ortszeit)

```bash
curl -X POST https://api.koro.chat:3001/meetings \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Quartals-Review",
    "host_name": "Anna Beispiel",
    "date": "2026-06-01",
    "time": "15:00",
    "utc_offset": "+02:00"
  }'
```

### 2) Geplant – ein einziger ISO-Zeitstempel

```bash
curl -X POST https://api.koro.chat:3001/meetings \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Kickoff",
    "host_name": "Anna Beispiel",
    "scheduled_at": "2026-06-01T15:00:00+02:00",
    "description": "Projektstart, Agenda folgt.",
    "max_participants": 12
  }'
```

### 3) Sofort-Meeting (kein geplanter Start)

```bash
curl -X POST https://api.koro.chat:3001/meetings \
  -H "Content-Type: application/json" \
  -d '{ "title": "Ad-hoc Sync", "host_name": "Anna Beispiel" }'
```

### 4) Als eingeloggter Koro-Nutzer (Account ist Gastgeber)

```bash
curl -X POST https://api.koro.chat:3001/meetings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{ "title": "Team-Standup", "scheduled_at": "2026-06-01T07:30:00Z" }'
```

(Mit Token wird `host_name` ignoriert; Gastgeber ist der Account.)

### 5) Nexoro-Link aus einem Server-zu-Server-Call erzwingen

```bash
curl -X POST https://api.koro.chat:3001/meetings \
  -H "Content-Type: application/json" \
  -H "Origin: https://meet.nexoro.net" \
  -d '{ "title": "Nexoro Sync", "host_name": "Anna Beispiel" }'
# → "url": "https://meet.nexoro.net/m/abc-defg-hij"
```

### JavaScript (fetch)

```js
const res = await fetch('https://api.koro.chat:3001/meetings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: 'Quartals-Review',
    host_name: 'Anna Beispiel',
    date: '2026-06-01',
    time: '15:00',
    utc_offset: '+02:00',
  }),
});
const { url } = await res.json();
console.log('Meeting-Link:', url); // → https://meet.koro.chat/m/abc-defg-hij
```

---

## Verhalten geplanter Meetings (wichtig)

- **Vor dem geplanten Zeitpunkt** ist die Beitritts-Seite eine
  Countdown-Ansicht. Gäste können erst zum geplanten Start beitreten
  (`POST /meetings/:roomId/join` liefert vorher `403 „Meeting hat noch nicht
  begonnen."`). Ein eingeloggter Koro-Gastgeber darf bereits vorher rein.
- **Gastgeber-Rolle:** Bei Gast-Meetings (ohne Koro-Account) wird der
  Gastgeber-**Name** gespeichert und angezeigt. Die Host-Rechte (Teilnehmer
  entfernen, PDF teilen, „jetzt starten") bekommt automatisch, **wer als
  Erstes** dem Raum beitritt. Plane das Meeting also und teile die URL –
  wer zuerst öffnet, ist Host.
- **Beitreten** erfolgt anschließend über die zurückgegebene `url`; der
  Client ruft intern `POST /meetings/:roomId/join` auf.

---

## Fehlerfälle — `400 Bad Request`

| Meldung (`error`) | Ursache |
|-------------------|---------|
| `title required (≤200 chars)` | `title` fehlt oder zu lang. |
| `host_name required when creating without a Koro account` | Ohne Bearer-Token muss `host_name` gesetzt sein. |
| `scheduled_at invalid (use ISO-8601, …)` | `scheduled_at` nicht parsebar. |
| `date and time must be provided together (YYYY-MM-DD + HH:MM)` | Nur eines von `date`/`time` übergeben. |
| `date invalid (expected YYYY-MM-DD)` | Datumsformat falsch. |
| `time invalid (expected HH:MM or HH:MM:SS)` | Uhrzeitformat falsch. |
| `date/time/utc_offset combination invalid` | Kombination ergibt kein gültiges Datum. |

Server-Fehler liefern `500` mit `{ "error": "Could not create meeting" }`.
