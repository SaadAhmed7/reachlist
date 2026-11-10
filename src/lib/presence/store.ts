/**
 * Session store.
 *
 * Every session is a real client process or connection holding a logged-in
 * account open, which is why sessions are reaped. Opening, closing and reaping
 * live here, once, so WhatsApp and Telegram cannot drift apart on the thing
 * that actually matters. Running the lookups themselves is batch.ts's job.
 */
import type { Channel, Driver, Session } from "./types";

/** Idle sessions are killed — each is holding a logged-in account open. */
const IDLE_MS = 15 * 60_000;
const REAP_EVERY_MS = 60_000;

// Next.js hot-reloads modules in dev; a plain module-level Map would leak a
// client per edit. Hang it off globalThis so reloads reuse the same store.
const g = globalThis as unknown as {
  __presenceSessions?: Map<string, Session>;
  __presenceReaper?: NodeJS.Timeout;
};
const sessions: Map<string, Session> = (g.__presenceSessions ??= new Map());

const key = (channel: Channel, id: string) => `${channel}:${id}`;



export function peek(channel: Channel, id: string): Session | undefined {
  const s = sessions.get(key(channel, id));
  if (s) s.lastTouched = Date.now();
  return s;
}

export type OpenOptions = {
  /** Saved credentials so the driver can resume without a QR. */
  restoreData?: string | null;
  persist?: Session["persist"];
  /** Operator-owned sessions are the service itself and must not be reaped. */
  pinned?: boolean;
};

export async function openSession(
  driver: Driver, id: string, opts: OpenOptions = {},
): Promise<Session> {
  const k = key(driver.channel, id);
  const existing = sessions.get(k);
  if (existing && existing.status !== "closed" && existing.status !== "failed") {
    existing.lastTouched = Date.now();
    return existing;
  }

  const session: Session = {
    id, channel: driver.channel, status: "starting", qr: null, error: null,
    me: null, handle: null, scratch: null, job: null, lastTouched: Date.now(),
    // Set before open() runs: the driver reads these on its first tick, and
    // assigning them after openSession() resolved was a race.
    restoreData: opts.restoreData ?? null,
    persist: opts.persist,
    pinned: opts.pinned ?? false,
    startedAt: Date.now(),
  };
  sessions.set(k, session);

  driver.open(session).catch((e: unknown) => {
    session.status = "failed";
    session.error = e instanceof Error ? e.message : String(e);
  });

  return session;
}

/** Teardown must not be able to block; a wedged client is exactly what we are
 *  trying to get rid of. */
const CLOSE_TIMEOUT_MS = 8_000;

export async function closeSession(
  driver: Driver, id: string, logout: boolean,
): Promise<void> {
  const k = key(driver.channel, id);
  const s = sessions.get(k);
  if (!s) return;

  s.status = "closed";
  if (s.job) s.job.running = false;
  // Drop it from the map first, so a slow teardown can never stop a rebuild
  // from starting — the old client is then just garbage finishing on its own.
  sessions.delete(k);

  // A disconnect on a client whose connect() never resolved hangs for ever,
  // and a hanging promise is not a rejection, so catch alone does not save us.
  const bounded = (p: Promise<unknown> | undefined) =>
    Promise.race([
      Promise.resolve(p).catch(() => {}),
      new Promise((r) => setTimeout(r, CLOSE_TIMEOUT_MS)),
    ]);

  await bounded(driver.finish?.(s));
  await bounded(driver.close(s, logout));
}

// Reaping has to happen after closeSession exists, and needs no driver for the
// common case — a driver is looked up lazily to avoid an import cycle.
g.__presenceReaper ??= setInterval(() => {
  // Bring disconnected providers back on our own time. Recovery is otherwise
  // lazy, which means the first user request after a crash is the one that
  // discovers it — they get refunded, but they still got a failure.
  void import("./pool").then(({ warmPool }) => warmPool()).catch(() => {});

  const cutoff = Date.now() - IDLE_MS;
  for (const s of sessions.values()) {
    // A ready provider account must stay connected; reaping it would silently
    // take the service offline between bursts of traffic.
    if (s.pinned && s.status === "ready") continue;
    if (s.lastTouched < cutoff && !s.job?.running) {
      void import("./index").then(({ driverFor }) =>
        closeSession(driverFor(s.channel), s.id, false),
      );
    }
  }
}, REAP_EVERY_MS).unref?.() as unknown as NodeJS.Timeout;
