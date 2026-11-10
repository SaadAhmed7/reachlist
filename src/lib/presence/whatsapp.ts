/**
 * WhatsApp presence via a visitor's own linked WhatsApp account.
 *
 * This speaks the WhatsApp multi-device protocol directly over a WebSocket
 * (Baileys). It replaced a whatsapp-web.js driver that ran a full Chromium per
 * account, and the reason was capacity: each browser held ~840MB, so a 7.5GB
 * host died at four linked accounts. A socket holds ~50MB, so the same host
 * takes dozens. Nothing in the pool, the batch runner or the UI changed —
 * this file is written against the same `Driver` contract as before.
 *
 * Two things here are deliberate and easy to "simplify" into bugs.
 *
 * 1. `lookup` does NOT call Baileys' `onWhatsApp()`. That helper ends with
 *    `.filter(a => !!a.contact)`, which drops every number that came back
 *    *negative* — so a number that is not on WhatsApp becomes indistinguishable
 *    from one the server never answered for. This driver runs the USync query
 *    itself, one layer down, where `contact` is still an explicit true/false.
 *
 * 2. A number missing from the response is reported as nothing at all, not as
 *    a negative. The runner records UNKNOWN for an absent answer and keeps the
 *    row; claiming "not registered" on silence would quietly delete a client's
 *    numbers, which is a mistake this project has already made once.
 */
import type { Driver, LookupAnswer, Session } from "./types";

export type USyncEntry = { id?: string; contact?: unknown };

type WASocket = {
  ev: { on(event: string, cb: (arg: never) => void): void };
  executeUSyncQuery(q: unknown): Promise<{ list?: USyncEntry[] } | undefined>;
  logout(): Promise<void>;
  end(err?: Error): void;
  user?: { id?: string };
};

/**
 * Driver-owned state for one session: whether a close was asked for, and how
 * many times this socket has reconnected without reaching `open`.
 */
type Scratch = { closing: boolean; restarts: number };

/**
 * How many reconnects before giving up and asking for a fresh scan.
 *
 * A successful link needs exactly one (the 515 after pairing). More than a
 * handful means something is actually wrong, and silently retrying for ever
 * would leave the operator watching a spinner with nothing to act on.
 */
const MAX_RESTARTS = 5;

/** Backoff for an ordinary drop. The post-pairing 515 bypasses this. */
const RECONNECT_WAIT_MS = 2_000;

