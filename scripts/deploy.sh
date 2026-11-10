#!/usr/bin/env bash
#
# Deploy the Number Checker to a host that has Docker and nothing else.
#
#   ./scripts/deploy.sh deploy@host
#   APP_PORT=9100 BIND_ADDR=127.0.0.1 ./scripts/deploy.sh deploy@host
#
# Safe to re-run: an existing .env on the target is never overwritten, and the
# database and WhatsApp-auth volumes are left alone.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: $0 user@host" >&2
  exit 1
fi

REMOTE_DIR="${REMOTE_DIR:-numchecker}"
COMPOSE="docker compose -f docker-compose.deploy.yml"
APP_PORT="${APP_PORT:-8099}"
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
DEFAULT_REGION="${DEFAULT_REGION:-PK}"
HOST_ONLY="${TARGET#*@}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- preflight

say "Checking $TARGET"
ssh -o ConnectTimeout=20 "$TARGET" '
  command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "the docker compose plugin is missing" >&2; exit 1; }
  docker ps >/dev/null 2>&1 || { echo "this user cannot use docker (needs the docker group)" >&2; exit 1; }
  echo "  docker ok: $(docker --version)"
'

# ------------------------------------------------------------------- source

say "Syncing source to ~/$REMOTE_DIR"
# The dev compose files are excluded on purpose: leaving them there means a
# bare `docker compose up` would start the wrong stack.
# Leading slashes matter: an unanchored "uploads" would also exclude
# src/app/uploads, the page of the same name, and ship a build that 404s on it.
rsync -az --delete \
  --exclude /node_modules --exclude /.next --exclude /.git --exclude /.env \
  --exclude /uploads --exclude /.wwebjs_auth --exclude /.wwebjs_cache \
  --exclude /tsconfig.tsbuildinfo --exclude /.idea --exclude '*.log' \
  --exclude /docker-compose.yml --exclude /docker-compose.override.yml \
  ./ "$TARGET:~/$REMOTE_DIR/"
echo "  synced"

# ---------------------------------------------------------------------- env

say "Configuring"
# Generated here so the password never has to exist in the repo. Written only
# if absent: regenerating it would orphan the existing database volume.
DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"

ssh "$TARGET" "
  cd ~/$REMOTE_DIR
  if [ -f .env ]; then
    echo '  .env already exists — keeping it (database password must not change)'
  else
    cat > .env <<ENV
DB_PASSWORD=$DB_PASSWORD
DEFAULT_REGION=$DEFAULT_REGION
TELEGRAM_API_ID=${TELEGRAM_API_ID:-}
TELEGRAM_API_HASH=${TELEGRAM_API_HASH:-}
COOKIE_SECURE=${COOKIE_SECURE:-0}
TRUST_PROXY=${TRUST_PROXY:-0}
APP_PORT=$APP_PORT
BIND_ADDR=$BIND_ADDR
ENV
    chmod 600 .env
    echo '  .env written'
  fi
"

# -------------------------------------------------------------------- build

say "Building and starting (first run takes 8-12 minutes)"
# nohup + polling: the first build outlives an ssh session, and a dropped
# connection would otherwise kill it half-way through.
ssh "$TARGET" "cd ~/$REMOTE_DIR && rm -f /tmp/numchecker-build.log && \
  nohup $COMPOSE up -d --build > /tmp/numchecker-build.log 2>&1 & echo '  started'"

printf '  waiting'
for _ in $(seq 1 120); do
  sleep 10
  printf '.'
  if ssh -o ConnectTimeout=20 "$TARGET" "cd ~/$REMOTE_DIR && $COMPOSE ps --format '{{.Service}}:{{.State}}' 2>/dev/null | grep -q 'app:running'"; then
    printf '\n'
    break
  fi
done

# -------------------------------------------------------------------- check

say "Verifying"
ssh "$TARGET" "
  cd ~/$REMOTE_DIR
  $COMPOSE ps --format '  {{.Service}} | {{.State}} | {{.Ports}}'
  for _ in \$(seq 1 20); do
    code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:$APP_PORT/login || true)
    [ \"\$code\" = '200' ] && { echo \"  /login -> 200\"; break; }
    sleep 5
  done
  [ \"\$code\" = '200' ] || { echo '  app did not answer; last 30 log lines:'; $COMPOSE logs app --tail 30; exit 1; }
"

say "Done"
if [ "$BIND_ADDR" = "127.0.0.1" ]; then
  echo "  Private: reachable only on the host at http://127.0.0.1:$APP_PORT"
else
  echo "  http://$HOST_ONLY:$APP_PORT"
  echo "  NOTE: a docker-published port bypasses firewalld — this is public."
fi
cat <<NEXT

  Next, once only:
    1. create the admin
       ssh $TARGET "cd ~/$REMOTE_DIR && $COMPOSE exec -T app \\
         npx tsx src/scripts/create-admin.ts admin@example.com 'A-STRONG-PASSWORD'"
    2. sign in, go to /admin, link WhatsApp and Telegram by QR
       (sessions do not transfer between machines)
    3. create a user with credits for whoever is testing

NEXT
