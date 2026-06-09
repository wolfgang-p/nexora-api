#!/usr/bin/env bash
# Zero-downtime rolling deploy. Pulls the latest main, rebuilds the image,
# then recreates ONE instance at a time (blue, then green) — the other keeps
# serving the whole time. Traefik health-checks route around the instance
# being recreated; active calls survive (media is P2P/TURN, not via the API).
#
# Idempotent + cron-safe: no-ops when there is nothing new to deploy.
#   */2 * * * * /opt/koro-api/deploy/deploy.sh >> /var/log/koro-deploy.log 2>&1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BRANCH="${DEPLOY_BRANCH:-main}"
COMPOSE="docker compose -f deploy/docker-compose.api.yml"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"   # seconds to wait for an instance

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

wait_healthy() {
  local cname="$1" waited=0
  while true; do
    local status
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cname" 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] && { log "  $cname healthy"; return 0; }
    if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
      log "  ERROR: $cname not healthy after ${HEALTH_TIMEOUT}s (status=$status)"
      docker logs --tail 40 "$cname" || true
      exit 1
    fi
    sleep 2; waited=$((waited + 2))
  done
}

roll() {
  local service="$1" cname="$2"
  log "rolling $service ..."
  # --no-deps: don't touch redis or the other instance.
  $COMPOSE up -d --no-deps "$service"
  wait_healthy "$cname"
}

# ── 1. Is there anything new? ──────────────────────────────────────────
git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0   # up to date — stay silent
fi

log "change detected: ${LOCAL:0:8} -> ${REMOTE:0:8} — deploying"
git pull --ff-only origin "$BRANCH"

# ── 2. Build the new image once ────────────────────────────────────────
# Stamp the running version into the image so /status shows the deployed commit.
export GIT_COMMIT="$(git rev-parse --short HEAD)"
export GIT_COMMITTED_AT="$(git show -s --format=%cI HEAD)"
log "building image @ $GIT_COMMIT"
# blue + green teilen koro-api:latest -> nur EINEN Service bauen, sonst rennt der
# parallele Export beider Targets in: image "...koro-api:latest": already exists
$COMPOSE build api-blue

# ── 3. Make sure redis is up, then roll instances one by one ───────────
$COMPOSE up -d --no-deps redis
roll api-blue  koro-api-blue
roll api-green koro-api-green

# ── 4. Record the deploy in the dashboard's event log ──────────────────
SUBJ="$(git log -1 --pretty=%s | tr -d '"\\' | cut -c1-120)"
AUTHOR="$(git log -1 --pretty=%an | tr -d '"\\')"
EVENT="{\"type\":\"deploy\",\"instance\":\"host\",\"commit\":\"$GIT_COMMIT\",\"subject\":\"$SUBJ\",\"author\":\"$AUTHOR\",\"at\":$(date +%s)000}"
docker exec koro-redis redis-cli LPUSH koro:events "$EVENT" >/dev/null 2>&1 || true
docker exec koro-redis redis-cli LTRIM koro:events 0 199 >/dev/null 2>&1 || true

docker image prune -f >/dev/null 2>&1 || true
log "deploy complete (now at $GIT_COMMIT)"