/** Baileys logs at debug by default and is extremely chatty. */
const SILENT_LOGGER = {
  level: "silent",
  child: () => SILENT_LOGGER,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

/** Env override with a sane floor; a zero or junk value falls back. */
const tune = (v: string | undefined, fallback: number, min = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/** Where one account's credentials live. Same layout the old driver used, so
 *  the auth volume and its backups do not need rethinking. */
const authDir = (providerId: string) => `.wwebjs_auth/baileys/${providerId}`;

/** Digits only, for comparing two phone numbers written differently. */
const digits = (s: string) => s.replace(/\D/g, "");

/**
 * The phone number out of a jid.
 *
 * A jid can carry a device suffix — `923001234567:12@s.whatsapp.net` is device
 * 12 of that account — and the domain can be `@s.whatsapp.net` or `@c.us`.
 * Stripping non-digits alone would fold the `12` into the number and the entry
 * would then match nothing, turning a real answer into a silent UNKNOWN.
 */
const jidNumber = (jid: string) => digits(jid.split("@")[0].split(":")[0]);

/**
 * Turn a USync response into answers, keyed by the numbers we asked about.
 *
 * Pure, and exported, because this is the one place where "not on WhatsApp"
 * and "no answer" could be confused, and that confusion has already cost this
 * project a client's uploaded list once. The rules:
 *
 *   - entry says `contact: true`  -> found
 *   - entry says `contact: false` -> genuinely not registered
 *   - no entry at all             -> absent from the result, so UNKNOWN
 *
 * The third case is why Baileys' own `onWhatsApp()` is unusable here: it
 * filters negatives out of the list, collapsing cases two and three into one.
 */
export function readUSyncAnswers(
  list: readonly USyncEntry[], e164s: readonly string[],
): Record<string, LookupAnswer> {
  // Index by digits so answers survive whatever decoration the server puts on
  // the jid it echoes back.
  const answered = new Map<string, boolean>();
  for (const entry of list) {
    if (!entry?.id || typeof entry.contact !== "boolean") continue;
    answered.set(jidNumber(entry.id), entry.contact);
  }

  const out: Record<string, LookupAnswer> = {};
  for (const e164 of e164s) {
    const found = answered.get(digits(e164));
    // Deliberately omitted, not defaulted: the runner records UNKNOWN for a
    // missing answer and keeps the row.
    if (typeof found === "boolean") out[e164] = { found };
  }
  return out;
}

export const whatsapp: Driver = {
  channel: "whatsapp",
  label: "WhatsApp",
  /**
   * One USync query carries many numbers, where the old browser driver could
   * only ask about one at a time. This is the single biggest throughput lever
   * in the system: run time is roughly
   * `numbers / batchSize / accounts * per-call`.
   *
   * 20 is a deliberately conservative starting point. WhatsApp does not
   * document a ceiling on users per query, and the failure mode for guessing
   * too high is a rate limit on a real client's account, so this is tuned up
   * from measurements rather than down from optimism.
   */
  batchSize: tune(process.env.WHATSAPP_BATCH_SIZE, 20, 1),
  /**
   * No artificial delay by default — the operator has accepted the blocking
   * risk. Set WHATSAPP_DELAY_MS to reintroduce pacing if accounts start
   * dropping; the pool still backs off on its own after repeated failures.
   */
  delayMs: tune(process.env.WHATSAPP_DELAY_MS, 0),
  maxLookups: tune(process.env.WHATSAPP_MAX_LOOKUPS, 200),
  foundReason: "Registered on WhatsApp",
  notFoundReason: "No WhatsApp account",

  async open(session: Session) {
    // Imported here, not at module scope, so merely rendering a page does not
    // pull the protocol stack and its crypto into the server bundle.
    const baileys = await import("@whiskeysockets/baileys");
    const makeWASocket = baileys.default ?? baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(authDir(session.id));

    // Announcing a current version matters: WhatsApp rejects a client that
    // claims a build it has retired, and the failure reads as a login loop.
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const scratch = (session.scratch ??= { closing: false, restarts: 0 }) as Scratch;
    scratch.closing = false;
    scratch.restarts = 0;

    /**
     * Build a socket and wire it up. Called again on a reconnect, because the
     * protocol requires it — see the 515 case below.
     */
    const connect = (): void => {
      const sock = makeWASocket({
        auth: state,
        ...(version ? { version } : {}),
        // Shows up as a named linked device in the client's phone, so a human
        // can see what this is and unlink it deliberately.
        browser: Browsers.appropriate("Desktop"),
        // We never read message history; syncing it would cost memory and time
        // for data this product has no use for and should not hold.
        syncFullHistory: false,
        markOnlineOnConnect: false,
        // Baileys logs at debug by default and is extremely chatty.
        logger: SILENT_LOGGER as never,
      }) as unknown as WASocket;

      session.handle = sock;

      sock.ev.on("creds.update", (() => void saveCreds()) as never);

      sock.ev.on("connection.update", ((u: {
        connection?: string;
        qr?: string;
        lastDisconnect?: { error?: { output?: { statusCode?: number } } };
      }) => {
        // A socket we deliberately replaced can still emit; ignore it, or a
        // dead one will overwrite the status of the live one.
        if (session.handle !== sock) return;

        if (u.qr) {
          session.qr = u.qr;
          session.status = "qr";
        }

        if (u.connection === "open") {
          session.status = "ready";
          session.qr = null;
          scratch.restarts = 0;
          const me = sock.user?.id ? jidNumber(sock.user.id) : "";
          session.me = me ? `+${me}` : null;
          // Credentials persist to disk under the provider id, so only the
          // identity is worth writing back.
          void session.persist?.({ identifier: session.me });
          return;
        }

        if (u.connection !== "close") return;
        // close() asked for this one; do not fight it by reconnecting.
        if (scratch.closing) { session.status = "closed"; session.qr = null; return; }

        const code = u.lastDisconnect?.error?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          session.status = "failed";
          session.error = "This account was unlinked from the phone. Click Link and scan the code again.";
          return;
        }

        if (code === DisconnectReason.connectionReplaced) {
          session.status = "failed";
          session.error = "Another session took over this account. Link it again, and keep only one copy running.";
          return;
        }

        if (code === DisconnectReason.badSession) {
          session.status = "failed";
          session.error = "The saved login for this account is damaged. Click Link and scan the code again.";
          return;
        }

        /**
         * Reconnect, rather than reporting a closed session.
         *
         * This is not an optimisation, it is how the protocol works. After a
         * QR is scanned successfully WhatsApp *always* drops the socket with
         * 515 `restartRequired`, and the client is expected to reconnect
         * immediately using the credentials it just saved. Only then does the
         * link finish.
         *
         * Reporting "closed" here instead — as this driver first did — leaves
         * the phone sitting on "Logging in... keep WhatsApp open on both
         * devices" for ever, because from its side the device paired and then
         * never came back. The account can never be linked at all.
         *
         * 428/408/503 are ordinary drops and get the same treatment, with a
         * bounded number of attempts so a genuinely dead account eventually
         * surfaces instead of reconnecting in a loop.
         */
        if (scratch.restarts >= MAX_RESTARTS) {
          session.status = "closed";
          session.qr = null;
          session.error = "WhatsApp kept dropping the connection. Click Link and scan the code again.";
          return;
        }

        scratch.restarts += 1;
        session.status = "starting";
        session.startedAt = Date.now();
        session.qr = null;
        // 515 right after pairing is expected and wants no delay; a repeated
        // drop backs off so a flapping account does not spin.
        const wait = code === DisconnectReason.restartRequired ? 0 : RECONNECT_WAIT_MS;
        setTimeout(() => { if (!scratch.closing && session.handle === sock) connect(); }, wait);
      }) as never);
    };

    connect();
  },

  async close(session: Session, logout: boolean) {
    const sock = session.handle as WASocket | null;
    // Set before the socket is torn down: the close fires a connection.update,
    // and without this the handler would treat our own shutdown as a drop and
    // reconnect the session we are trying to close.
    const scratch = (session.scratch ??= { closing: false, restarts: 0 }) as Scratch;
    scratch.closing = true;
    session.handle = null;
    // `closeSession` sets this too, but a driver that is called directly must
    // not leave a session claiming to be mid-connect after it has been shut.
    session.status = "closed";
    session.qr = null;
    if (!sock) return;
    // logout unlinks the device on the user's phone; end only drops our socket.
    if (logout) {
      await sock.logout().catch(() => {});
      const { rm } = await import("node:fs/promises");
      await rm(authDir(session.id), { recursive: true, force: true }).catch(() => {});
    }
    try { sock.end(undefined); } catch { /* already gone */ }
  },

  /**
   * The socket died but the credentials on disk are fine. The cure is a
   * restart, not a re-scan — and certainly not disabling the account.
   */
  recoverable(err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    const code = (err as { output?: { statusCode?: number } })?.output?.statusCode;
    if (code === 428 || code === 408 || code === 515 || code === 503) return true;
    return /Connection Closed|Connection Terminated|Timed Out|socket hang up|ECONNRESET|EPIPE|not open|lost connection/i.test(m);
  },

  // WhatsApp exposes no last-seen to this query, so `lastSeen` stays absent
  // rather than being faked as "hidden".
  /**
   * Ask the server about a whole chunk of numbers in one USync query.
   *
   * Only numbers the server actually answered for appear in the returned map.
   * An omission is not a negative: the runner turns a missing answer into
   * UNKNOWN and keeps the row, which is the only safe reading when we cannot
   * tell "no WhatsApp account" from "no reply".
   */
  async lookup(session: Session, e164s: string[]) {
    const sock = session.handle as WASocket;
    const { USyncQuery, USyncUser } = await import("@whiskeysockets/baileys");

    const query = new USyncQuery().withContactProtocol();
    for (const e164 of e164s) {
      query.withUser(new USyncUser().withPhone(`+${digits(e164)}`));
    }

    const result = await sock.executeUSyncQuery(query);
    // A non-result IQ parses to undefined. Throwing is right: the runner
    // records UNKNOWN for the chunk, and the pool decides about the account.
    if (!result?.list) throw new Error("WhatsApp returned no result for this batch.");

    return readUSyncAnswers(result.list, e164s);
  },
};
