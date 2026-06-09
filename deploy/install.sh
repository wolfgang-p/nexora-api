#!/usr/bin/env bash
# =============================================================================
#  koro-api — Vollständiges One-Shot Server-Setup
# =============================================================================
#  Führt ALLE Schritte aus deploy/DEPLOYMENT.md hintereinander aus:
#
#    0. Server vorbereiten   (Docker, git, postgresql-client-16, edge-Netz)
#    1. Traefik starten      (Reverse Proxy + Let's-Encrypt)
#    2. Supabase selbst hosten (Secrets generieren, .env, Override, up -d)
#    3. DB-Schema migrieren  (migrations/0001 … 0025 nacheinander)
#    4. koro-api .env bauen  (Supabase-Werte automatisch, Rest abgefragt)
#    5. koro-api starten     (blue + green + redis, mit Build)
#
#  Aufruf (als root, im geklonten Repo, z. B. /opt/koro-api):
#      sudo ./deploy/install.sh
#
#  Idempotent genug für einen frischen Server. Paket-Lograuschen wird in eine
#  Logdatei umgeleitet — auf dem Bildschirm erscheinen nur Status, Warnungen
#  und Fehler.
# =============================================================================
set -euo pipefail

# ── Domains (müssen zu den Labels in den Compose-Files passen) ───────────────
API_DOMAIN="api.koro.chat"
DB_DOMAIN="db.koro.chat"
STUDIO_DOMAIN="studio.koro.chat"

# ── Pfade ───────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPABASE_SRC="/opt/supabase"
SUPABASE_STACK="/opt/supabase-stack"
KORO_ENV="$REPO_DIR/.env"
CRED_FILE="$REPO_DIR/deploy/.install-credentials"
TS="$(date '+%Y%m%d-%H%M%S')"
LOGFILE="/var/log/koro-install-$TS.log"

# ── Farben / Logging ─────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

STEP_NO=0
step()  { STEP_NO=$((STEP_NO+1)); printf '\n%s\n%s  SCHRITT %s — %s%s\n%s\n' \
            "${C_BOLD}${C_BLUE}════════════════════════════════════════════════════════════════════════" \
            "" "$STEP_NO" "$1" "" \
            "════════════════════════════════════════════════════════════════════════${C_RESET}"; }
