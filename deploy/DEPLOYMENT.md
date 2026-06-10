# koro-api — Migration & Deployment (Docker, Hochverfügbar)

Umzug vom alten `screen`-Setup auf einen sauberen, **ausfallsicheren** Docker-
Stack mit **Zero-Downtime-Deploys** — damit Calls & Meetings ein Update
überleben.

**Komponenten:** Traefik (Reverse Proxy + TLS) · 2× koro-api (blue/green) +
Redis-Bus · selbstgehostetes Supabase (öffentlich unter `db.koro.chat`).

---

## Schnellstart — alles automatisch (`deploy/install.sh`)

Statt die Schritte unten von Hand abzuarbeiten gibt es ein One-Shot-Script,
das **alles hintereinander** erledigt: Docker + Tools installieren, `edge`-Netz
anlegen, Traefik starten, Supabase selbst hosten (Secrets generieren,
`ANON_KEY`/`SERVICE_ROLE_KEY` aus dem `JWT_SECRET` signieren, `.env` schreiben),
das Schema per `migrations/0001 … 0025` **nacheinander** anlegen, die koro-api
`.env` bauen (Supabase-Werte automatisch, der Rest interaktiv abgefragt) und
zuletzt blue + green + Redis bauen & starten.

```bash
git clone <DEIN_REPO_URL> /opt/koro-api
cd /opt/koro-api
sudo ./deploy/install.sh
```

**Ganz am Anfang fragt das Script die Umgebung ab** und konfiguriert Domains +
Deploy-Branch automatisch:

| Auswahl | Domains | Deploy-Branch (`deploy.sh`) |
|---|---|---|
| production | `api.koro.chat`, `db.koro.chat`, `studio.koro.chat` | `main` |
| staging | `api-staging.koro.chat`, `db-staging…`, `studio-staging…` | `staging` |
| dev | `api-dev.koro.chat`, `db-dev…`, `studio-dev…` | `dev` |

Die Wahl wird in `deploy/koro-deploy.conf` gespeichert (pro Server, nicht
committet); `deploy.sh` zieht dann automatisch den passenden Branch und
`koroctl.sh`/Compose nutzen die passenden Domains (`${API_HOST}` etc.).

Das Script gibt **saubere Status-Logs** aus (Schritte, ✓/✗, Warnungen); das
Paket-/Build-Rauschen landet in `/var/log/koro-install-<ts>.log`. Generierte
Secrets werden zusätzlich in `deploy/.install-credentials` (chmod 600)
gesichert. Die ausführliche, manuelle Anleitung mit allen Hintergründen steht
weiterhin unten.

---

## Stack steuern — `koroctl` (start / stop / restart / status)

Für geordnetes Hoch-/Runterfahren und einen schnellen Gesamtstatus gibt es
`deploy/koroctl.sh`. Einmalig als systemweiten Befehl hinterlegen (Symlink):

```bash
sudo chmod +x /opt/koro-api/deploy/koroctl.sh
sudo ln -sf /opt/koro-api/deploy/koroctl.sh /usr/local/bin/koroctl
```

Danach von überall:

```bash
sudo koroctl start      # geordnet hoch: Traefik → Supabase (DB-first) → edge → koro-api
sudo koroctl stop       # sanft runter: koro-api zuerst (Drain), entfernt NICHTS
sudo koroctl restart    # stop + start
sudo koroctl status     # Container, Health, Uptime, edge-Netz, DB, Commit, App-Config, Env/Branch
```

Das Script ist symlink-fest (löst seinen Repo-Pfad selbst auf) und liest
`deploy/koro-deploy.conf`, kennt also die richtigen Domains/den Branch der
Umgebung. Logbuch zusätzlich in `/var/log/koroctl.log`.

> Für **bewusstes** Stoppen immer `koroctl stop` nehmen (graceful Drain), nicht
> `docker compose down` — `down` entfernt Container und löst die manuell
> verbundene edge-Zuordnung von Kong. Ein reiner `sudo reboot` ist ok: die
> `restart: unless-stopped`-Policies fahren alles wieder hoch.

---

## Alles wieder entfernen — `deploy/uninstall.sh`

Vollständiger Teardown mit Sicherheitsabfrage (du musst `DELETE` tippen):

```bash
cd /opt/koro-api
sudo ./deploy/uninstall.sh                  # Container + Volumes + edge-Netz + koro-api-Image
sudo ./deploy/uninstall.sh --images         # zusätzlich Supabase/Traefik/Redis-Images
sudo ./deploy/uninstall.sh --purge          # zusätzlich Dateien: .env, /opt/supabase[-stack], Logs, Credentials, Conf
sudo ./deploy/uninstall.sh --purge --images --yes   # alles, ohne Rückfrage
```

