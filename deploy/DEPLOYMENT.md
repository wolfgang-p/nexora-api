# koro-api — Migration & Deployment (Docker, Hochverfügbar)

Umzug vom alten `screen`-Setup auf einen sauberen, **ausfallsicheren** Docker-
Stack mit **Zero-Downtime-Deploys** — damit Calls & Meetings ein Update
überleben.

**Komponenten:** Traefik (Reverse Proxy + TLS) · 2× koro-api (blue/green) +
Redis-Bus · selbstgehostetes Supabase (öffentlich unter `db.koro.chat`).

---

## Warum 2 Instanzen + Redis (kurz, aber wichtig)

Der WS-Dispatch hielt Verbindungen bisher **prozess-lokal**. Zwei Instanzen
naiv zu starten wäre **kaputt**: ein `webrtc.offer` von Instanz A erreicht ein
Gerät auf Instanz B nicht → Anruf klingelt nie.

Deshalb fanned der Dispatch jetzt über **Redis Pub/Sub** aus
(`src/ws/dispatch.js`): jede Instanz stellt an ihre lokalen Sockets zu und
published Signaling auf den Bus; die anderen Instanzen liefern an ihre Sockets.
Ein Presence-Mirror hält `deviceOnline` instanzübergreifend korrekt. Ohne
`REDIS_URL` läuft alles unverändert als Einzelinstanz.

**Beruhigend bei Deploys:** Aktive Call-/Meeting-**Medien laufen P2P bzw. über
TURN — nie über diesen Server.** Der Server macht nur Signaling. Ein
Instanz-Neustart unterbricht also **kein laufendes Audio/Video**. Beim Rolling
Deploy bedient immer mindestens eine Instanz; betroffene Clients reconnecten in
Sekundenbruchteilen zur gesunden Instanz (Failover über Traefik-Healthcheck).

```
                Internet : 443 + 3001 (api.koro.chat) · 443 (db.koro.chat)
                                  │
                          ┌───────▼────────┐
                          │     Traefik    │  TLS/ACME, Healthcheck-LB,
                          │  (Auto-Discovery)│ Sticky-Cookie
                          └───┬────────┬────┘
                  api.koro.chat│        │db.koro.chat
              ┌───────────────┴┐   ┌───┴───────────────┐
              ▼                ▼   ▼                    ▼
        ┌──────────┐    ┌──────────┐            ┌──────────────┐
        │ koro-api │    │ koro-api │            │  Supabase    │
        │  blue    │    │  green   │            │  kong/rest/  │
        └────┬─────┘    └────┬─────┘            │  postgres/…  │
             │   ┌───────────┘                  └──────┬───────┘
             ▼   ▼   (WS-Fanout)                       │ http://supabase-kong:8000
          ┌─────────┐                                  │ (intern)
          │  redis  │◄─────────── koro-api ────────────┘
          └─────────┘
```

> **Media-Hinweis:** Hochgeladene Dateien liegen lokal in `uploads/`
> (`src/media/fs.js`), nicht in Supabase Storage. Beide koro-api-Instanzen
> teilen sich dasselbe Docker-Volume `koro-uploads`.

---

## 0. Server vorbereiten

```bash
curl -fsSL https://get.docker.com | sh
docker compose version                       # v2 erforderlich
apt-get update && apt-get install -y git postgresql-client-15

sudo mkdir -p /opt/koro-api && sudo chown "$USER" /opt/koro-api
git clone <DEIN_REPO_URL> /opt/koro-api
cd /opt/koro-api

# Gemeinsames Netzwerk, EINMALIG:
docker network create edge
```

**DNS** (TTL vorher klein setzen) auf die neue Server-IP:
`api.koro.chat`, `db.koro.chat`, optional `studio.koro.chat`.
Let's Encrypt braucht Port **80** öffentlich erreichbar.

---

## 1. Supabase selbst hosten

```bash
git clone --depth 1 https://github.com/supabase/supabase /opt/supabase
cp -r /opt/supabase/docker /opt/supabase-stack
cd /opt/supabase-stack
cp .env.example .env
```

**Secrets generieren** und in die Supabase-`.env` eintragen:

```bash
openssl rand -hex 32          # -> POSTGRES_PASSWORD
openssl rand -base64 48       # -> JWT_SECRET (signiert ANON_KEY + SERVICE_ROLE_KEY)
```

