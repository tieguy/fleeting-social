#!/usr/bin/env bash
# Build and publish Fleeting when the deploy branch has moved.
#
# Runs from fleeting-deploy.timer. Each run compares the branch head with the
# deployed commit and does nothing when they match. Otherwise it builds the
# new commit in a clean clone, copies dist/ to releases/<sha>, converts the
# build's Netlify-style _headers file into a Caddy snippet, and repoints the
# `current` symlink that Caddy serves. A failed build leaves the running
# release in place.
#
# When service/ changed, it first installs the Fleeting service the same way,
# under fleeting-service/releases/<sha>, restarts fleeting-service and checks
# /fleeting-api/health through Caddy. If the check fails, it puts the previous
# service release back and stops before the site changes.
set -euo pipefail

REPO="${FLEETING_DEPLOY_REPO:-https://github.com/tieguy/fleeting-social.git}"
BRANCH="${FLEETING_DEPLOY_BRANCH:-main}"
BASE="${FLEETING_DEPLOY_DIR:-$HOME/containers/volumes/fleeting}"
SERVICE_BASE="${FLEETING_SERVICE_DIR:-$HOME/containers/volumes/fleeting-service}"
HEALTH_URL="${FLEETING_HEALTH_URL:-http://127.0.0.1:8085/fleeting-api/health}"
KEEP_RELEASES=3

SRC="$BASE/src"
SITE="$BASE/site"
RELEASES="$SITE/releases"

log() { echo "fleeting-deploy: $*"; }

# Keep the newest releases in a directory, by modification time
prune() {
  ls -1t "$1" | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
    rm -rf "${1:?}/$old"
  done
}

service_healthy() {
  for _ in $(seq 1 15); do
    if curl -fsS -o /dev/null "$HEALTH_URL"; then return 0; fi
    sleep 2
  done
  return 1
}

point_service_at() {
  ln -sfn "$1" "$SERVICE_BASE/current.new"
  mv -T "$SERVICE_BASE/current.new" "$SERVICE_BASE/current"
  systemctl --user restart fleeting-service.service
}

# Installs service/ at $head_sha when its tree differs from the deployed one
deploy_service() {
  local tree deployed previous release
  tree=$(git -C "$SRC" rev-parse "$head_sha:service")
  deployed=$(cat "$SERVICE_BASE/deployed-tree" 2>/dev/null || true)
  if [[ "$tree" == "$deployed" ]]; then
    return 0
  fi
  log "deploying the service (tree $tree)"
  (cd "$SRC/service" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  mkdir -p "$SERVICE_BASE/releases" "$SERVICE_BASE/data"
  chmod 700 "$SERVICE_BASE/data"
  release="$SERVICE_BASE/releases/$head_sha"
  rm -rf "$release"
  cp -a "$SRC/service" "$release"
  previous=$(readlink "$SERVICE_BASE/current" 2>/dev/null || true)
  point_service_at "releases/$head_sha"
  if ! service_healthy; then
    log "service health check failed"
    if [[ -n "$previous" ]]; then
      point_service_at "$previous"
      log "put back $previous"
    fi
    return 1
  fi
  echo "$tree" > "$SERVICE_BASE/deployed-tree"
  prune "$SERVICE_BASE/releases"
  log "service healthy"
}

head_sha=$(git ls-remote "$REPO" "refs/heads/$BRANCH" | cut -f1)
if [[ -z "$head_sha" ]]; then
  log "branch $BRANCH not found in $REPO"
  exit 1
fi
deployed_sha=$(cat "$SITE/deployed-sha" 2>/dev/null || true)
if [[ "$head_sha" == "$deployed_sha" ]]; then
  exit 0
fi
log "deploying $BRANCH at $head_sha (was ${deployed_sha:-nothing})"

mkdir -p "$RELEASES"
if [[ ! -d "$SRC/.git" ]]; then
  git clone --quiet "$REPO" "$SRC"
fi
git -C "$SRC" remote set-url origin "$REPO"
git -C "$SRC" fetch --quiet origin "$head_sha"
git -C "$SRC" checkout --quiet --force --detach "$head_sha"
git -C "$SRC" clean --quiet -fdx -e node_modules

(cd "$SRC" && npm ci --no-audit --no-fund --loglevel=error && npm run build)

# The new site may need the new service, so the service goes first
deploy_service

release="$RELEASES/$head_sha"
rm -rf "$release"
cp -a "$SRC/dist" "$release"

# Netlify `_headers` → Caddy snippet. Each block is a path line followed by
# indented `Name: value` lines; `/*` and `/assets/*` are prefix matches, any
# other path is exact, as on Netlify.
awk '
  function flush() {
    if (path == "" || n == 0) return
    m++
    printf "@h%d path %s\n", m, path
    for (i = 1; i <= n; i++) printf "header @h%d %s\n", m, hdr[i]
    n = 0
  }
  /^[^ \t]/ { flush(); path = $0; next }
  /^[ \t]+[^ \t]/ {
    line = $0
    sub(/^[ \t]+/, "", line)
    name = substr(line, 1, index(line, ":") - 1)
    value = substr(line, index(line, ":") + 1)
    sub(/^[ \t]+/, "", value)
    gsub(/\\/, "\\\\", value)
    gsub(/"/, "\\\"", value)
    hdr[++n] = name " \"" value "\""
    next
  }
  END { flush() }
' "$release/_headers" > "$release/headers.caddy"

ln -sfn "releases/$head_sha" "$SITE/current.new"
mv -T "$SITE/current.new" "$SITE/current"

# Caddy reads the header snippet at startup only
if ! cmp -s "$release/headers.caddy" "$SITE/headers.caddy"; then
  cp "$release/headers.caddy" "$SITE/headers.caddy"
  systemctl --user restart fleeting.service
  log "headers changed; restarted fleeting.service"
fi
echo "$head_sha" > "$SITE/deployed-sha"

prune "$RELEASES"
log "deployed $head_sha"
