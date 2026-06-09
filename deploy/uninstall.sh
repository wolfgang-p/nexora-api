#!/usr/bin/env bash
# =============================================================================
#  koro-api — Vollständiger Teardown
# =============================================================================
#  Entfernt ALLES, was deploy/install.sh angelegt hat:
#    • koro-api-Stack  (blue, green, redis) + Volume koro-uploads
#    • Proxy-Stack     (traefik) + Volume letsencrypt
#    • Supabase-Stack  (alle Container) + ALLE Supabase-Volumes (= DATENBANK!)
#    • Docker-Netzwerk  edge
#    • Image  koro-api:latest
#
#  Optional (Flags):
#    --images   zusätzlich die Supabase-/Redis-/Traefik-Images löschen
#    --purge    zusätzlich Dateien löschen: /opt/supabase-stack, /opt/supabase,
#               koro-api/.env, deploy/.install-credentials, /var/log/koro-install-*.log
#    --yes      ohne Rückfrage durchziehen (VORSICHT)
#
#  Aufruf:  sudo ./deploy/uninstall.sh            # interaktiv, mit Bestätigung
#           sudo ./deploy/uninstall.sh --purge    # auch Dateien/Klone entfernen
#
#  ⚠️  Das löscht UNWIDERRUFLICH alle Daten (DB-Volume von Supabase, Uploads,
#      Zertifikate). Es gibt KEIN Backup.
# =============================================================================
set -uo pipefail   # bewusst KEIN -e: Teardown läuft best-effort weiter

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPABASE_STACK="/opt/supabase-stack"
SUPABASE_SRC="/opt/supabase"
KORO_ENV="$REPO_DIR/.env"
CRED_FILE="$REPO_DIR/deploy/.install-credentials"

# ── Flags ────────────────────────────────────────────────────────────────────
DO_IMAGES=0; DO_PURGE=0; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --images) DO_IMAGES=1 ;;
    --purge)  DO_PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    *) echo "Unbekanntes Flag: $arg"; exit 2 ;;
  esac
done

