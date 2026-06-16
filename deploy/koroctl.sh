#!/usr/bin/env bash
# =============================================================================
#  koroctl — kontrolliertes Hoch-/Runterfahren des koro-api-Stacks
# =============================================================================
#  Sauberes, geordnetes Start/Stop/Restart + ausführlicher Status — mit
#  Zeitstempeln, damit nachvollziehbar ist, WAS WANN passiert.
#
#    koroctl start     Traefik → Supabase (DB-first, warten bis healthy) →
#                      Kong/Studio ans edge-Netz → koro-api (blue+green)
#    koroctl stop      koro-api zuerst (graceful Drain) → Supabase → Traefik
#                      (entfernt NICHTS — Container/Volumes bleiben)
#    koroctl restart   stop, dann start
#    koroctl status    Container, Health, Uptime, edge-Netz, DB, Commit, App-Config
#
#  Aufruf:  sudo ./deploy/koroctl.sh <start|stop|restart|status>
#  Logbuch: zusätzlich nach /var/log/koroctl.log
# =============================================================================
set -uo pipefail   # bewusst KEIN -e: best-effort, Status soll nie abbrechen

# ── Pfade ────────────────────────────────────────────────────────────────────
# Symlink-fest: echten Pfad auflösen, damit der Repo-Pfad auch stimmt, wenn das
# Script als /usr/local/bin/koroctl verlinkt aufgerufen wird.
SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
REPO_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
SUPABASE_STACK="/opt/supabase-stack"
CTL_LOG="/var/log/koroctl.log"

# ── Environment-Konfig (von install.sh geschrieben) ──────────────────────────
# Liefert KORO_ENV + DEPLOY_BRANCH + API_HOST/DB_HOST/STUDIO_HOST. set -a sorgt
# dafür, dass die Vars exportiert werden -> ${API_HOST}-Interpolation greift.
CONF="$REPO_DIR/deploy/koro-deploy.conf"
if [ -f "$CONF" ]; then set -a; . "$CONF"; set +a; fi
: "${KORO_ENV:=production}"
: "${API_HOST:=api.koro.chat}"; : "${DB_HOST:=db.koro.chat}"; : "${STUDIO_HOST:=studio.koro.chat}"
export API_HOST DB_HOST STUDIO_HOST
API_DOMAIN="$API_HOST"; DB_DOMAIN="$DB_HOST"; STUDIO_DOMAIN="$STUDIO_HOST"

API_COMPOSE="docker compose -f $REPO_DIR/deploy/docker-compose.api.yml"
PROXY_COMPOSE="docker compose -f $REPO_DIR/deploy/docker-compose.proxy.yml"
SB_COMPOSE="docker compose -f docker-compose.yml -f docker-compose.override.yml"
[ -f "$SUPABASE_STACK/docker-compose.override.yml" ] || SB_COMPOSE="docker compose"

# ── Farben / Logging mit Zeitstempel ─────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi
now() { date '+%Y-%m-%d %H:%M:%S'; }
# jede Zeile bekommt Zeitstempel und geht zusätzlich ins Logbuch
say()  { printf '%s%s%s  %s\n' "${C_DIM}" "$(now)" "${C_RESET}" "$*"; printf '%s  %s\n' "$(now)" "$(printf '%s' "$*" | sed 's/\x1b\[[0-9;]*m//g')" >>"$CTL_LOG" 2>/dev/null; }
info() { say "${C_CYAN}•${C_RESET} $*"; }
ok()   { say "${C_GREEN}✓${C_RESET} $*"; }
warn() { say "${C_YELLOW}!${C_RESET} $*"; }
err()  { say "${C_RED}✗${C_RESET} $*"; }
phase(){ printf '\n%s%s  ── %s ──%s\n' "${C_BOLD}${C_BLUE}" "$(now)" "$*" "${C_RESET}"; printf '%s  ── %s ──\n' "$(now)" "$*" >>"$CTL_LOG" 2>/dev/null; }