Daraus passende `ANON_KEY` / `SERVICE_ROLE_KEY` erzeugen (mit deinem
`JWT_SECRET` signieren):
<https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys>

**Override einspielen** (hängt Kong ans `edge`-Netz + Route `db.koro.chat`,
optional Studio):

```bash
cp /opt/koro-api/deploy/supabase.override.yml \
   /opt/supabase-stack/docker-compose.override.yml
cd /opt/supabase-stack && docker compose up -d && docker compose ps
```

Danach:
- intern: `http://supabase-kong:8000` (so spricht koro-api Supabase an)
- öffentlich: `https://db.koro.chat` (Mobile/Web/Tools)
- Postgres: `localhost:5432` (für die Schema-Migration unten)

---

## 2. DB-Schema migrieren — **OHNE Inhalt**

Reine Struktur (Tabellen, Funktionen, Trigger, RLS-Policies, Typen, Sequenzen,
Indizes), **null Datenzeilen**:

```bash
cd /opt/koro-api
SRC_DB_URL="postgresql://postgres.<ref>:<CLOUD_PW>@<cloud-host>:5432/postgres" \
DST_DB_URL="postgresql://postgres:<NEW_POSTGRES_PASSWORD>@localhost:5432/postgres" \
./deploy/migrate-schema.sh
```

Intern: `pg_dump --schema-only --no-owner --no-privileges --schema=public`,
danach `psql`-Import + PostgREST-Cache-Reload. Prüfen:

```bash
psql "$DST_DB_URL" -c '\dt public.*'
psql "$DST_DB_URL" -c 'SELECT count(*) FROM messages;'   # -> 0
```

> Fallback (deterministisch aus dem Repo):
> `for f in migrations/0*.sql; do psql "$DST_DB_URL" -v ON_ERROR_STOP=1 -f "$f"; done`

---

## 3. koro-api-`.env` anpassen

In `/opt/koro-api/.env` (NICHT committed):

```ini
NODE_ENV=production
PORT=3001
SUPABASE_URL=http://supabase-kong:8000              # intern!
SUPABASE_SERVICE_ROLE_KEY=<neuer service_role key>
SUPABASE_ANON_KEY=<neuer anon key>
CORS_ORIGINS=https://koro.chat,https://crm.koro.chat,https://api.koro.chat
```

`REDIS_URL`, `INSTANCE_ID`, `CERT_DIR`, `DRAIN_DELAY_MS` werden vom
Compose-File gesetzt — nicht in die `.env` schreiben.

> **Secrets rotieren** beim Umzug: `JWT_SECRET` und `OPENAI_API_KEY` neu setzen
> (lagen bisher im Klartext in der `.env`). Supabase-Keys ändern sich durchs
> Self-Hosting ohnehin.

---

## 4. Proxy + API starten

```bash
cd /opt/koro-api

# 1) Traefik (holt automatisch die Let's-Encrypt-Zertifikate)
docker compose -f deploy/docker-compose.proxy.yml up -d

# 2) Beide API-Instanzen + Redis, mit Build
docker compose -f deploy/docker-compose.api.yml up -d --build

docker compose -f deploy/docker-compose.api.yml ps    # blue+green healthy?
```

Test (sobald DNS zeigt):

```bash
curl -i https://api.koro.chat:3001/health     # legacy-Port -> {"ok":true}
curl -i https://api.koro.chat/health          # zusätzlich 443
curl -i https://db.koro.chat/rest/v1/          # Supabase öffentlich
```

WebSocket `/ws` läuft automatisch über denselben Router.

---

## 5. Zero-Downtime-Deploy bei Git-Änderungen (Cron-Polling)

`deploy/deploy.sh` prüft per `git fetch`, baut bei Änderung das Image **einmal**
und recreated dann **eine Instanz nach der anderen**:

1. `api-blue` neu → wartet bis Docker-Healthcheck `healthy` (green bedient).
2. `api-green` neu → wartet bis `healthy` (blue bedient).

Beim Stoppen einer Instanz: `/health` → 503 → Traefik nimmt sie in ~3 s raus →
WS-Sockets werden mit `1012 restart` geschlossen → Clients reconnecten zur
gesunden Instanz. Redis und Traefik werden **nie** angefasst.

