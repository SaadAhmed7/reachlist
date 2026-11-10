# Deploying the Number Checker

A reproducible recipe for standing this up on a fresh machine. It is written
from the deployment to `187.7.22.102`, including the things that went wrong
there, because those are what cost the time.

---

## What the target machine actually needs

Only **Docker with the compose plugin**, and a user in the `docker` group.

That is the whole list. In particular you do **not** need:

| Not needed | Why |
| --- | --- |
| `sudo` | Everything runs in containers as an unprivileged user |
| Node / npm | The build happens inside the image |
| git | Source is copied with `rsync` |
| Postgres | A container, with its own volume |
| Chromium / fonts | Installed inside the image |
| A reverse proxy | The app publishes its own port |

Check the target with:

```bash
ssh USER@HOST 'docker --version && docker compose version && id -nG'
```

If `docker` is missing from the groups, that is the one thing someone with root
has to fix: `usermod -aG docker USER`, then reconnect.

---

## Deploy

```bash
./scripts/deploy.sh deploy@NEW-HOST
```

That script is the documentation-that-runs: it syncs the source, writes an
`.env` on first run only, builds the image on the remote host, starts the
stack, and prints the URL. It is safe to re-run — see *Updating* below.

To use a different port or keep it private:

```bash
APP_PORT=9100 BIND_ADDR=127.0.0.1 ./scripts/deploy.sh deploy@NEW-HOST
```

---

## Doing it by hand

If you would rather not trust a script:

```bash
# 1. copy the source (no node_modules, no .next, no secrets)
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude .git --exclude .env \
  --exclude uploads --exclude .wwebjs_auth --exclude .wwebjs_cache \
  --exclude tsconfig.tsbuildinfo --exclude .idea --exclude '*.log' \
  --exclude docker-compose.yml --exclude docker-compose.override.yml \
  ./ deploy@HOST:~/numchecker/

# 2. write ~/numchecker/.env on the host (see the table below)

# 3. build and start
ssh deploy@HOST 'cd ~/numchecker && docker compose -f docker-compose.deploy.yml up -d --build'
```

The first build takes **8–12 minutes** (npm install, Next build, Chromium
install). Later builds reuse layers and take about a minute.

> Always pass `-f docker-compose.deploy.yml`. A bare `docker compose up` would
> pick up the repo's development `docker-compose.yml`, which is a different
> stack entirely. The deploy script excludes those files from the sync for
> exactly this reason.

---

## Environment

`~/numchecker/.env` on the target host, mode `0600`:

| Key | Example | Notes |
| --- | --- | --- |
| `DB_PASSWORD` | random 28 chars | **Never change after first run** — the volume already holds a database using it |
| `DEFAULT_REGION` | `PK` | Country assumed for numbers typed without a `+` |
| `TELEGRAM_API_ID` | 8 digits | From my.telegram.org; identifies the *app*, not a user |
| `TELEGRAM_API_HASH` | 32 hex chars | Secret — keep it out of the repo |
| `COOKIE_SECURE` | `0` | `0` for plain http, `1` behind TLS. See the warning below |
| `TRUST_PROXY` | `0` | `1` only behind a proxy you control |
| `APP_PORT` | `8099` | Host port |
| `BIND_ADDR` | `0.0.0.0` | `127.0.0.1` keeps it private |

No `TELEGRAM_PROXY_*` here: a server outside a blocking country reaches
Telegram directly, which is the main reason to run it on a server at all.

---

## After the first deploy

**1. Create the admin**

```bash
ssh deploy@HOST "cd ~/numchecker && docker compose -f docker-compose.deploy.yml \
  exec -T app npx tsx src/scripts/create-admin.ts admin@example.com 'A-STRONG-PASSWORD'"
```

Re-running with the same email resets that password, which is the lockout
escape hatch.

**2. Link the provider accounts** at `/admin` → Connected accounts.