require_root() { [ "$(id -u)" -eq 0 ] || { err "Bitte als root:  sudo ./deploy/koroctl.sh $*"; exit 1; }; }

# ── Helfer ───────────────────────────────────────────────────────────────────
health_of() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo missing; }
state_of()  { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo missing; }
uptime_of() { docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null | cut -dT -f2 | cut -d. -f1 || echo "-"; }

ensure_edge_network() {
  if docker network inspect edge >/dev/null 2>&1; then
    info "edge-Netz vorhanden"
  else
    docker network create edge >/dev/null 2>&1 && ok "edge-Netz angelegt" || err "edge-Netz konnte nicht angelegt werden"
  fi
}

ensure_on_edge() {
  local c="$1"
  docker inspect "$c" >/dev/null 2>&1 || { info "$c existiert nicht — überspringe edge-Check"; return 0; }
  if docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$c" 2>/dev/null | grep -qw edge; then
    info "$c hängt am edge-Netz"
  else
    docker network connect edge "$c" >/dev/null 2>&1 && ok "$c ans edge-Netz gehängt" || warn "$c: edge-connect fehlgeschlagen"
  fi
}

wait_db_healthy() {
  info "warte auf Postgres (supabase-db) bis healthy — Erst-Init kann auf langsamer Disk dauern …"
  local w=0 s
  while true; do
    s="$(health_of supabase-db)"
    [ "$s" = "healthy" ] && { ok "supabase-db healthy (nach ${w}s)"; return 0; }
    if [ "$s" = "none" ] && docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1; then
      sleep 4; docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1 && { ok "supabase-db bereit (nach ${w}s)"; return 0; }
    fi
    if [ "$w" -ge 300 ]; then warn "supabase-db nach 300s nicht healthy (status=$s) — fahre trotzdem fort"; return 1; fi
    [ $((w % 15)) -eq 0 ] && [ "$w" -gt 0 ] && info "  … noch nicht gesund (status=$s, ${w}s vergangen)"
    sleep 3; w=$((w+3))
  done
}

wait_kong_up() {
  # Kong hängt in Supabase an "analytics (healthy)". Kommt es beim ersten up -d
  # nicht hoch, ist meist analytics noch nicht gesund -> up -d gezielt
  # wiederholen, bis Kong läuft (statt es unbemerkt "exited" zu lassen).
  local attempt=0 max=6 st
  while [ "$attempt" -lt "$max" ]; do
    st="$(state_of supabase-kong)"
    [ "$st" = "running" ] && { ok "supabase-kong läuft"; return 0; }
    info "supabase-kong noch nicht oben (status=$st) — erneuter up -d (Versuch $((attempt+1))/$max, wartet auf analytics) …"
    ( cd "$SUPABASE_STACK" && $SB_COMPOSE up -d ) >>"$CTL_LOG" 2>&1
    sleep 10; attempt=$((attempt+1))
  done
  st="$(state_of supabase-kong)"
  [ "$st" = "running" ] && { ok "supabase-kong läuft"; return 0; }
  err "supabase-kong kam nach $max Versuchen nicht hoch (status=$st). Letzte Logs:"
  docker logs --tail 20 supabase-kong 2>&1 | sed 's/^/      /'
  return 1
}

wait_api_healthy() {
  local c="$1" w=0 s
  info "warte bis $c healthy …"
  while true; do
    s="$(health_of "$c")"
    [ "$s" = "healthy" ] && { ok "$c healthy (nach ${w}s)"; return 0; }
    [ "$s" = "none" ]    && { warn "$c hat keinen Healthcheck — überspringe"; return 0; }
    [ "$s" = "missing" ] && { warn "$c existiert nicht"; return 1; }
    if [ "$w" -ge 120 ]; then
      warn "$c nach 120s nicht healthy (status=$s). Letzte Logs:"
      docker logs --tail 20 "$c" 2>&1 | sed 's/^/      /'
      return 1
    fi
    sleep 3; w=$((w+3))
  done
}