# ── Farben / Logging ─────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi
info() { printf '  %s•%s %s\n' "${C_CYAN}" "${C_RESET}" "$*"; }
ok()   { printf '  %s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '  %s! %s%s\n' "${C_YELLOW}" "$*" "${C_RESET}"; }
err()  { printf '  %s✗ %s%s\n' "${C_RED}" "$*" "${C_RESET}"; }
step() { printf '\n%s── %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }

# run "Beschreibung" cmd…  → führt aus, meldet ✓/!  (Fehler nicht fatal)
run() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else warn "$desc — übersprungen (nicht vorhanden/Fehler)"; fi
}
run_sh() { local d="$1"; shift; run "$d" bash -c "$*"; }

if [ "$(id -u)" -ne 0 ]; then err "Bitte als root:  sudo ./deploy/uninstall.sh"; exit 1; fi

# ── Sicherheitsabfrage ───────────────────────────────────────────────────────
printf '%s\n' "${C_BOLD}${C_RED}"
cat <<'BANNER'
   ⚠  koro-api  TEARDOWN  ⚠
BANNER
printf '%s' "${C_RESET}"
warn "Das entfernt ALLE Container, Volumes und das edge-Netz."
warn "Die Supabase-Datenbank (DB-Volume), Uploads und Zertifikate gehen"
warn "UNWIDERRUFLICH verloren. Es gibt KEIN Backup."
[ "$DO_IMAGES" -eq 1 ] && warn "--images: zusätzlich werden Docker-Images gelöscht."
[ "$DO_PURGE"  -eq 1 ] && warn "--purge:  zusätzlich werden Dateien gelöscht (.env, Klone, Logs, Credentials)."

if [ "$ASSUME_YES" -ne 1 ]; then
  printf '\n  %sZum Bestätigen tippe exakt %sDELETE%s und Enter: %s' "${C_BOLD}" "${C_RED}" "${C_RESET}${C_BOLD}" "${C_RESET}"
  read -r CONFIRM </dev/tty || CONFIRM=""
  if [ "$CONFIRM" != "DELETE" ]; then err "Abgebrochen — nichts gelöscht."; exit 1; fi
fi

# ── 1. koro-api-Stack ────────────────────────────────────────────────────────
step "koro-api-Stack (blue + green + redis) entfernen"
run_sh "compose down -v (api)" \
  "cd '$REPO_DIR' && docker compose -f deploy/docker-compose.api.yml down -v --remove-orphans"
# Fallback per Name, falls compose-Projekt nicht greift:
for c in koro-api-blue koro-api-green koro-redis; do
  run "Container $c entfernen" docker rm -f "$c"
done

# ── 2. Proxy-Stack (Traefik) ─────────────────────────────────────────────────
step "Proxy-Stack (Traefik) entfernen"
run_sh "compose down -v (proxy)" \
  "cd '$REPO_DIR' && docker compose -f deploy/docker-compose.proxy.yml down -v --remove-orphans"
run "Container traefik entfernen" docker rm -f traefik

# ── 3. Supabase-Stack ────────────────────────────────────────────────────────
step "Supabase-Stack + Volumes (DB!) entfernen"
if [ -d "$SUPABASE_STACK" ]; then
  if [ -f "$SUPABASE_STACK/docker-compose.override.yml" ]; then
    run_sh "compose down -v (supabase, mit Override)" \
      "cd '$SUPABASE_STACK' && docker compose -f docker-compose.yml -f docker-compose.override.yml down -v --remove-orphans"
  else
    run_sh "compose down -v (supabase)" \
      "cd '$SUPABASE_STACK' && docker compose down -v --remove-orphans"
  fi
else
  warn "$SUPABASE_STACK nicht vorhanden — Supabase per Name aufräumen."
fi
# Fallback: alle übrig gebliebenen supabase-* Container hart entfernen
run_sh "übrige supabase-*-Container entfernen" \
  'ids=$(docker ps -aq --filter name=supabase-); [ -n "$ids" ] && docker rm -f $ids || true'
# Fallback: übrig gebliebene supabase-Volumes entfernen
run_sh "übrige supabase-Volumes entfernen" \
  'vs=$(docker volume ls -q | grep -E "supabase|^koro" || true); [ -n "$vs" ] && docker volume rm -f $vs || true'

# ── 4. edge-Netzwerk ─────────────────────────────────────────────────────────
step "Docker-Netzwerk 'edge' entfernen"
run "Netzwerk edge entfernen" docker network rm edge

# ── 5. Images ────────────────────────────────────────────────────────────────
step "Images aufräumen"
run "Image koro-api:latest entfernen" docker image rm -f koro-api:latest
if [ "$DO_IMAGES" -eq 1 ]; then
  run_sh "Supabase/Traefik/Redis-Images entfernen" \
    'imgs=$(docker images --format "{{.Repository}}:{{.Tag}}" | grep -E "supabase|kong|postgrest|gotrue|realtime|storage-api|imgproxy|postgres-meta|edge-runtime|logflare|supavisor|^traefik|^redis|vector" || true); [ -n "$imgs" ] && docker image rm -f $imgs || true'
  run "Dangling-Images aufräumen" docker image prune -f
else
  info "Images von Supabase/Traefik/Redis bleiben (erneut: --images)."
fi

# ── 6. Dateien (nur mit --purge) ─────────────────────────────────────────────
step "Dateien / Klone"
if [ "$DO_PURGE" -eq 1 ]; then
  run "$SUPABASE_STACK entfernen" rm -rf "$SUPABASE_STACK"
  run "$SUPABASE_SRC entfernen"   rm -rf "$SUPABASE_SRC"
  run "koro-api/.env entfernen"   rm -f "$KORO_ENV"
  run "Credentials entfernen"     rm -f "$CRED_FILE"
  run_sh "Install-Logs entfernen" 'rm -f /var/log/koro-install-*.log'
  warn "Das Git-Repo unter $REPO_DIR bleibt bestehen (Script liegt darin)."
else
  info "Dateien bleiben erhalten (.env, $SUPABASE_STACK, Logs). Mit --purge auch diese löschen."
fi

# ── Fertig ───────────────────────────────────────────────────────────────────
printf '\n%s── Teardown abgeschlossen%s\n' "${C_BOLD}${C_GREEN}" "${C_RESET}"
info "Kontrolle (sollte leer / ohne koro/supabase sein):"
printf '      %sdocker ps -a%s   ·   %sdocker volume ls%s   ·   %sdocker network ls%s\n' \
  "${C_DIM}" "${C_RESET}" "${C_DIM}" "${C_RESET}" "${C_DIM}" "${C_RESET}"
printf '  Neu aufsetzen:  %ssudo ./deploy/install.sh%s\n\n' "${C_DIM}" "${C_RESET}"