Sessions do **not** transfer between machines. WhatsApp credentials live in the
`waauth` volume and Telegram's live in the database, both tied to that install,
so a new machine means scanning both QRs again. That is a feature rather than a
bug: copying a WhatsApp session to a second host gets both copies logged out.

**3. Create a user** for whoever is testing, with credits. Do not hand out the
admin login.

---

## Updating

```bash
./scripts/deploy.sh deploy@HOST
```

Re-running is safe: it never overwrites an existing `.env`, and the Postgres and
WhatsApp-auth volumes survive. Schema changes are applied automatically —
`prisma db push` runs on container start.

---

## Problems hit on the first deployment

Each of these cost real time. They are fixed in the committed `Dockerfile`, but
the symptoms are worth recognising.

**`"/app/public": not found`** — the project had no `public/` directory, so the
Dockerfile's `COPY` had nothing to copy. There is now a tracked `public/.gitkeep`.

**`Query engine for "debian-openssl-1.1.x" not found`** — Prisma picks its query
engine by sniffing the OpenSSL version *at generate time*. The build stage had
no `openssl`, so it guessed 1.1.x while the runtime image had 3.0.x. Two fixes
applied together: `openssl` is installed in the build stages, and
`prisma generate` now runs **in the runtime stage**, where the OpenSSL that will
actually be used is present. Pinning `binaryTargets` alone was not enough.

**Logged in, then immediately logged out** — `NODE_ENV=production` sets the
session cookie `Secure`, and a browser will not send a `Secure` cookie over
plain http. Hence `COOKIE_SECURE=0`. Set it to `1` the moment you have TLS.

**A port looked firewalled but was not.** A plain host process on `:8080` was
unreachable from the internet, so firewalld appeared to be blocking everything
but 22/80/443. A *Docker-published* port on `:8099` was reachable immediately.
Docker inserts its own NAT rules that bypass firewalld's zones. The practical
consequence: **any container port you publish is public**, whatever firewalld
says. Use `BIND_ADDR=127.0.0.1` if you do not want that.

**SSH dropping mid-build.** The first build outlived the ssh session and died
part-way. The script runs the build with `nohup` writing to
`/tmp/numchecker-build.log` on the host, then polls, so a dropped connection
cannot kill it.

---

## Security posture as deployed

Honest summary of what the IP:port deployment is and is not:

- **Plain http.** Passwords and results cross the internet unencrypted. Fine
  for a client trial, not for real customer data. For TLS, point a hostname at
  the host and front it with Caddy, or use a Cloudflare tunnel.
- Applied regardless: CSP, `X-Frame-Options: DENY`, `nosniff`, no-store on
  every API response, scrypt passwords, hashed session tokens, login rate
  limiting, and generic 500s that do not leak internals.
- The app is reachable by anyone who knows the port. The login limiter (5/min
  per email, 20/min per client) is what stands between that and a password
  guess.

---

## Backup, rollback, teardown

The only state is two Docker volumes: `numchecker_dbdata` (users, credits,
ledger, results) and `numchecker_waauth` (WhatsApp login).

```bash
# back up the database
ssh deploy@HOST 'docker compose -f ~/numchecker/docker-compose.deploy.yml \
  exec -T db pg_dump -U numchecker numchecker' > numchecker-$(date +%F).sql

# stop, keeping all data
ssh deploy@HOST 'cd ~/numchecker && docker compose -f docker-compose.deploy.yml down'

# remove everything including data — irreversible
ssh deploy@HOST 'cd ~/numchecker && docker compose -f docker-compose.deploy.yml down -v'
```

`down -v` deletes the users, the credit ledger and the WhatsApp login. Take the
dump first.

---

## Known rough edge

The image is ~4GB, mostly because `npm ci` installs dev dependencies and the
runtime keeps them (`tsx` is needed for the admin script, `prisma` for
migrations). Moving `tsx` and `prisma` to runtime dependencies would allow
`--omit=dev` and cut this substantially. It costs disk, not speed.
