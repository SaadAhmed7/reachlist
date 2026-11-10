/**
 * The operator's pool of WhatsApp/Telegram accounts.
 *
 * Every user's lookups run through these, which is the whole risk of this
 * design: a ban takes out everyone at once, not one visitor. Two things follow.
 *
 *   - More than one account per channel is supported, and work is spread across
 *     them least-used-first, so no single account carries the whole load.
 *   - An account can be disabled without being deleted, which is the usual
 *     response to one that starts erroring.
 */
import type { $Enums } from "@prisma/client";
import { prisma } from "../db";
import type { LastSeen } from "../validate-list";
import { greenApiCheck, greenApiEnabled } from "./greenapi";
import { driverFor } from "./index";
import { closeSession, openSession, peek } from "./store";
import type { Channel, Driver, Session } from "./types";

/** Prisma's Channel enum -> the driver key. */
const KEY: Record<$Enums.Channel, Channel | null> = {
  WHATSAPP: "whatsapp",
  TELEGRAM: "telegram",
  SMS: null,
};

/**
 * One call at a time per provider, with the pacing enforced here rather than by
 * the caller.
 *
 * This matters much more now that a batch can be any size: two runs against the
 * same account used to pace themselves independently and so hit it at twice the
 * intended rate. Chaining every lookup for a provider through one promise means
 * the budget is shared no matter how many jobs exist.
 */
const store = globalThis as unknown as {
  __providerChains?: Map<string, Promise<unknown>>;
  __providerCooldown?: Map<string, number>;
};
const chains = (store.__providerChains ??= new Map<string, Promise<unknown>>());

/**
 * When each provider may be used again, as an epoch ms.
 *
 * With fixed pacing removed, this is the rate limiter: a service that says
 * "wait 42 seconds" is obeyed exactly, and the account keeps working after.
 */
const cooldowns = (store.__providerCooldown ??= new Map<string, number>());

/** Park a provider until `seconds` from now. */
export function coolDown(providerId: string, seconds: number): void {
  cooldowns.set(providerId, Date.now() + seconds * 1000);
}