# =============================================================================
#  START
# =============================================================================
do_start() {
  phase "START — geordnetes Hochfahren"
  info "Repo: $REPO_DIR   ·   Logbuch: $CTL_LOG"

  phase "1/4  Netzwerk"
  ensure_edge_network

  phase "2/4  Traefik (Reverse Proxy / TLS)"
  if $PROXY_COMPOSE up -d >>"$CTL_LOG" 2>&1; then ok "Traefik gestartet"; else err "Traefik-Start fehlgeschlagen (siehe $CTL_LOG)"; fi

  phase "3/4  Supabase (DB-first)"
  if [ -d "$SUPABASE_STACK" ]; then
    info "starte zuerst NUR die DB …"
    ( cd "$SUPABASE_STACK" && $SB_COMPOSE up -d db ) >>"$CTL_LOG" 2>&1 && ok "supabase-db gestartet" || warn "supabase-db Start meldete Fehler"
    wait_db_healthy
    info "starte restlichen Supabase-Stack …"
    ( cd "$SUPABASE_STACK" && $SB_COMPOSE up -d ) >>"$CTL_LOG" 2>&1 && ok "Supabase up -d ausgeführt" || warn "Supabase up -d meldete Fehler"
    wait_kong_up        # Kong/analytics-Timing abfangen, sonst bleibt Kong "exited"
    ensure_on_edge supabase-kong
    ensure_on_edge supabase-studio
  else
    warn "$SUPABASE_STACK nicht vorhanden — Supabase übersprungen"
  fi

  phase "4/4  koro-api (blue + green + redis)"
  if ! docker image inspect koro-api:latest >/dev/null 2>&1; then
    info "Image koro-api:latest fehlt — baue es einmalig (über api-blue) …"
    ( cd "$REPO_DIR" && $API_COMPOSE build api-blue ) >>"$CTL_LOG" 2>&1 && ok "Image gebaut" || err "Build fehlgeschlagen (siehe $CTL_LOG)"
  fi
  ( cd "$REPO_DIR" && $API_COMPOSE up -d ) >>"$CTL_LOG" 2>&1 && ok "koro-api gestartet" || err "koro-api-Start fehlgeschlagen (siehe $CTL_LOG)"
  wait_api_healthy koro-api-blue
  wait_api_healthy koro-api-green

  phase "START abgeschlossen"
  do_status_brief
}

# =============================================================================
#  STOP  (graceful, ohne zu löschen)
# =============================================================================
do_stop() {
  phase "STOP — geordnetes, sanftes Herunterfahren (entfernt NICHTS)"

  phase "1/3  koro-api (graceful Drain)"
  info "sende SIGTERM → koro-api drained (health→503, WS sauber schließen)."
  info "das dauert bis zu ~25s pro Instanz (stop_grace_period) — Calls/Meetings laufen P2P, kein Medienabbruch."
  ( cd "$REPO_DIR" && $API_COMPOSE stop ) >>"$CTL_LOG" 2>&1 && ok "koro-api gestoppt (blue+green+redis)" || warn "koro-api stop meldete Fehler"

  phase "2/3  Supabase"
  if [ -d "$SUPABASE_STACK" ]; then
    ( cd "$SUPABASE_STACK" && $SB_COMPOSE stop ) >>"$CTL_LOG" 2>&1 && ok "Supabase gestoppt" || warn "Supabase stop meldete Fehler"
  else
    info "kein Supabase-Stack vorhanden"
  fi

  phase "3/3  Traefik"
  ( cd "$REPO_DIR" && $PROXY_COMPOSE stop ) >>"$CTL_LOG" 2>&1 && ok "Traefik gestoppt" || warn "Traefik stop meldete Fehler"

  phase "STOP abgeschlossen"
  info "Wieder hochfahren mit:  sudo ./deploy/koroctl.sh start"
  info "Hinweis: nichts wurde entfernt. Komplett-Teardown: ./deploy/uninstall.sh"
}

do_restart() {
  phase "RESTART — stop, dann start"
  do_stop
  info "kurze Pause vor dem Neustart …"; sleep 3
  do_start
}