info()  { printf '  %s•%s %s\n' "${C_CYAN}" "${C_RESET}" "$*"; }
ok()    { printf '  %s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn()  { printf '  %s! %s%s\n' "${C_YELLOW}" "$*" "${C_RESET}"; }
err()   { printf '  %s✗ %s%s\n' "${C_RED}" "$*" "${C_RESET}"; }

# run "Beschreibung" cmd args…  → Ausgabe nur ins Log, am Schirm nur ✓/✗
run() {
  local desc="$1"; shift
  printf '  %s→ %s …%s\n' "${C_DIM}" "$desc" "${C_RESET}"
  if "$@" >>"$LOGFILE" 2>&1; then
    printf '\033[1A\033[2K  %s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$desc"
  else
    printf '\033[1A\033[2K  %s✗ %s%s\n' "${C_RED}" "$desc" "${C_RESET}"
    err "Details siehe $LOGFILE"
    return 1
  fi
}
# Wie run, aber für shell-Pipelines/Builtins
run_sh() { local desc="$1"; shift; run "$desc" bash -c "$*"; }

on_error() {
  local line="$1"
  printf '\n%s════════════════════════════════════════════════════════════════════════%s\n' "${C_RED}" "${C_RESET}"
  err "Abbruch in Zeile $line. Letzte Ausgaben im Log:"
  tail -n 25 "$LOGFILE" 2>/dev/null | sed 's/^/      /' || true
  printf '%s════════════════════════════════════════════════════════════════════════%s\n' "${C_RED}" "${C_RESET}"
  exit 1
}
trap 'on_error $LINENO' ERR

# ── Hilfsfunktionen ──────────────────────────────────────────────────────────

# Sicheres Setzen von KEY=VALUE in einer .env (special chars safe, kein sed)
set_env() {
  local file="$1" key="$2" val="$3"
  [ -f "$file" ] || : >"$file"
  if grep -qE "^${key}=" "$file"; then
    grep -vE "^${key}=" "$file" >"$file.tmp" && mv "$file.tmp" "$file"
  fi
  printf '%s=%s\n' "$key" "$val" >>"$file"
}

# base64url ohne Padding (von stdin)
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Supabase HS256-JWT (anon / service_role) mit gegebenem Secret signieren
gen_supabase_jwt() {
  local role="$1" secret="$2" iat exp h p signing sig
  iat="$(date +%s)"; exp=$((iat + 315360000))   # +10 Jahre
  h="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
  p="$(printf '%s' "{\"role\":\"${role}\",\"iss\":\"supabase\",\"iat\":${iat},\"exp\":${exp}}" | b64url)"
  signing="${h}.${p}"
  sig="$(printf '%s' "$signing" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)"
  printf '%s.%s' "$signing" "$sig"
}

# Interaktive Abfrage. Prompts → stderr, Wert → stdout (für $(ask …)).
# Eingabe ist sichtbar (Server-Konsole, eigene Maschine) — das vermeidet das
# "ich kann nichts tippen"-Gefühl bei versteckten Feldern. Liest robust von
# /dev/tty und bricht bei EOF nicht das ganze Script ab.
ask() {
  local key="$1" desc="$2" val=""
  {
    printf '\n  %s%s%s\n' "${C_CYAN}${C_BOLD}" "$key" "${C_RESET}"
    printf '  %s%s%s\n' "${C_DIM}" "$desc" "${C_RESET}"
    printf '  %s(Enter = überspringen / leer lassen)%s\n' "${C_DIM}" "${C_RESET}"
  } >&2
  read -r -p "  > " val </dev/tty || val=""
  printf '%s' "$val"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "Bitte als root ausführen:  sudo ./deploy/install.sh"
    exit 1
  fi
}

# Garantiert, dass ein Container am `edge`-Netz hängt. Der Supabase-Override
# SOLL Kong ans edge-Netz hängen, aber der networks-Merge ist je nach
# Compose-Version unzuverlässig. koro-api erreicht Supabase aber NUR über edge
# (http://supabase-kong:8000) — darum hier deterministisch nachziehen.
ensure_on_edge() {
  local cname="$1"
  docker inspect "$cname" >/dev/null 2>&1 || return 0   # Container existiert nicht (z.B. Studio aus)
  if docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cname" 2>/dev/null | grep -qw edge; then
    ok "$cname ist bereits am edge-Netz"
  elif docker network connect edge "$cname" >>"$LOGFILE" 2>&1; then
    ok "$cname ans edge-Netz gehängt"
  else
    warn "$cname konnte nicht ans edge-Netz gehängt werden — siehe $LOGFILE"
  fi
}

# =============================================================================
#  Start
# =============================================================================
require_root
: >"$LOGFILE" || { LOGFILE="$REPO_DIR/koro-install-$TS.log"; : >"$LOGFILE"; }

printf '%s\n' "${C_BOLD}${C_BLUE}"
cat <<'BANNER'
   _                                  _
  | | _____  _ __ ___        __ _ _ __(_)
  | |/ / _ \| '__/ _ \      / _` | '_ \ |
  |   < (_) | | | (_) |    | (_| | |_) | |
  |_|\_\___/|_|  \___/      \__,_| .__/|_|
                                 |_|   vollautomatisches Deployment
BANNER
printf '%s' "${C_RESET}"
info "Repo:        $REPO_DIR"
info "Logdatei:    $LOGFILE  ${C_DIM}(Paket-/Build-Rauschen landet hier)${C_RESET}"
info "Domains:     $API_DOMAIN · $DB_DOMAIN · $STUDIO_DOMAIN"

# =============================================================================
step "Server vorbereiten (Docker, git, psql-Client, edge-Netz)"
# =============================================================================
export DEBIAN_FRONTEND=noninteractive

if command -v docker >/dev/null 2>&1; then
  ok "Docker bereits installiert ($(docker --version | awk '{print $3}' | tr -d ','))"
else
  run "Docker installieren (get.docker.com)" bash -c 'curl -fsSL https://get.docker.com | sh'
  ok "Docker installiert"
fi

if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose v2 vorhanden ($(docker compose version --short 2>/dev/null || echo ok))"
else
  err "Docker Compose v2 fehlt — bitte Docker-Installation prüfen."
  exit 1
fi

run "Paketindex aktualisieren" apt-get update
run "git installieren" apt-get install -y git
# psql-Client ist OPTIONAL: die Migrationen laufen via `docker exec supabase-db psql`.
# Paketname variiert je nach Ubuntu-Release (24.04→16, 25.04→17), darum mit
# Fallbacks und ohne harten Abbruch.
if apt-get install -y postgresql-client-16 >>"$LOGFILE" 2>&1 \
   || apt-get install -y postgresql-client-17 >>"$LOGFILE" 2>&1 \
   || apt-get install -y postgresql-client    >>"$LOGFILE" 2>&1; then
  ok "git + postgresql-client installiert"
else
  warn "postgresql-client nicht installierbar — unkritisch, Migrationen laufen via docker exec."
  ok "git installiert"
fi

run "Verzeichnis /opt/koro-api vorbereiten" mkdir -p /opt/koro-api

if docker network inspect edge >/dev/null 2>&1; then
  ok "Docker-Netzwerk 'edge' existiert bereits"
else
  run "Docker-Netzwerk 'edge' anlegen" docker network create edge
  ok "Netzwerk 'edge' angelegt"
fi

warn "DNS-Check: $API_DOMAIN / $DB_DOMAIN müssen auf diese Server-IP zeigen,"
warn "und Port 80 muss öffentlich erreichbar sein (Let's-Encrypt HTTP-01)."

# =============================================================================
step "Traefik starten (Reverse Proxy + TLS/ACME)"
# =============================================================================
run "Traefik (proxy-Stack) starten" \
    docker compose -f "$REPO_DIR/deploy/docker-compose.proxy.yml" up -d
ok "Traefik läuft — holt Zertifikate automatisch, sobald Port 80 offen ist"

# =============================================================================
step "Supabase selbst hosten"
# =============================================================================
if [ -d "$SUPABASE_STACK" ] && [ -f "$SUPABASE_STACK/.env" ]; then
  warn "Supabase-Stack existiert bereits unter $SUPABASE_STACK — überspringe Klonen/Secrets."
  warn "Lese vorhandene Secrets aus $SUPABASE_STACK/.env."
  POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$SUPABASE_STACK/.env" | head -1 | cut -d= -f2-)"
  SB_JWT_SECRET="$(grep -E '^JWT_SECRET=' "$SUPABASE_STACK/.env" | head -1 | cut -d= -f2-)"
  ANON_KEY="$(grep -E '^ANON_KEY=' "$SUPABASE_STACK/.env" | head -1 | cut -d= -f2-)"
  SERVICE_ROLE_KEY="$(grep -E '^SERVICE_ROLE_KEY=' "$SUPABASE_STACK/.env" | head -1 | cut -d= -f2-)"
  DASHBOARD_PASSWORD="$(grep -E '^DASHBOARD_PASSWORD=' "$SUPABASE_STACK/.env" | head -1 | cut -d= -f2-)"
else
  if [ ! -d "$SUPABASE_SRC" ]; then
    run "Supabase-Repo klonen (--depth 1)" \
        git clone --depth 1 https://github.com/supabase/supabase "$SUPABASE_SRC"
  else
    ok "Supabase-Repo bereits vorhanden ($SUPABASE_SRC)"
  fi
  run "Docker-Verzeichnis nach $SUPABASE_STACK kopieren" \
      bash -c "rm -rf '$SUPABASE_STACK' && cp -r '$SUPABASE_SRC/docker' '$SUPABASE_STACK'"
  run "Supabase .env aus Vorlage erstellen" \
      cp "$SUPABASE_STACK/.env.example" "$SUPABASE_STACK/.env"

  info "Secrets generieren …"
  POSTGRES_PASSWORD="$(openssl rand -hex 32)"
  SB_JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  DASHBOARD_PASSWORD="$(openssl rand -hex 16)"
  SECRET_KEY_BASE="$(openssl rand -hex 32)"
  VAULT_ENC_KEY="$(openssl rand -hex 16)"          # 32 Zeichen
  LOGFLARE_PUB="$(openssl rand -hex 16)"
  LOGFLARE_PRIV="$(openssl rand -hex 16)"
  ANON_KEY="$(gen_supabase_jwt anon "$SB_JWT_SECRET")"
  SERVICE_ROLE_KEY="$(gen_supabase_jwt service_role "$SB_JWT_SECRET")"
  ok "ANON_KEY + SERVICE_ROLE_KEY aus JWT_SECRET signiert"

  SB="$SUPABASE_STACK/.env"
  set_env "$SB" POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
  set_env "$SB" JWT_SECRET "$SB_JWT_SECRET"
  set_env "$SB" ANON_KEY "$ANON_KEY"
  set_env "$SB" SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"
  set_env "$SB" DASHBOARD_USERNAME "admin"
  set_env "$SB" DASHBOARD_PASSWORD "$DASHBOARD_PASSWORD"
  set_env "$SB" SECRET_KEY_BASE "$SECRET_KEY_BASE"
  set_env "$SB" VAULT_ENC_KEY "$VAULT_ENC_KEY"
  set_env "$SB" LOGFLARE_PUBLIC_ACCESS_TOKEN "$LOGFLARE_PUB"
  set_env "$SB" LOGFLARE_PRIVATE_ACCESS_TOKEN "$LOGFLARE_PRIV"
  set_env "$SB" LOGFLARE_API_KEY "$LOGFLARE_PRIV"
  set_env "$SB" POOLER_TENANT_ID "koro"
  set_env "$SB" SITE_URL "https://koro.chat"
  set_env "$SB" API_EXTERNAL_URL "https://$DB_DOMAIN"
  set_env "$SB" SUPABASE_PUBLIC_URL "https://$DB_DOMAIN"
  ok "Supabase .env konfiguriert"

  # Override: Kong ans edge-Netz + Route db.koro.chat (+ optional Studio)
  run "Compose-Override einspielen" \
      cp "$REPO_DIR/deploy/supabase.override.yml" "$SUPABASE_STACK/docker-compose.override.yml"

  # Echten htpasswd-Hash für Studio erzeugen (ersetzt den Platzhalter im Override).
  # Robust per Python (korrektes $-Escaping für Compose), nicht per sed.
  OVERRIDE="$SUPABASE_STACK/docker-compose.override.yml"
  if HTPASSWD="$(docker run --rm httpd:alpine htpasswd -nbB admin "$DASHBOARD_PASSWORD" 2>>"$LOGFILE")" \
     && command -v python3 >/dev/null 2>&1; then
    if HASH_FULL="${HTPASSWD#admin:}" \
       python3 - "$OVERRIDE" <<'PY' 2>>"$LOGFILE"; then
import os, sys
path = sys.argv[1]
full = os.environ["HASH_FULL"].strip()        # z.B.  $2y$05$....
esc  = full.replace("$", "$$")                # Compose escaped jedes $ als $$
data = open(path).read()
data = data.replace("$$2y$$05$$REPLACE_WITH_HTPASSWD_HASH", esc)
open(path, "w").write(data)
PY
      ok "Studio-BasicAuth gesetzt (admin / DASHBOARD_PASSWORD)"
    else
      warn "Studio-Hash konnte nicht eingetragen werden — Studio-Auth bleibt Platzhalter (401)."
    fi
  else
    warn "htpasswd-Hash nicht erzeugbar — Studio-Auth bleibt Platzhalter (401, ungefährlich)."
  fi
fi

# WICHTIG: Override explizit per -f laden. Das Auto-Mergen von
# docker-compose.override.yml greift NICHT zuverlässig (z. B. wenn COMPOSE_FILE
# in der Supabase-.env gesetzt ist) — dann fehlen Kong/Studio die Traefik-Labels
# und das edge-Netz. Mit explizitem -f ist der Override garantiert aktiv.
SB_COMPOSE="docker compose -f docker-compose.yml -f docker-compose.override.yml"
if [ ! -f "$SUPABASE_STACK/docker-compose.override.yml" ]; then
  SB_COMPOSE="docker compose"   # Fallback, falls (warum auch immer) kein Override da ist
fi
run_sh "Supabase-Stack starten (mit Override)" \
    "cd '$SUPABASE_STACK' && $SB_COMPOSE up -d"
ok "Supabase-Container gestartet"

# Kong (Pflicht) + Studio (optional) deterministisch ans edge-Netz hängen,
# damit koro-api Supabase intern unter http://supabase-kong:8000 auflöst.
ensure_on_edge supabase-kong
ensure_on_edge supabase-studio

info "Warte auf Postgres (supabase-db) …"
WAITED=0
until docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1; do
  sleep 2; WAITED=$((WAITED+2))
  if [ "$WAITED" -ge 180 ]; then
    err "Postgres wurde nach 180s nicht bereit."
    docker logs --tail 40 supabase-db >>"$LOGFILE" 2>&1 || true
    exit 1
  fi
done
ok "Postgres ist bereit (nach ${WAITED}s)"

# =============================================================================
step "DB-Schema migrieren — migrations/0001 … 0025 nacheinander"
# =============================================================================
shopt -s nullglob
MIGRATIONS=( "$REPO_DIR"/migrations/0[0-9][0-9][0-9]_*.sql )
shopt -u nullglob
IFS=$'\n' MIGRATIONS=($(sort <<<"${MIGRATIONS[*]}")); unset IFS

# Einzelne Migrationen überspringen (Leerzeichen-getrennt, per ENV override-bar).
# 0002 hat auf einer frischen DB einen Reihenfolge-Bug (legt das `koro`-Schema
# erst NACH der ersten Funktion an). RLS ist zudem optional, da koro-api den
# service_role-Key nutzt (umgeht RLS) und Clients über das Backend gehen, nie
# direkt an PostgREST.  Überschreiben:  SKIP_MIGRATIONS="" ./deploy/install.sh
SKIP_MIGRATIONS="${SKIP_MIGRATIONS-0002_rls_policies.sql}"

info "${#MIGRATIONS[@]} Migrationsdateien gefunden"
if [ -n "$SKIP_MIGRATIONS" ]; then warn "Wird übersprungen: $SKIP_MIGRATIONS"; fi
APPLIED=0; SKIPPED=0; FAILED=0; FAILS=""
for f in "${MIGRATIONS[@]}"; do
  name="$(basename "$f")"
  if [[ " $SKIP_MIGRATIONS " == *" $name "* ]]; then
    printf '  %s↷ %s (übersprungen)%s\n' "${C_YELLOW}" "$name" "${C_RESET}"
    SKIPPED=$((SKIPPED+1)); continue
  fi
  printf '  %s→ %s …%s\n' "${C_DIM}" "$name" "${C_RESET}"
  if docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db \
        psql -v ON_ERROR_STOP=1 -U postgres -d postgres -q <"$f" >>"$LOGFILE" 2>&1; then
    printf '\033[1A\033[2K  %s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$name"
    APPLIED=$((APPLIED+1))
  else
    # Nicht hart abbrechen: bei Re-Runs sind Objekte ggf. schon da ("already
    # exists"). Fehler werden gesammelt und am Ende gemeldet.
    printf '\033[1A\033[2K  %s! %s (Fehler — übersprungen, siehe Log)%s\n' "${C_YELLOW}" "$name" "${C_RESET}"
    FAILED=$((FAILED+1)); FAILS="$FAILS $name"
  fi
done
ok "Migrationen: $APPLIED angewendet, $SKIPPED übersprungen, $FAILED fehlgeschlagen"
if [ "$FAILED" -gt 0 ]; then warn "Fehlgeschlagen:$FAILS — Details im Log ($LOGFILE)"; fi

run_sh "PostgREST-Schema-Cache neu laden" \
    "docker exec -e PGPASSWORD='$POSTGRES_PASSWORD' supabase-db psql -U postgres -d postgres -c \"NOTIFY pgrst, 'reload schema';\""
ok "Schema-Cache neu geladen"

# =============================================================================
step "koro-api .env bauen (Supabase automatisch, Rest abgefragt)"
# =============================================================================
if [ -f "$KORO_ENV" ]; then
  cp "$KORO_ENV" "$KORO_ENV.bak-$TS"
  warn "Vorhandene .env gesichert als .env.bak-$TS — wird neu geschrieben."
fi

info "Generiere koro-eigene Secrets (JWT_SECRET, STATUS_PASSWORD) automatisch."
KORO_JWT_SECRET="$(openssl rand -base64 64 | tr -d '\n')"
STATUS_PASSWORD="koro-status-$(openssl rand -hex 16)"

printf '\n  %sJetzt werden die restlichen Werte abgefragt (aus deploy/.env.example).%s\n' "${C_BOLD}" "${C_RESET}"
printf '  %sAlle sind optional — einfach Enter drücken, um sie leer zu lassen.%s\n' "${C_DIM}" "${C_RESET}"

TWILIO_ACCOUNT_SID="$(ask TWILIO_ACCOUNT_SID 'Twilio Account SID (SMS-OTP-Versand)')"
TWILIO_AUTH_TOKEN="$(ask TWILIO_AUTH_TOKEN 'Twilio Auth Token' secret)"
TWILIO_FROM="$(ask TWILIO_FROM 'Twilio Absendernummer oder Alpha-Sender-ID')"
EXPO_ACCESS_TOKEN="$(ask EXPO_ACCESS_TOKEN 'Expo Access Token für Push (optional, höheres Rate-Limit)' secret)"
OPENAI_API_KEY="$(ask OPENAI_API_KEY 'OpenAI API Key (KI-Features, AI_PROVIDER=openai)' secret)"
TURN_TOKEN="$(ask TURN_TOKEN 'TURN-Token (WebRTC Relay-Credentials)' secret)"
TURN_KEY_ID="$(ask TURN_KEY_ID 'TURN Key-ID')"

info "Schreibe $KORO_ENV …"
cat >"$KORO_ENV" <<EOF
# Generiert von deploy/install.sh am $TS — NICHT committen.

# ── Server ───────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3001
CORS_ORIGINS=https://koro.chat,https://crm.koro.chat,https://$API_DOMAIN,https://web.koro.chat,https://nexoro.net,https://*.nexoro.net

# ── Supabase (automatisch eingetragen) ───────────────────────────────
SUPABASE_URL=http://supabase-kong:8000
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
SUPABASE_ANON_KEY=$ANON_KEY

# ── Auth ─────────────────────────────────────────────────────────────
JWT_SECRET=$KORO_JWT_SECRET
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=2592000

# ── OTP / SMS ────────────────────────────────────────────────────────
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN=$TWILIO_AUTH_TOKEN
TWILIO_FROM=$TWILIO_FROM
TWILIO_STATUS_CALLBACK=https://$API_DOMAIN/sms/twilio-status

# ── Media ────────────────────────────────────────────────────────────
MEDIA_BUCKET=koro-media

# ── Push ─────────────────────────────────────────────────────────────
EXPO_ACCESS_TOKEN=$EXPO_ACCESS_TOKEN

# ── Bot-Device für History-Sync ──────────────────────────────────────
BOT_DEVICE_ID=5f5aa645-8912-4ebe-9452-e58b427a6f8a
BOT_DEVICE_PRIVATE_KEY="3d87iatPzCpvjea28BBQnW3O1lb9NzAP77bjgJm3Ssw="

# ── KI ───────────────────────────────────────────────────────────────
AI_PROVIDER=openai
OPENAI_API_KEY=$OPENAI_API_KEY
OPENAI_MODEL=gpt-4o-mini

# ── WebRTC TURN ──────────────────────────────────────────────────────
TURN_TOKEN=$TURN_TOKEN
TURN_KEY_ID=$TURN_KEY_ID

# ── Status-Dashboard (HTTP Basic, Passwort) ──────────────────────────
STATUS_PASSWORD=$STATUS_PASSWORD
EOF
chmod 600 "$KORO_ENV"
ok ".env geschrieben (REDIS_URL/INSTANCE_ID/CERT_DIR/DRAIN_DELAY_MS kommen aus dem Compose-File)"

# =============================================================================
step "koro-api starten (blue + green + redis, mit Build)"
# =============================================================================
# blue + green teilen sich dasselbe Image (koro-api:latest). Darum NUR EINMAL
# bauen (über einen Service) — sonst exportieren beide parallel auf denselben
# Tag und der containerd/buildx-Exporter scheitert mit:
#   image "…/koro-api:latest": already exists
run_sh "Image bauen (einmalig, koro-api:latest)" \
    "cd '$REPO_DIR' && docker compose -f deploy/docker-compose.api.yml build api-blue"
run_sh "Stack starten (blue + green + redis)" \
    "cd '$REPO_DIR' && docker compose -f deploy/docker-compose.api.yml up -d"
ok "Build & Start abgeschlossen"

info "Warte bis blue + green 'healthy' sind …"
wait_healthy() {
  local cname="$1" waited=0 status
  while true; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cname" 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] && { ok "$cname healthy"; return 0; }
    [ "$status" = "none" ]    && { warn "$cname hat keinen Healthcheck — überspringe Warten."; return 0; }
    if [ "$waited" -ge 120 ]; then
      warn "$cname nach 120s nicht healthy (status=$status). Logs:"
      docker logs --tail 30 "$cname" 2>&1 | sed 's/^/      /' || true
      return 0
    fi
    sleep 3; waited=$((waited+3))
  done
}
wait_healthy koro-api-blue
wait_healthy koro-api-green

# =============================================================================
#  Zusammenfassung + Credentials sichern
# =============================================================================
cat >"$CRED_FILE" <<EOF
# koro-api Installations-Credentials — generiert am $TS
# STRENG VERTRAULICH. Sicher aufbewahren, dann ggf. löschen.

[Supabase]
POSTGRES_PASSWORD   = $POSTGRES_PASSWORD
JWT_SECRET          = $SB_JWT_SECRET
ANON_KEY            = $ANON_KEY
SERVICE_ROLE_KEY    = $SERVICE_ROLE_KEY
Studio-URL          = https://$STUDIO_DOMAIN
Studio-Login        = admin / $DASHBOARD_PASSWORD

[koro-api]
JWT_SECRET          = $KORO_JWT_SECRET
STATUS_PASSWORD     = $STATUS_PASSWORD
Status-Dashboard    = https://$API_DOMAIN:3001/status
EOF
chmod 600 "$CRED_FILE"

printf '\n%s\n' "${C_BOLD}${C_GREEN}════════════════════════════════════════════════════════════════════════"
printf '  ✓ FERTIG — koro-api Stack ist hochgefahren%s\n' "${C_RESET}"
printf '%s════════════════════════════════════════════════════════════════════════%s\n' "${C_BOLD}${C_GREEN}" "${C_RESET}"
info "Container-Status:"
docker compose -f "$REPO_DIR/deploy/docker-compose.api.yml" ps 2>/dev/null | sed 's/^/      /' || true
printf '\n'
ok "Credentials gesichert in: $CRED_FILE  (chmod 600)"
ok "Status-Dashboard:  https://$API_DOMAIN:3001/status   (Passwort siehe Credentials)"
ok "Supabase Studio:   https://$STUDIO_DOMAIN              (admin / DASHBOARD_PASSWORD)"
printf '\n  %sNächste Tests, sobald DNS + Port 80/443 von außen offen sind:%s\n' "${C_BOLD}" "${C_RESET}"
printf '      curl -i https://%s:3001/health   # -> {"ok":true}\n' "$API_DOMAIN"
printf '      curl -i https://%s/health\n' "$API_DOMAIN"
printf '      curl -i https://%s/rest/v1/\n' "$DB_DOMAIN"
printf '\n  %sZertifikate: %sdocker logs -f traefik 2>&1 | grep -iE "acme|certificate|error"%s\n' "${C_DIM}" "${C_RESET}${C_DIM}" "${C_RESET}"
printf '  %sZero-Downtime-Deploys später per Cron: %s./deploy/deploy.sh%s\n\n' "${C_DIM}" "${C_RESET}${C_DIM}" "${C_RESET}"