/** Seconds remaining before this provider may be used, 0 if it is free. */
export function cooldownRemaining(providerId: string): number {
  const until = cooldowns.get(providerId);
  if (!until) return 0;
  const left = Math.ceil((until - Date.now()) / 1000);
  return left > 0 ? left : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Jittered: a fixed interval is both rude and trivially recognizable. */
const paced = (base: number) => sleep(base + Math.floor(Math.random() * base * 0.5));

function serialize<T>(providerId: string, delayMs: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(providerId) ?? Promise.resolve();
  const next = prev.then(async () => {
    // Serve out any cooldown the service itself asked for before trying again.
    const wait = cooldownRemaining(providerId);
    if (wait > 0) await sleep(wait * 1000);
    try {
      return await fn();
    } finally {
      // delayMs is 0 by default; kept so pacing can be dialled back in.
      if (delayMs > 0) await paced(delayMs);
    }
  });
  // Swallow on the stored chain only, so one failure cannot poison the queue
  // while the caller still sees its own error.
  chains.set(providerId, next.then(() => {}, () => {}));
  return next;
}

/** How long a cold session is given to finish booting before the pool
  * gives up on it. Both channels now open a socket
  * rather than a browser, so a reconnect is seconds rather than the ~15s a
  * Chromium start used to need. The margin is left wide on purpose: it only
  * costs anything when a session is genuinely stuck, and giving up too early
  * refunds an entire run. */
const BOOT_WAIT_MS = 45_000;

export class NoProvider extends Error {
  constructor(channel: string) {
    super(`No ${channel} account is connected. An administrator must link one.`);
  }
}

/** Persist what a driver learns, so a restart does not need a fresh QR. */
function persistFor(providerId: string) {
  return async (patch: { identifier?: string | null; sessionData?: string | null }) => {
    await prisma.providerAccount.update({
      where: { id: providerId },
      data: {
        ...(patch.identifier !== undefined ? { identifier: patch.identifier } : {}),
        ...(patch.sessionData !== undefined ? { sessionData: patch.sessionData } : {}),
        status: "READY",
        lastConnectedAt: new Date(),
        lastError: null,
      },
    }).catch(() => { /* row may have been deleted mid-link */ });
  };
}

/** How long an unscanned QR is kept before the attempt is abandoned. */
const LINK_WINDOW_MS = 4 * 60_000;

/** How long a connect may sit in "starting" before it is treated as hung. */
const STARTING_TIMEOUT_MS = 45_000;

/**
 * Begin linking one provider. Returns at once; poll the row for its QR.
 *
 * Any previous attempt is torn down first. Reusing a half-finished session was
 * how an expired QR could sit on screen for ever with no way to restart it
 * except deleting the account.
 */
export async function linkProvider(providerId: string): Promise<Session> {
  const row = await prisma.providerAccount.findUniqueOrThrow({ where: { id: providerId } });
  const channel = KEY[row.channel];
  if (!channel) throw new Error(`${row.channel} cannot be linked.`);

  const driver = driverFor(channel);
  // Drop whatever is there — but keep the credentials, so this is a retry and
  // not a logout.
  await closeSession(driver, providerId, false).catch(() => {});

  await prisma.providerAccount.update({
    where: { id: providerId }, data: { status: "LINKING", lastError: null },
  });

  const session = await openSession(driver, providerId, {
    restoreData: row.sessionData,
    persist: persistFor(providerId),
    pinned: true,
  });
  session.linkingSince = Date.now();
  return session;
}

/**
 * Give up on a link nobody completed.
 *
 * Without this a provider sits on LINKING for ever: the in-memory session is
 * eventually gone, the database still claims it is mid-link, and the admin
 * sees a state they cannot get out of.
 */
export async function expireStaleLink(providerId: string): Promise<boolean> {
  const row = await prisma.providerAccount.findUnique({ where: { id: providerId } });
  if (!row || row.status !== "LINKING") return false;

  const channel = KEY[row.channel];
  const live = channel ? peek(channel, providerId) : undefined;

  // Still showing a fresh QR? Leave it alone.
  if (live && live.status !== "closed" && live.status !== "failed") {
    const since = live.linkingSince ?? 0;
    if (Date.now() - since < LINK_WINDOW_MS) return false;
  }

  /**
   * Keep the reason the session actually gave.
   *
   * A link can end for two very different reasons: nobody scanned the code, or
   * the login was attempted and refused — a 2FA password on the account, a
   * revoked token, a connection that never reached Telegram. The driver puts
   * that real reason on the session. Overwriting it with "not scanned in time"
   * (as this did) tells the operator they were too slow when they were not,
   * and sends them round the same failing loop for ever.
   *
   * Only claim a timeout when there is no better explanation to give.
   */
  const reported = live?.error?.trim();
  const reason = reported && reported.length > 0
    ? reported
    : "The QR code was not scanned in time. Click Link to try again.";

  if (channel) await closeSession(driverFor(channel), providerId, false).catch(() => {});
  await prisma.providerAccount.update({
    where: { id: providerId },
    data: {
      status: row.sessionData ? "DISCONNECTED" : "NEW",
      lastError: reason,
    },
  });
  return true;
}

/** Live session for a provider, resuming from stored credentials if needed. */
async function ensureSession(providerId: string): Promise<Session | null> {
  const row = await prisma.providerAccount.findUnique({ where: { id: providerId } });
  if (!row || !row.enabled) return null;
  const channel = KEY[row.channel];
  if (!channel) return null;

  const existing = peek(channel, providerId);
  if (existing?.status === "ready") return existing;

  if (existing?.status === "qr") {
    // Mid-link; leave the QR alone. An admin-initiated link sits at LINKING,
    // so a row still marked READY here is one whose saved login died and came
    // back as a QR — correct the row rather than let it keep claiming to be
    // connected while every lookup against it is refunded.
    if (row.status === "READY") await markSignedOut(providerId);
    return null;
  }

  if (existing?.status === "starting") {
    // A connect that never settled — the usual cause is the network being gone
    // when it was attempted. Without this the stuck session is skipped for
    // ever and the provider can never come back on its own.
    if (Date.now() - (existing.startedAt ?? 0) < STARTING_TIMEOUT_MS) return null;
    await closeSession(driverFor(channel), providerId, false).catch(() => {});
  }

  // WhatsApp resumes from its own on-disk auth, so it needs no sessionData.
  if (!row.sessionData && row.channel === "TELEGRAM") return null;
  if (row.status === "NEW") return null;

  // Clear any corpse so openSession does not hand the same one back.
  if (peek(channel, providerId)) {
    await closeSession(driverFor(channel), providerId, false).catch(() => {});
  }

  const session = await openSession(driverFor(channel), providerId, {
    restoreData: row.sessionData,
    persist: persistFor(providerId),
    pinned: true,
  });

  // A restore that lands on a QR means the stored login is dead — the phone
  // unlinked it, or it simply expired.
  if (session.status === "qr" && row.status === "READY") await markSignedOut(providerId);

  return session.status === "ready" ? session : null;
}

/**
 * Record that an account needs scanning again.
 *
 * Leaving the row at READY is how the dashboard ends up telling a client that
 * accounts are connected while every lookup against them is refunded.
 */
async function markSignedOut(providerId: string): Promise<void> {
  await prisma.providerAccount.update({
    where: { id: providerId },
    data: {
      status: "DISCONNECTED",
      lastError: "This account was signed out. Click Link and scan the code again.",
    },
  }).catch(() => { /* row may have been deleted */ });
}

/**
 * Reconnect every enabled provider that has credentials.
 *
 * Run on a timer, not just on demand: a provider that crashed at 3am should be
 * back before the first customer of the day pays to find out it is down.
 * `ensureSession` ignores anything mid-link, so this never disturbs a QR.
 */
export async function warmPool(): Promise<void> {
  const rows = await prisma.providerAccount.findMany({
    where: { enabled: true, status: { in: ["READY", "DISCONNECTED"] } },
    select: { id: true },
  });
  await Promise.all(rows.map((r) => ensureSession(r.id).catch(() => null)));
}

/**
 * Pick the least-used ready account for a channel.
 *
 * Least-used rather than random so load actually levels out; a random pick
 * leaves one account carrying a disproportionate share over a long run.
 */
export async function acquire(channel: $Enums.Channel): Promise<{ id: string; session: Session }> {
  const key = KEY[channel];
  if (!key) throw new NoProvider(channel);

  const rows = await prisma.providerAccount.findMany({
    where: { channel, enabled: true, status: { in: ["READY", "DISCONNECTED"] } },
    orderBy: [{ lookupCount: "asc" }, { lastUsedAt: "asc" }],
    select: { id: true },
  });
  if (rows.length === 0) throw new NoProvider(channel);

  // A session reconnecting after a restart is seconds from ready, so a run
  // started just after one used to fail every row on a provider that was about
  // to work. Wait for a booting session rather than declaring none.
  const deadline = Date.now() + BOOT_WAIT_MS;
  for (;;) {
    let booting = false;

    for (const row of rows) {
      const session = await ensureSession(row.id).catch(() => null);
      if (session?.status === "ready") return { id: row.id, session };
      const live = peek(key, row.id);
      if (live?.status === "starting" || live?.status === "qr") booting = true;
    }

    // Nothing usable and nothing on its way, or we have waited long enough.
    if (!booting || Date.now() > deadline) throw new NoProvider(channel);
    await sleep(2_000);
  }
}

/**
 * GREEN-API path: a plain HTTP check per number, serialized through the same
 * gate so their per-second limit is respected and two batches cannot double up.
 *
 * `raw` from the first few responses is kept on the result so the undocumented
 * last-seen question can be settled by looking at what actually arrives.
 */
async function greenLookup(
  channel: $Enums.Channel, e164s: string[],
): Promise<ManyResult> {
  const key = `greenapi:${channel}`;
  const answers: Record<string, { found: boolean; lastSeen?: LastSeen }> = {};

  for (const e164 of e164s) {
    const r = await serialize(key, 0, () => greenApiCheck(channel, e164));
    answers[e164] = { found: r.found, ...(r.lastSeen ? { lastSeen: r.lastSeen } : {}) };
  }
  return { answers, providerId: key };
}

/**
 * Every provider for a channel that can take work right now.
 *
 * The batch runner uses this to spin up one worker per account: with ten
 * linked accounts, ten numbers are in flight instead of one. A session only
 * handles a single call at a time — the per-provider gate serialises them —
 * so parallelism comes from the number of accounts, which
 * is exactly why linking more of them shortens a run.
 */
export async function readyProviders(
  channel: $Enums.Channel,
  /**
   * Wait for a session that is still booting. On by default, because a run
   * that gives up on a cold pool refunds every row. Off for callers that only
   * want to count accounts — pricing an upload must not block while a session
   * reconnects.
   */
  { wait = true }: { wait?: boolean } = {},
): Promise<string[]> {
  const key = KEY[channel];
  if (!key) return [];

  // GREEN-API, when configured, is one more worker alongside the linked
  // accounts rather than a replacement for them. It used to stand in for the
  // whole pool, which meant an expired quota took the channel down while
  // healthy linked accounts sat idle.
  const hosted = greenApiEnabled(channel) ? [`greenapi:${channel}`] : [];

  const rows = await prisma.providerAccount.findMany({
    where: { channel, enabled: true, status: { in: ["READY", "DISCONNECTED"] } },
    orderBy: [{ lookupCount: "asc" }, { lastUsedAt: "asc" }],
    select: { id: true },
  });

  // Same tolerance as `acquire`: a batch started just after a restart would
  // otherwise see an empty pool and refund every row on accounts that were
  // seconds from ready.
  const deadline = Date.now() + BOOT_WAIT_MS;
  for (;;) {
    const usable: string[] = [];
    let booting = false;

    for (const row of rows) {
      const session = await ensureSession(row.id).catch(() => null);
      if (session?.status === "ready") { usable.push(row.id); continue; }
      const live = peek(key, row.id);
      if (live?.status === "starting" || live?.status === "qr") booting = true;
    }

    // Go as soon as anything is usable; only an empty pool is worth waiting on.
    if (usable.length > 0) return [...usable, ...hosted];
    if (!wait || !booting || Date.now() > deadline) return hosted;
    await sleep(2_000);
  }
}

/** Look numbers up on one named provider, bypassing the rotation. */
export async function lookupManyOn(
  providerId: string, channel: $Enums.Channel, e164s: string[],
): Promise<ManyResult> {
  if (providerId.startsWith("greenapi:")) return greenLookup(channel, e164s);

  const key = KEY[channel];
  const session = key ? peek(key, providerId) : undefined;
  // Fall back to the rotation if this account has gone away mid-run.
  if (!session || session.status !== "ready") return lookupMany(channel, e164s);

  const driver = driverFor(key!);
  try {
    const answers = await serialize(providerId, driver.delayMs, () => driver.lookup(session, e164s));
    await prisma.providerAccount.update({
      where: { id: providerId },
      data: { lastUsedAt: new Date(), lookupCount: { increment: e164s.length } },
    }).catch(() => {});
    await driver.finish?.(session).catch(() => {});
    return { answers, providerId };
  } catch (err) {
    await noteProviderFailure(providerId, driver, err);
    throw err;
  }
}

export type OneResult = { found: boolean; lastSeen?: LastSeen; providerId: string };
export type ManyResult = {
  answers: Record<string, { found: boolean; lastSeen?: LastSeen }>;
  providerId: string;
};

/**
 * One lookup, for the metered user panel.
 *
 * Throwing is meaningful: the caller refunds on it. A thrown lookup is never
 * turned into a "not registered" — that is the same rule the batch runner
 * follows, and the reason a throttled account cannot silently destroy a list.
 */
export async function lookupOne(
  channel: $Enums.Channel, e164: string,
): Promise<OneResult> {
  const r = await lookupMany(channel, [e164]);
  const a = r.answers[e164];
  return { found: a?.found === true, lastSeen: a?.lastSeen, providerId: r.providerId };
}

/**
 * Ask about several numbers in one provider call.
 *
 * This is where the speed is. Telegram's importContacts takes a whole batch at
 * once, so asking one number at a time was paying a full rate-limit interval
 * per number for a call that could have carried five. Fewer calls is both
 * faster *and* gentler on the account, which is the rare case where the safe
 * change and the fast change are the same change.
 */
export async function lookupMany(
  channel: $Enums.Channel, e164s: string[],
): Promise<ManyResult> {
  // A channel pointed at GREEN-API has no session to acquire: they hold the
  // logged-in account, so none of the QR or credential machinery applies.
  // Linked accounts come first — they are the ones the client pays nothing for
  // and the ones they add more of to go faster. GREEN-API catches the case
  // where none is connected.
  const hosted = greenApiEnabled(channel);
  let id: string, session: Session;
  try {
    ({ id, session } = await acquire(channel));
  } catch (err) {
    if (hosted && err instanceof NoProvider) return greenLookup(channel, e164s);
    throw err;
  }

  const driver = driverFor(KEY[channel]!);

  try {
    // Pacing lives in the gate, so concurrent batches share one budget.
    const answers = await serialize(id, driver.delayMs, () => driver.lookup(session, e164s));

    await prisma.providerAccount.update({
      where: { id },
      data: { lastUsedAt: new Date(), lookupCount: { increment: e164s.length } },
    }).catch(() => {});

    // Telegram imports contacts to answer; clear them straight away rather than
    // letting one user's lookup linger in the operator's address book.
    await driver.finish?.(session).catch(() => {});

    return { answers, providerId: id };
  } catch (err) {
    await noteProviderFailure(id, driver, err);
    throw err;
  }
}

/** Record what a failure means for the account, and park or rebuild it. */
async function noteProviderFailure(
  id: string, driver: Driver, err: unknown,
): Promise<void> {
  {
    const msg = err instanceof Error ? err.message : String(err);
    const fatal = driver.fatal?.(err);
    const recoverable = driver.recoverable?.(err) ?? false;

    // A rate limit is an instruction, not a fault: park the account for
    // exactly as long as asked and keep it in rotation. Disabling it here was
    // what turned a 30-second limit into an account out of service.
    const cool = driver.cooldown?.(err) ?? null;
    if (cool !== null && cool > 0) {
      coolDown(id, cool);
      await prisma.providerAccount.update({
        where: { id },
        data: { lastError: `Rate limited; waiting ${cool}s before using this account again.` },
      }).catch(() => {});
      throw err;
    }

    if (recoverable) {
      // The browser died under a live session. Tear it down and mark the row
      // DISCONNECTED so the next acquire rebuilds it from stored credentials —
      // leaving it READY would keep handing work to a dead process.
      await closeSession(driver, id, false).catch(() => {});
      await prisma.providerAccount.update({
        where: { id },
        data: { status: "DISCONNECTED", lastError: `Restarting after: ${msg.slice(0, 300)}` },
      }).catch(() => {});
    } else {
      await prisma.providerAccount.update({
        where: { id },
        data: {
          lastError: msg.slice(0, 500),
          // A rate-limit is not a dead account, but it must leave rotation now.
          ...(fatal ? { enabled: false, status: "FAILED" as const } : {}),
        },
      }).catch(() => {});
    }
    throw err;
  }
}

/** Unlink a provider, optionally logging it out of the phone as well. */
export async function unlinkProvider(providerId: string, logout: boolean): Promise<void> {
  const row = await prisma.providerAccount.findUnique({ where: { id: providerId } });
  if (!row) return;
  const channel = KEY[row.channel];
  if (channel) await closeSession(driverFor(channel), providerId, logout).catch(() => {});
  await prisma.providerAccount.update({
    where: { id: providerId },
    data: { status: "DISCONNECTED", ...(logout ? { sessionData: null } : {}) },
  });
}

/** Link state for the admin list, merging the DB row with the live session. */
export async function providerStatus(providerId: string) {
  // Reconcile a stale LINKING before reporting, so the admin list cannot show
  // a state that no longer exists.
  await expireStaleLink(providerId).catch(() => {});

  const row = await prisma.providerAccount.findUnique({ where: { id: providerId } });
  if (!row) return null;
  const channel = KEY[row.channel];
  const live = channel ? peek(channel, providerId) : undefined;
  return {
    ...row,
    sessionData: undefined, // never leaves the server
    live: live?.status ?? "none",
    qrRaw: live?.qr ?? null,
    liveError: live?.error ?? null,
  };
}
