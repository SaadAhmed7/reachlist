# ReachList

CSV pipeline for keeping an **opt-in** contact list clean: normalize to E.164,
dedupe, and refuse rows that cannot show consent.

This is stage 1 of the system. It deliberately does **not** check whether a
number is registered on WhatsApp or Telegram — see [Why there is no presence
check](#why-there-is-no-presence-check).

The **number checker at `/`** *does* answer it, for **WhatsApp and Telegram**,
by running lookups through the visitor's own linked session — see [The presence
checkers](#the-presence-checkers-). The importer lives at **`/import`**, does
not use the checker, and does not depend on it.

---

## Quick start

```bash
cp .env.example .env          # set DEFAULT_REGION to your main market
docker compose up -d          # Postgres + Redis
npm install
npm run db:push               # create the schema
npm run worker                # terminal 1 — the import worker
npm run dev                   # terminal 2 — the web app
```

Open http://localhost:3000/import and upload `samples/example-contacts.csv`. It is
built to exercise every path: a duplicate in two formats, a day-first date, a
landline, unicode whitespace, an unparseable cell, and a row with blank consent
columns.

`DEFAULT_REGION` matters. It is the country assumed for numbers written in
national format (`03001234567`). Numbers that already carry a `+` or `00`
prefix ignore it.

---

## The metered checker

A credit-metered service with an admin panel and a user panel.

```
  /login     sign in
  /          user panel  — check a number, see history and balance
  /admin     admin panel — users, credits, connected accounts
  /import    the CSV importer (admin only, operator tooling)
```

### Who the lookups run through

The operator registers WhatsApp and Telegram accounts in `/admin`, and **every
user's lookups run through those**. That is the central risk of this design and
it is the opposite of what a per-visitor QR does: a ban takes out the whole
service, not one visitor.

Two things exist because of it. `ProviderAccount` supports **several accounts
per channel**, and `acquire()` picks the least-used ready one, so load levels
out instead of burning a single account. And any account can be **disabled
without being deleted**, which is the right response to one that starts
erroring — a `FLOOD_WAIT` takes its account out of rotation automatically.

Sessions survive restarts. Telegram's `StringSession` is stored on the row, so
the server reconnects without a fresh QR; WhatsApp keeps its own auth under
`.wwebjs_auth/web/<providerId>`.

### Speed, and what it costs

A single check asks both channels **at once** — they are separate accounts, so
concurrency there buys wall-clock time at no extra per-account request rate.
Measured: 0.63s sequential, 0.33s parallel.

Batches do two things that are faster *and* gentler at the same time:

- **Channels run concurrently.** Again, separate accounts, so this halves the
  wall clock for nothing.
- **Lookups are chunked by `driver.batchSize`.** Telegram's `importContacts`
  takes a whole batch, and the old runner called it one number at a time —
  paying a full rate-limit interval for a call that could have carried five.
  Fewer calls is both faster and safer.

Together: 10 numbers across both channels went from ~275s to **85s**.

The only genuinely risky lever is the pacing itself, so it is env-tunable
rather than lowered by default:

| Variable | Default | Effect |
| --- | --- | --- |
| `WHATSAPP_DELAY_MS` | 7000 | Pause between WhatsApp lookups |
| `TELEGRAM_BATCH` | 5 | Numbers per `importContacts` — the biggest lever |
| `TELEGRAM_DELAY_MS` | 15000 | Pause between those calls |
| `WHATSAPP_MAX_LOOKUPS` / `TELEGRAM_MAX_LOOKUPS` | 200 / 100 | Cap per run |

Raise `TELEGRAM_BATCH` before you lower any delay: it reduces request count,
where shortening a delay increases it. Telegram's flood limits count imported
contacts as well as calls, so this is not free above a point.

Concurrent writes from the two channels land on the same `BatchItem` row, so
results are merged with Postgres `jsonb ||` in a single statement rather than
read-modify-write, which would lose whichever write arrived second.

### Credits

One credit per channel checked. Telegram's last-seen rides along with the
registration lookup — it is the same API call, so it is not billed twice.

Two rules hold the ledger together:

- **`User.credits` is never written outside a transaction that also appends a
  `CreditTx`.** The ledger is the record; the column is a cache of it. A balance
  that disagrees with `SUM(delta)` means something bypassed the ledger.
- **A debit is conditional on the balance in the same statement**
  (`updateMany where credits >= amount`), so two concurrent checks cannot both
  spend the last credit. Verified: 10 concurrent debits against a balance of 3
  settle as exactly 3 succeeded, 7 refused, balance 0, ledger sum 0.

**Credits are taken before the lookup and refunded if it fails.** Charging
afterwards would let a crash hand out free lookups we cannot reconstruct;
charging first leaves a refundable over-charge that is visible in the ledger. An
invalid number is rejected before any debit, and a failed lookup is recorded
`UNKNOWN` with `credits: 0` — the same rule as everywhere else here, that a
throttled lookup is never an answer.

Top-ups are manual: payment happens outside the system, an admin adds credit,
and the reason is stored on the transaction with the admin who issued it.

### Accounts

`npm run admin:create -- <email> <password>` creates or resets the first admin;
re-running on an existing email resets the password, which is the lockout
escape hatch. Passwords are scrypt with a per-password salt. Sessions are opaque
random tokens, stored **hashed**, so a database dump is not a pile of live
logins. Deactivating a user or changing their password revokes every session
they have immediately.

### Not built yet

CSV batch checking through the metered path. The single-number flow is complete;
a list would need the job runner wired to the ledger (debit upfront for the
whole list, refund the rows that come back `UNKNOWN`), which is work the batch
runner in `store.ts` is already shaped for.

### The two channels do not mean the same thing

|  | WhatsApp | Telegram |
| --- | --- | --- |
| Method | `isRegisteredUser` | `contacts.importContacts` |
| Batch | 1 at a time | 5 per call |
| Pacing | ~7s | ~15s |
| Cap per run | 200 | 100 |
| Negative means | No account | **Not found** — may just be hidden |

Two Telegram-specific problems shaped that driver.

**Importing has a side effect on the visitor's data.** `importContacts` adds
contacts to their account. `finish()` deletes every contact the run created, and
runs on normal completion, early stop *and* session close.

**A Telegram negative is weaker than WhatsApp's.** Anyone who sets *Who can find
me by my phone number* to *My Contacts* does not come back from an import even
though they are on Telegram. The UI says this next to the result rather than
letting "not found" read as "absent".

Telegram also needs an **application** registered once by whoever runs the
server, at <https://my.telegram.org> → API development tools, as
`TELEGRAM_API_ID` / `TELEGRAM_API_HASH`. Those identify the app, not any user —
visitors still link their own account. Without them the Telegram card renders
disabled with the reason, rather than failing when someone clicks it.

### What a positive means

Someone has an account on that number *today*. Not that it is the person who
consented: recycled numbers are common, and reachability is not permission.
`ConsentRecord` in the importer still points at the original person.

---

## How a file moves through the system

```
  upload ──▶ /api/uploads/inspect ──▶ headers read, column mapping proposed
                                      (file parked on disk, nothing imported)
                     │
              user confirms mapping
                     ▼
            POST /api/lists ──▶ List row created ──▶ BullMQ job queued
                                                          │
                                                          ▼
                                            worker streams the CSV
                                            ├─ normalize to E.164
                                            ├─ validate consent
                                            ├─ check opt-out register
                                            ├─ dedupe within the file
                                            └─ write in chunks of 1,000
                                                          │
                                                          ▼
                                     results page polls until COMPLETED
                                     clean list / rejects / mobile-only
                                     downloadable
```

The worker **streams** — it never holds the file in memory, so a million-row
upload costs the same RAM as a hundred rows. Progress is written to the `List`
row after every chunk, which is what the results page polls.

---

## Design decisions worth knowing

**Every row is kept, even rejected ones.** `ListItem` stores the original row
as JSON with a status and a human reason. That is what makes the "download
rejects" file useful — the user gets their own data back with an explanation
attached, instead of a silent row count that dropped.

**Consent is checked before dedupe.** A duplicate of a consent-less row reports
`MISSING_CONSENT`, not `DUPLICATE_IN_FILE`, so the underlying problem surfaces
rather than hiding behind the dupe.

**Opt-outs are permanent.** A number that opted out cannot be resurrected by
re-uploading a CSV that contains it. Re-consent has to be a deliberate action,
not a side effect of an import.

**Excel scientific notation is refused, not repaired.** `9.23001e+11` is
rejected as unparseable. Reconstructing the real digits is guesswork, and a
silently wrong phone number is worse than a visible rejection.

**Dates are day-first for slashed formats.** `03/04/2025` is 3 April. ISO
(`2025-03-14`) and epoch values are handled separately and unambiguously.
Month-first vs day-first is the classic silent corruption in imported lists —
if your source system is US-format, change `parseDate` in `src/lib/consent.ts`
and say so in the UI.

**Line type is guessed offline, for free, and never overstated.** `phone.ts`
imports `libphonenumber-js/max` — the default `/min` build carries no
number-type metadata, so `getType()` returns `undefined` for most countries
and the classification silently does nothing. The guess is stored on
`Contact.lineType` at import: a `LANDLINE` can never receive a WhatsApp
message, so this is a free pre-filter before you spend anything on stage 2.
What the metadata cannot separate stays `UNKNOWN` rather than being rounded up
to `MOBILE` — most `+1` numbers are genuinely ambiguous offline. `lineCheckedAt`
is deliberately left null, because it means "a carrier lookup has seen this"
and the Twilio pass uses it to find work.

**The mobile-only export shows what it leaves behind.** `?set=mobile` returns
accepted rows whose `lineType` is strictly `MOBILE`, so it drops landlines *and*
numbers the offline metadata could not classify. That second group is the
dangerous one — they are ambiguous, not bad. The results page therefore labels
the button with the row count and states how many accepted rows the file omits,
rather than handing over a quietly shorter list. The full clean list still
contains every accepted row.

**Column mapping is proposed, never assumed.** `guessColumnMap` pre-fills the
form; the user confirms before anything imports. The confirmed map is persisted
on the `List`, so a re-run is reproducible.

---

## Layout

```
prisma/schema.prisma      data model, with the reachability tables reserved
src/lib/phone.ts          E.164 normalization
src/lib/consent.ts        the consent gate
src/lib/columns.ts        header → field mapping
src/lib/process-row.ts    pure row → verdict function (all the logic, no IO)
src/lib/validate-list.ts  input parsing + offline pre-pass for /validate
src/lib/presence/…        driver contract, session store, WhatsApp + Telegram
src/lib/csv.ts            streaming parse
src/lib/queue.ts          BullMQ queue
src/worker/index.ts       the import worker
src/app/page.tsx          the number checker (front page)
src/app/import/…          the CSV importer
src/app/api/…             inspect, create, status, export
src/app/api/presence/…    link sessions, combined status, combined check
src/components/…          uploader, results table, checker dashboard
tests/                    42 unit tests, no DB required
```

`processRow` and `prepareNumber` are pure functions, which is why the tests
need no database and run in under two seconds.

```bash
npm test
```

---

## Why there is no presence check

This is about the **importer**, which still learns reachability only from real
sends. `/validate` answers the question a different way for both WhatsApp and
Telegram — through the visitor's own linked session, with the risk on them — and
deliberately shares none of this pipeline.

Neither WhatsApp nor Telegram offers a sanctioned way to ask "is this number
registered?". The WhatsApp Business Terms prohibit, through automated means,
scraping or extracting data from their services; tools that do it anyway drive
farms of registered numbers that get banned continuously. Telegram's
`contacts.importContacts` is rate-limited into the ground and burns accounts
the same way.

For a list you collected yourself, you do not need one. Reachability falls out
of sending:

- **WhatsApp** — send your approved template through the Cloud API, then read
  the status webhook. `delivered`/`read` means reachable. `failed` with
  **131026** means undeliverable — store it as `UNDELIVERABLE` with the raw
  code, not as "no WhatsApp", because 131026 also covers stale app versions,
  unaccepted terms, the recipient having blocked you, and authentication
  templates to `+91`.
- **Telegram** — run a bot and send each contact a deep link
  (`t.me/yourbot?start=<token>`). When they tap it you get their `chat_id` tied
  to your token: an actual channel with a consent trail, rather than an
  inference.

The `Reachability` table already models this, with a `providerCode` column for
the raw value and a unique constraint per contact and channel so each number is
learned once.

## Checking WhatsApp registration (`npm run wa:check`)

```bash
npm run wa:check -- --dry-run --limit 20   # show the plan, log in to nothing
npm run wa:check -- --limit 50             # scan the QR, then check 50 contacts
```

This drives a real WhatsApp Web session through `whatsapp-web.js` and calls the
internal contact lookup. **It is not the Cloud API and Meta does not sanction
it** — automated extraction is against the WhatsApp Business Terms, and the
account whose QR you scan carries the whole risk. Use a number you can afford
to lose, not the one your business messages from.

What it does that a naive version of this script does not:

- **An error is never a "no."** A throttled lookup is recorded as nothing at
  all and left for a later run. Writing `UNDELIVERABLE` on error is how these
  scripts silently delete good contacts the moment the account gets limited.
- **It stops itself.** Five consecutive failures ends the run, because pushing
  through a rate limit is how a temporary block becomes a permanent ban.
- **It skips numbers that cannot hold an account.** Landlines and the rest of
  `NEVER_WHATSAPP` are never looked up — fewer lookups, less exposure.
- **It resumes.** Answers are kept for 90 days, so an interrupted run is just
  re-run. `--recheck` forces a fresh pass.
- **Jittered delays**, default ~10s. Slow is the point.

Results land in `Reachability` with `providerCode` `wweb:registered` /
`wweb:not_registered`, so probe rows stay distinguishable from real Cloud API
delivery facts. Note what the answer does *not* tell you: a recycled number can
be registered on WhatsApp and belong to someone who never consented to hear
from you. `ConsentRecord` still points at the original person.

## Stage 2

1. **Twilio Lookup pass** — `GET /v2/PhoneNumbers/{e164}?Fields=line_type_intelligence`
   over accepted contacts, refining `Contact.lineType` and filling `carrierName`.
   The offline guess already catches obvious landlines for free; Twilio adds the
   carrier, catches recycled numbers, and splits `VOIP` into fixed/non-fixed.
   Query `lineCheckedAt: null` to find contacts it has not seen yet.
2. **WhatsApp Cloud API sender** — template sends plus a webhook receiver
   writing `Reachability`.
3. **Telegram bot** — deep-link opt-in capture.
4. **Auth and real tenancy** — replace `src/lib/account.ts`, which currently
   returns a single default account.

## Hosting

`/validate` is not cheap to host and cannot be static. Every linked visitor holds
a live session — a headless Chromium for WhatsApp, an MTProto connection for
Telegram — so it needs a real box with real RAM, and cannot run on Vercel,
Cloudflare Workers, or anything serverless. Sessions are in-memory, so it also
cannot be load-balanced across instances without sticky routing.

The importer's own needs are unchanged and all have free tiers:

| Piece | Free option | Where it runs out |
| --- | --- | --- |
| Next.js app | Vercel Hobby, Cloudflare Workers | Hobby forbids commercial use; neither can host `/validate` |
| Postgres | Neon, Supabase | ~0.5 GB, and Neon sleeps when idle |
| Redis (BullMQ) | Upstash | Command count, not size — BullMQ polls |
| Worker process | Fly.io, Render, Oracle Cloud always-free | Render's free tier sleeps |

With Upstash, give BullMQ `maxRetriesPerRequest: null` in `src/lib/queue.ts` or
it will throw on the first idle reconnect.

If you run both, the simplest shape is one always-on box (Fly.io or an Oracle
always-free VM) carrying the Next.js app, the worker and the sessions, with
Postgres and Redis on their managed free tiers.

---

## Before production

- `src/lib/account.ts` is a stub. Nothing is authenticated yet.
- Uploads are written to `./uploads` and deleted after import. On more than one
  instance, move them to S3/R2.
- Add a retention job — consent records and raw rows should not live forever.
- Add opt-out ingestion (the `optedOut` flag is honored on import but nothing
  sets it yet).