⚠️ **Unwiderruflich** — löscht das Supabase-DB-Volume, Uploads und Zertifikate.
Kein Backup. (`--yes` überspringt die Rückfrage; ohne `--purge` bleiben Dateien
wie `.env` erhalten.) Kontrolle danach: `docker ps -a`, `docker volume ls`,
`docker network ls` zeigen nichts koro/supabase mehr.

> **Manuell/komplett verbastelter Host** (z. B. Alt-Server): Wenn Container mit
> Nicht-Standard-Namen übrig sind, hilft ein voller Docker-Reset —
> `docker ps -aq | xargs -r docker rm -f` und danach
> `docker system prune -a --volumes -f` (⚠️ entfernt **alles** Docker auf dem
> Host, auch Unbeteiligtes).

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

> **Redis ist selbst gehostet** — es läuft als eigener Container
> (`redis:7-alpine`, Service `redis` in `deploy/docker-compose.api.yml`) auf
> deinem Server, **keine externe Abhängigkeit**. Daten sind rein transient
> (Pub/Sub + Presence + Status-Snapshots), daher bewusst **ohne Persistenz**
> (`--appendonly no --save ""`) — bei einem Redis-Neustart bauen sich Presence
> und Status binnen Sekunden neu auf. Erreichbar nur intern im `edge`-Netz
> unter `redis://redis:6379`, nie öffentlich.

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
apt-get update && apt-get install -y git postgresql-client-16
# Hinweis: Ubuntu 24.04 (Noble) hat KEIN postgresql-client-15 mehr — Version 16
# ist korrekt (neuerer Client dumpt/restored die PG15-DB von Supabase problemlos).

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
04883bfb8a500e45aa796d57da1279492ec9bf5fa0fc30feb0b6a79e5a77f404
sdDW50UBt1qG350PP5DUhRzqWa9qj4VinGicPWPye4uFDv9RoQfqN1FgjFX3iJbX

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
SRC_DB_URL="postgresql://postgres.ykqldbndudnybrbdjsxz:Cocolino123!@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" \
DST_DB_URL="postgresql://postgres:04883bfb8a500e45aa796d57da1279492ec9bf5fa0fc30feb0b6a79e5a77f404@localhost:5432/postgres" \
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

# Passwort fürs Status-Dashboard (HTTP Basic, ein fixes Passwort, kein User-Mgmt)
STATUS_PASSWORD=koro-status-da296d00e4ca51deeab0890457876f54
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

## 4b. Nach Rückmeldung von ECSNET (Hoster-Firewall)

**Stand 03.06.2026:** Der Stack läuft serverseitig korrekt (Traefik up,
blue/green antworten lokal mit `{"ok":true}`, Supabase geroutet), aber
**ECSNET filtert upstream sämtliche neuen eingehenden TCP-Verbindungen**
(getestet: 22, 80, 443, 3001 — alles Timeout von außen, ICMP geht durch,
tcpdump auf dem Server sieht **0 SYNs** bei externem Dauerbeschuss). Lokale
Firewall ist sauber (ufw inactive, `INPUT` policy ACCEPT, nft nur
Docker-Standard). Deshalb scheitert die ACME-HTTP-01-Challenge → Self-signed-
Fallback-Zertifikat. Ticket an ECSNET ist raus.

> ⚠️ **SSH-Session offen lassen** — bestehende Verbindungen überleben den
> Filter (Conntrack), neue nicht. Fallback: Web-Konsole im ECSNET-Panel.

Sobald ECSNET freigeschaltet hat, in dieser Reihenfolge:

**1. Erreichbarkeit von außen bestätigen** (externes Netz, z. B. Handy ohne
WLAN — nicht vom Server selbst, Hairpin täuscht!):

```bash
nc -zv 212.89.161.109 80
nc -zv 212.89.161.109 443
nc -zv 212.89.161.109 3001
nc -zv 212.89.161.109 22     # wichtig! Sonst nach SSH-Logout ausgesperrt
```

**2. ACME neu anstoßen** (auf dem Server):

```bash
docker restart traefik
docker logs -f traefik 2>&1 | grep -i -E "acme|certificate|error"
```

Warten, bis **kein** `ERR Unable to obtain ACME certificate` mehr kommt
(Erfolg = einfach keine Fehler mehr; Zertifikat liegt dann in `acme.json`).