# =============================================================================
#  STATUS
# =============================================================================
print_container_row() {
  local c="$1" st he up
  st="$(state_of "$c")"; he="$(health_of "$c")"; up="$(uptime_of "$c")"
  local color="$C_GREEN"
  [ "$st" != "running" ] && color="$C_RED"
  [ "$he" = "unhealthy" ] && color="$C_RED"
  [ "$he" = "starting" ] && color="$C_YELLOW"
  printf '      %s%-22s%s state=%-9s health=%-9s seit=%s\n' "$color" "$c" "$C_RESET" "$st" "$he" "$up"
}

env_flag() {  # zeigt ob eine Env-Var im LAUFENDEN Container gesetzt ist (ohne Wert)
  local c="$1" key="$2" val
  val="$(docker exec "$c" printenv "$key" 2>/dev/null)"
  if [ -n "$val" ]; then printf '      %s✓ %s%s gesetzt (%d Zeichen)\n' "$C_GREEN" "$key" "$C_RESET" "${#val}"
  else printf '      %s✗ %s%s LEER / nicht gesetzt\n' "$C_RED" "$key" "$C_RESET"; fi
}

do_status_brief() {
  info "Container-Status:"
  for c in traefik supabase-db supabase-kong supabase-studio koro-redis koro-api-blue koro-api-green; do
    docker inspect "$c" >/dev/null 2>&1 && print_container_row "$c"
  done
}

do_status() {
  phase "STATUS  $(now)"
  info "Environment: ${C_BOLD}${KORO_ENV}${C_RESET}  ·  Branch: ${C_BOLD}${DEPLOY_BRANCH:-?}${C_RESET}  ·  ${API_DOMAIN}"

  phase "Kern-Container (Kurzüberblick)"
  do_status_brief

  phase "Supabase — vollständiger ps (alle Dienste)"
  if [ -d "$SUPABASE_STACK" ]; then
    ( cd "$SUPABASE_STACK" && $SB_COMPOSE ps ) 2>/dev/null | sed 's/^/      /'
  else
    warn "kein Supabase-Stack unter $SUPABASE_STACK"
  fi

  phase "edge-Netzwerk"
  if docker network inspect edge >/dev/null 2>&1; then
    info "Mitglieder am edge-Netz:"
    docker network inspect edge --format '{{range .Containers}}      {{.Name}}{{"\n"}}{{end}}' 2>/dev/null
    for must in supabase-kong; do
      docker network inspect edge --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | grep -qw "$must" \
        && ok "$must ist am edge-Netz (koro-api erreicht Supabase)" \
        || err "$must FEHLT am edge-Netz → koro-api kann Supabase nicht erreichen! Fix: docker network connect edge $must"
    done
  else
    err "edge-Netz existiert nicht"
  fi

  phase "Datenbank"
  if docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1; then
    ok "Postgres erreichbar (pg_isready)"
  else
    err "Postgres NICHT erreichbar"
  fi

  phase "koro-api Health (lokal über Traefik-Port)"
  for inst in koro-api-blue koro-api-green; do
    if docker inspect "$inst" >/dev/null 2>&1; then
      code="$(docker exec "$inst" node -e "require('http').get('http://127.0.0.1:3001/health',r=>{console.log(r.statusCode);process.exit(0)}).on('error',()=>{console.log('ERR');process.exit(0)})" 2>/dev/null)"
      [ "$code" = "200" ] && ok "$inst /health → 200" || warn "$inst /health → ${code:-keine Antwort}"
    fi
  done

  phase "Laufender Commit (Drift-Check)"
  for inst in koro-api-blue koro-api-green; do
    if docker inspect "$inst" >/dev/null 2>&1; then
      gc="$(docker exec "$inst" printenv GIT_COMMIT 2>/dev/null || echo unknown)"
      info "$inst läuft auf Commit: ${gc:-unknown}"
    fi
  done
  if [ -d "$REPO_DIR/.git" ]; then
    head="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
    info "Repo HEAD (lokal): $head"
  fi

  phase "App-Konfiguration (im laufenden Container)"
  if docker inspect koro-api-blue >/dev/null 2>&1; then
    env_flag koro-api-blue AI_PROVIDER
    env_flag koro-api-blue OPENAI_API_KEY
    env_flag koro-api-blue SUPABASE_SERVICE_ROLE_KEY
    env_flag koro-api-blue TURN_TOKEN
    env_flag koro-api-blue STATUS_PASSWORD
    warn "Fehlt OPENAI_API_KEY → Transkribieren/Übersetzen ist deaktiviert (AiDisabled)."
  else
    warn "koro-api-blue läuft nicht — keine App-Config prüfbar."
  fi

  phase "öffentliche Endpunkte"
  info "https://$API_DOMAIN:3001/health   ·   https://$API_DOMAIN/health"
  info "https://$DB_DOMAIN/rest/v1/   ·   Studio: https://$STUDIO_DOMAIN"
  printf '\n'
}