```bash
crontab -e
```
```cron
*/2 * * * * /opt/koro-api/deploy/deploy.sh >> /var/log/koro-deploy.log 2>&1
```

- Manuell sofort deployen: `/opt/koro-api/deploy/deploy.sh`
- Logs: `tail -f /var/log/koro-deploy.log`
- Anderer Branch: `DEPLOY_BRANCH=staging` voranstellen.

---

## 6. Neue Services hinzufügen — ohne Restart der laufenden

Genau dafür sind `edge` + Traefik-Auto-Discovery da. Neuer Dienst =
eigene Compose-Datei mit Labels, dann `docker compose -f … up -d`. Traefik
erkennt den Container sofort über Docker-Events und richtet Route + Zertifikat
ein — **koro-api, Redis, Supabase und Traefik laufen unverändert weiter.**

```yaml
name: foo
services:
  foo:
    image: dein/foo:latest
    networks: [edge]
    labels:
      - traefik.enable=true
      - traefik.docker.network=edge
      - "traefik.http.routers.foo.rule=Host(`foo.koro.chat`)"
      - traefik.http.routers.foo.entrypoints=websecure
      - traefik.http.routers.foo.tls=true
      - traefik.http.routers.foo.tls.certresolver=le
      - traefik.http.services.foo.loadbalancer.server.port=8080
networks:
  edge: { external: true }
```

---

## 7. Cutover-Reihenfolge (alt → neu, ohne Datenverlust-Risiko)

1. Neuen Server komplett aufsetzen (Schritte 0–4), DNS noch auf altem Server.
2. Schema migrieren (Schritt 2) — leere, strukturgleiche DB.
3. Lokal testen: in deine `/etc/hosts` `api.koro.chat`/`db.koro.chat` auf die
   neue IP zeigen lassen und durchklicken.
4. DNS umstellen (TTL war klein). Auf Traefik-Logs warten bis die Zertifikate
   da sind: `docker compose -f deploy/docker-compose.proxy.yml logs -f traefik`.
5. Verifizieren: Login, Nachricht, **Call zwischen zwei Geräten**, Meeting.
6. Einen Test-Deploy fahren (`./deploy/deploy.sh` nach Dummy-Commit) und dabei
   einen aktiven Call beobachten — er darf nicht abbrechen.
7. Alten Server abschalten.

> Diese Anleitung migriert **Schema ohne Daten**. Echte Daten/Media später:
> `pg_dump` ohne `--schema-only` für die DB + `rsync` von `uploads/` ins
> `koro-uploads`-Volume — sag Bescheid, dann ergänze ich das sauber inkl.
> Storage-Konsistenz.

---

## Cheat-Sheet

| Aufgabe | Befehl |
|---|---|
| Netzwerk anlegen (1×) | `docker network create edge` |
| Proxy starten | `docker compose -f deploy/docker-compose.proxy.yml up -d` |
| API (blue+green+redis) starten | `docker compose -f deploy/docker-compose.api.yml up -d --build` |
| Status der Instanzen | `docker compose -f deploy/docker-compose.api.yml ps` |
| Logs einer Instanz | `docker logs -f koro-api-blue` |
| Supabase starten | `cd /opt/supabase-stack && docker compose up -d` |
| Schema migrieren | `SRC_DB_URL=… DST_DB_URL=… ./deploy/migrate-schema.sh` |
| Zero-Downtime-Deploy | `./deploy/deploy.sh` |
| Health prüfen | `curl -s https://api.koro.chat:3001/health` |

---

## Troubleshooting

- **Call klingelt cross-device nicht** → Redis prüfen: `docker logs koro-redis`,
  und in den API-Logs muss `[ws-bus] subscribed (instance=blue/green)` stehen.
- **Deploy bricht ab „not healthy"** → `docker logs --tail 50 koro-api-blue`;
  meist `.env`/Supabase-Erreichbarkeit (`http://supabase-kong:8000`).
- **Kein Zertifikat** → Port 80 offen? DNS korrekt? `traefik`-Logs ansehen.
- **`db.koro.chat` 404** → liegt `supabase.override.yml` als
  `docker-compose.override.yml` im Supabase-Ordner und ist Kong am `edge`-Netz?