> **Let's-Encrypt-Rate-Limit:** max. 5 fehlgeschlagene Versuche/Stunde —
> erst restarten, wenn Port 80 wirklich offen ist (Schritt 1 zuerst). Bei
> „too many failed authorizations": 1 h warten, dann erneut
> `docker restart traefik`.

**3. Schritt-4-Tests abschließen** (echte Zertifikate, von außen):

```bash
curl -i https://api.koro.chat:3001/health    # -> {"ok":true}, kein Cert-Fehler
curl -i https://api.koro.chat/health         # -> {"ok":true}
curl -i https://db.koro.chat/rest/v1/        # -> Supabase, kein Cert-Fehler
```

**4. Stack-Gesundheit prüfen:**

```bash
cd /opt/koro-api
docker compose -f deploy/docker-compose.api.yml ps        # blue + green "healthy"?
docker logs koro-api-blue  2>&1 | grep ws-bus             # "[ws-bus] subscribed (instance=blue)"
docker logs koro-api-green 2>&1 | grep ws-bus             # dito green
```

Erst wenn alles grün ist → weiter mit Schritt 5.

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

## 6. Status-Dashboard

Erreichbar unter **`https://api.koro.chat:3001/status`** (und `…/status` auf
443). Ein **fixes Passwort** via HTTP Basic — beim Aufruf fragt der Browser
einen Login ab; **Username egal**, nur das Passwort zählt:

```
Passwort:  koro-status-da296d00e4ca51deeab0890457876f54
```

> Steht als `STATUS_PASSWORD` in der `.env` (Schritt 3). Ist es nicht gesetzt,
> ist `/status` deaktiviert (503) — nie offen. Zum Ändern: `.env` anpassen +
> `./deploy/deploy.sh` (oder beide Instanzen neu starten).

Das Dashboard (auto-refresh alle 5 s) zeigt **alles auf einen Blick**:

- **API-Instanzen blue + green** — online/offline, Uptime, laufender Commit,
  Speicher (RSS/Heap), Prozess-CPU, **Event-Loop-Lag** (x̄/p99/max), WS-Sockets
  & -Devices, Peer-Instanzen, aktive Handles, letzter Heartbeat.
- **Redis** — Ping-Latenz, Version, Clients, Speicher, Ops/s, Befehle gesamt,
  Uptime.
- **Datenbank** — Erreichbarkeit + Latenz + geschätzte Zeilenzahlen (users,
  conversations, messages, devices, meetings).
- **Host-Auslastung** — CPU % (alle Cores), RAM, Load (1/5/15), **Disk-Belegung
  des `uploads`-Volumes**, Host-Uptime.
- **Event-/Restart-Log** — boot / shutdown / deploy-Events (Restart-Historie).
- **Git-/Deploy-Historie** — letzte 30 Commits (aus dem read-only gemounteten
  `.git`) + jeder Deploy als Event.

Technik: jede Instanz schreibt ihren Snapshot alle 5 s nach Redis (TTL 15 s);
die bedienende Instanz liest alle Snapshots zurück und aggregiert. Damit die
Commit-Historie sichtbar ist, mountet `docker-compose.api.yml` das Repo-`.git`
read-only nach `/repo/.git` und `deploy.sh` stempelt den laufenden Commit per
Build-Arg ins Image (so siehst du auch **Drift**: laufender vs. neuester Commit).

JSON-Rohdaten (z. B. für eigenes Monitoring): `GET /status/data` (gleiches
Passwort).

---

## 7. Neue Services hinzufügen — ohne Restart der laufenden

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

## 8. Cutover-Reihenfolge (alt → neu, ohne Datenverlust-Risiko)

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
| Status-Dashboard | `https://api.koro.chat:3001/status` (Passwort s. Abschnitt 6) |

---

## Troubleshooting

- **Call klingelt cross-device nicht** → Redis prüfen: `docker logs koro-redis`,
  und in den API-Logs muss `[ws-bus] subscribed (instance=blue/green)` stehen.
- **Deploy bricht ab „not healthy"** → `docker logs --tail 50 koro-api-blue`;
  meist `.env`/Supabase-Erreichbarkeit (`http://supabase-kong:8000`).
- **Kein Zertifikat** → Port 80 offen? DNS korrekt? `traefik`-Logs ansehen.
- **`db.koro.chat` 404** → liegt `supabase.override.yml` als
  `docker-compose.override.yml` im Supabase-Ordner und ist Kong am `edge`-Netz?