# =============================================================================
#  LOG  — Container-Logs ansehen (neueste zuerst)
# =============================================================================
#  koroctl log blue            letzte 200 Zeilen von koro-api-blue, neueste oben
#  koroctl log green 500       letzte 500 Zeilen
#  koroctl log green -f        live mitlaufen (chronologisch, neueste unten)
#  Ziele: blue | green | redis | <beliebiger Container-Name>
do_log() {
  local target="${1:-}" follow="" tail_n="${LOG_TAIL:-200}" arg
  shift || true
  # restliche Argumente: -f/follow  und/oder eine Zahl (tail-Anzahl)
  for arg in "$@"; do
    case "$arg" in
      -f|--follow|follow) follow=1 ;;
      *[!0-9]*|'')        ;;            # ignoriere Nicht-Zahlen
      *)                  tail_n="$arg" ;;
    esac
  done

  local container
  case "$target" in
    blue|green) container="koro-api-$target" ;;
    redis)      container="koro-redis" ;;
    '')         err "Welche Instanz?  sudo ./deploy/koroctl.sh log <blue|green|redis> [Zeilen] [-f]"; exit 2 ;;
    *)          container="$target" ;;   # beliebigen Container-Namen erlauben
  esac
  docker inspect "$container" >/dev/null 2>&1 || { err "Container '$container' existiert nicht (läuft der Stack? → koroctl status)"; exit 1; }

  if [ -n "$follow" ]; then
    info "Live-Logs von ${C_BOLD}$container${C_RESET} (chronologisch, Strg-C zum Beenden) …"
    docker logs --tail "$tail_n" --timestamps -f "$container" 2>&1
  else
    info "Logs von ${C_BOLD}$container${C_RESET} — ${C_BOLD}neueste zuerst${C_RESET} (letzte $tail_n Zeilen):"
    docker logs --tail "$tail_n" --timestamps "$container" 2>&1 | tac
  fi
}

# =============================================================================
#  Dispatch
# =============================================================================
CMD="${1:-}"
case "$CMD" in
  start)   require_root start;   do_start ;;
  stop)    require_root stop;    do_stop ;;
  restart) require_root restart; do_restart ;;
  status)  do_status ;;
  log|logs) shift; do_log "$@" ;;
  *)
    printf 'koroctl — koro-api Stack-Steuerung\n\n'
    printf '  Aufruf:  sudo ./deploy/koroctl.sh <command>\n\n'
    printf '  start          geordnet hochfahren (Traefik → Supabase DB-first → koro-api)\n'
    printf '  stop           sanft herunterfahren (koro-api drained zuerst), entfernt nichts\n'
    printf '  restart        stop, dann start\n'
    printf '  status         ausführlicher Zustand (Container, edge, DB, Commit, App-Config)\n'
    printf '  log <ziel>     Logs ansehen, neueste zuerst — ziel: blue|green|redis\n'
    printf '                 z.B.  koroctl log green        (letzte 200 Zeilen)\n'
    printf '                       koroctl log blue 500     (letzte 500 Zeilen)\n'
    printf '                       koroctl log green -f     (live mitlaufen)\n\n'
    exit 2 ;;
esac
