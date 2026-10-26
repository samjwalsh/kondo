#!/usr/bin/env bash
# Builds Kondo on this machine and installs it on the target as a user-level
# systemd service that starts at boot. Usage: npm run deploy
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f deploy/deploy.env ]; then
  echo "Missing deploy/deploy.env — copy deploy/deploy.env.example and fill it in." >&2
  exit 1
fi
# shellcheck source=/dev/null
source deploy/deploy.env
: "${DEPLOY_HOST:?set DEPLOY_HOST in deploy/deploy.env}"
KONDO_PORT="${KONDO_PORT:-4242}"
NODE_VERSION="${NODE_VERSION:-v24.22.1}"

echo "==> Checking (lint, types, tests)"
npm run --silent check

echo "==> Building"
npm run --silent build

dirty=""
[ -n "$(git status --porcelain)" ] && dirty="-dirty"
release="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)${dirty}"

echo "==> Uploading release $release to $DEPLOY_HOST"
ssh "$DEPLOY_HOST" "mkdir -p ~/kondo/releases/$release"
rsync -a dist/ "$DEPLOY_HOST:kondo/releases/$release/"
rsync -a deploy/kondo.service "$DEPLOY_HOST:kondo/releases/$release/kondo.service"

echo "==> Installing"
ssh "$DEPLOY_HOST" "RELEASE='$release' NODE_VERSION='$NODE_VERSION' KONDO_PORT='$KONDO_PORT' bash -s" \
  < deploy/remote-install.sh

echo "==> Reachable from here?"
curl -fsS "http://${DEPLOY_HOST#*@}:$KONDO_PORT/api/health"
echo
