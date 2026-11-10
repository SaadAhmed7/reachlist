/**
 * Telegram presence via a visitor's own account (MTProto, not a bot).
 *
 * The Bot API cannot answer "is this number registered" at all — no endpoint
 * exists — so the only route is `contacts.importContacts` on a user account.
 * Two consequences drive everything below.
 *
 * 1. Importing *adds contacts* to the visitor's account. That is a side effect
 *    on their data, so `finish` deletes every contact this created. If a run
 *    dies uncleanly, the tracked ids are still deleted when the session closes.
 *
 * 2. A negative is weaker than WhatsApp's. Telegram lets users set "Who can
 *    find me by my phone number" to "My Contacts", and those accounts simply do
 *    not come back from an import. Not-found therefore means "not found",
 *    never "not on Telegram" — the wording in notFoundReason says so.
 *
 * Login is QR only. gramjs can do phone + SMS code + 2FA password, and this
 * deliberately does not: a website asking for a Telegram password is
 * indistinguishable from a phishing page, and should stay unbuildable here.
 */
import type { LastSeen } from "../validate-list";
import type { Driver, LookupAnswer, Session } from "./types";

type TgClient = {
  connect(): Promise<void>;
  isUserAuthorized(): Promise<boolean>;
  session: { save(): string };
  disconnect(): Promise<void>;
  destroy(): Promise<void>;
  invoke(req: unknown): Promise<unknown>;
  getMe(): Promise<{ phone?: string; username?: string }>;
  signInUserWithQrCode(creds: unknown, params: unknown): Promise<unknown>;
};

type Scratch = {
  /** Contact ids this run created, to be deleted again. */
  imported: unknown[];
  clientSeq: number;
};

const scratchOf = (s: Session): Scratch =>
  (s.scratch ??= { imported: [], clientSeq: 0 }) as Scratch;

/**
 * Optional proxy for the MTProto connection.
 *
 * Telegram is IP-blocked in a number of countries — including Pakistan, where
 * this project's DEFAULT_REGION points. DNS still resolves, so the failure
 * looks like a hang rather than a refusal: TCP 443 to 149.154.x.x simply never
 * completes. When that is the case the API keys are irrelevant; nothing can
 * connect without a route out.
 */
export function telegramProxy() {
  const ip = process.env.TELEGRAM_PROXY_IP;
  const port = Number(process.env.TELEGRAM_PROXY_PORT);
  if (!ip || !Number.isFinite(port) || port <= 0) return undefined;

  const common = {
    ip, port,
    timeout: 10,
    username: process.env.TELEGRAM_PROXY_USER || undefined,
    password: process.env.TELEGRAM_PROXY_PASS || undefined,
  };

  const secret = process.env.TELEGRAM_PROXY_SECRET;
  if (secret) return { ...common, secret, MTProxy: true as const };

  const socks = Number(process.env.TELEGRAM_PROXY_SOCKS);
  if (socks === 4 || socks === 5) return { ...common, socksType: socks as 4 | 5 };

  return undefined;
}

export function telegramConfig(): { apiId: number; apiHash: string } | null {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) return null;
  return { apiId, apiHash };
}

/**
 * Telegram's own status constructors, narrowed to what they actually promise.
 * Anything unrecognized becomes "hidden" rather than being guessed at.
 */
function toLastSeen(status?: { className?: string; wasOnline?: number }): LastSeen {
  switch (status?.className) {
    case "UserStatusOnline": return { kind: "online" };
    case "UserStatusOffline":
      return typeof status.wasOnline === "number"
        ? { kind: "at", at: status.wasOnline }
        : { kind: "hidden" };
    case "UserStatusRecently":  return { kind: "bucket", bucket: "recently" };
    case "UserStatusLastWeek":  return { kind: "bucket", bucket: "week" };
    case "UserStatusLastMonth": return { kind: "bucket", bucket: "month" };
    default: return { kind: "hidden" };
  }
}

/**
 * Is the saved session usable, dead, or did we simply fail to ask?
 *
 * The three answers must stay distinct: only "revoked" justifies throwing
 * credentials away and demanding a new scan.
 */
async function authState(
  client: TgClient, Api: typeof import("telegram").Api,
): Promise<"authorized" | "revoked" | "unreachable"> {
  const REVOKED = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/i;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.invoke(new Api.updates.GetState());
      return "authorized";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (REVOKED.test(msg)) return "revoked";
      // Anything else is a transport problem; give it a moment and retry.
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return "unreachable";
}

/** Telegram's QR payload is a deep link carrying a base64url token. */
function qrUrl(token: Buffer): string {
  const b64 = token.toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `tg://login?token=${b64}`;
}

/** Env override with a sane floor; a zero or junk value falls back. */
const tune = (v: string | undefined, fallback: number, min = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

export const telegram: Driver = {
  channel: "telegram",
  label: "Telegram",
  /** TELEGRAM_BATCH — numbers per importContacts call. Bigger is much faster;
   *  the flood limits count imported contacts, so do not go wild. */
  batchSize: tune(process.env.TELEGRAM_BATCH, 5),
  /**
   * No artificial delay by default. Telegram answers rate pressure with an
   * explicit FLOOD_WAIT, and the pool now honours that instead — reactive
   * pacing from the service rather than a fixed guess from us.
   */
  delayMs: tune(process.env.TELEGRAM_DELAY_MS, 0),
  /**
   * Far lower than WhatsApp's on purpose. importContacts is one of the most
   * aggressively limited MTProto methods — a few hundred a day will earn a
   * FLOOD_WAIT measured in hours.
   */
  maxLookups: tune(process.env.TELEGRAM_MAX_LOOKUPS, 100),
  foundReason: "Found on Telegram",
  notFoundReason: "Not found — may also mean lookup-by-number is restricted",

  async open(session: Session) {
    const cfg = telegramConfig();
    if (!cfg) {
      throw new Error(
        "Telegram is not configured on this server. Set TELEGRAM_API_ID and " +
        "TELEGRAM_API_HASH from https://my.telegram.org (API development tools).",
      );
    }

    const { TelegramClient, Api } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");

    const proxy = telegramProxy();
    const client = new TelegramClient(
      new StringSession(""), cfg.apiId, cfg.apiHash,
      { connectionRetries: 3, autoReconnect: true, proxy },
    ) as unknown as TgClient;

    session.handle = client;

    try {
      await client.connect();
    } catch (e) {
      // The common cause is a network-level block, not bad credentials, and
      // the raw gramjs error does not say so.
      throw new Error(
        `Could not reach Telegram${proxy ? " through the configured proxy" : ""}. ` +
        (proxy
          ? "Check TELEGRAM_PROXY_* settings."
          : "Telegram is blocked on some networks — if TCP 443 to 149.154.0.0/16 " +
            "is filtered where this server runs, set TELEGRAM_PROXY_IP and " +
            "TELEGRAM_PROXY_PORT (plus _SECRET for MTProxy or _SOCKS=5 for SOCKS).") +
        ` (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    // A saved session skips the QR entirely, which is what makes an operator
    // account survive a restart.
    if (session.restoreData) {
      const state = await authState(client, Api);

      if (state === "authorized") {
        const me = await client.getMe().catch(() => null);
        session.me = me?.phone ? `+${me.phone}` : me?.username ? `@${me.username}` : null;
        session.status = "ready";
        await session.persist?.({ identifier: session.me });
        return;
      }

      // Crucially NOT a QR: gramjs's isUserAuthorized() swallows network errors
      // and returns false, so a blip through the proxy used to look exactly
      // like revoked credentials — and discarding them forced a fresh scan on
      // every hiccup. Unreachable means unreachable; say so and keep the
      // credentials for the next attempt.
      if (state === "unreachable") {
        throw new Error(
          "Saved Telegram session could not be verified — Telegram was unreachable. " +
          "Check the proxy or network, then try again. Your credentials were kept.",
        );
      }

      // Genuinely revoked from the phone, so a new QR is the only way back.
      session.restoreData = null;
    }

    // Resolves once the operator has scanned; rejects on error or 2FA.
    client.signInUserWithQrCode(
      { apiId: cfg.apiId, apiHash: cfg.apiHash },
      {
        qrCode: async (code: { token: Buffer }) => {
          session.qr = qrUrl(code.token);
          session.status = "qr";
        },
        password: async () => {
          throw new Error(
            "This account has a 2FA password. This tool will not ask you to type " +
            "it into a web page — use an account without 2FA, or check by hand.",
          );
        },
        onError: async (err: Error) => {
          session.status = "failed";
          session.error = err.message;
          return true; // stop retrying
        },
      },
    ).then(async () => {
      const me = await client.getMe().catch(() => null);
      session.me = me?.phone ? `+${me.phone}` : me?.username ? `@${me.username}` : null;
      session.qr = null;
      session.status = "ready";
      // Save the credentials so the next boot needs no QR.
      await session.persist?.({ identifier: session.me, sessionData: client.session.save() });
    }).catch((e: unknown) => {
      session.status = "failed";
      session.error = e instanceof Error ? e.message : String(e);
    });
  },

  async close(session: Session, logout: boolean) {
    const client = session.handle as TgClient | null;
    session.handle = null;
    if (!client) return;
    try {
      if (logout) {
        const { Api } = await import("telegram");
        await client.invoke(new Api.auth.LogOut());
      }
    } catch {
      /* already gone */
    }
    await client.disconnect().catch(() => {});
    await client.destroy().catch(() => {});
  },

  async lookup(session: Session, e164s: string[]) {
    const client = session.handle as TgClient;
    const { Api } = await import("telegram");
    const bigInt = (await import("big-integer")).default;
    const scratch = scratchOf(session);

    // clientId is how the response is matched back to the number we asked about.
    const byClientId = new Map<string, string>();
    const contacts = e164s.map((phone) => {
      const id = scratch.clientSeq++;
      byClientId.set(String(id), phone);
      return new Api.InputPhoneContact({
        clientId: bigInt(id),
        phone,
        firstName: `chk${id}`,
        lastName: "",
      });
    });

    const res = (await client.invoke(
      new Api.contacts.ImportContacts({ contacts }),
    )) as {
      imported: { userId: unknown; clientId: unknown }[];
      users?: { id: unknown; status?: { className?: string; wasOnline?: number } }[];
    };

    // The same response already carries each user's status, so activity costs
    // no extra lookups — it is simply the part most callers throw away.
    const statusByUser = new Map<string, LastSeen>();
    for (const u of res.users ?? []) {
      statusByUser.set(String(u.id), toLastSeen(u.status));
    }

    const out: Record<string, LookupAnswer> = Object.fromEntries(
      e164s.map((p) => [p, { found: false } as LookupAnswer]),
    );

    for (const imp of res.imported ?? []) {
      const phone = byClientId.get(String(imp.clientId));
      if (phone) {
        out[phone] = {
          found: true,
          lastSeen: statusByUser.get(String(imp.userId)) ?? { kind: "hidden" },
        };
      }
      // Remember the contact we just created so finish() can remove it.
      scratch.imported.push(imp.userId);
    }

    return out;
  },

  /** Undo the contact rows the import created. This is the visitor's address book. */
  async finish(session: Session) {
    const client = session.handle as TgClient | null;
    const scratch = session.scratch as Scratch | null;
    if (!client || !scratch?.imported.length) return;

    const { Api } = await import("telegram");
    const ids = scratch.imported.splice(0, scratch.imported.length);
    // Chunked: deleting hundreds in one call is its own flood risk.
    for (let i = 0; i < ids.length; i += 50) {
      await client.invoke(
        new Api.contacts.DeleteContacts({ id: ids.slice(i, i + 50) as never }),
      ).catch(() => {});
    }
  },

  /**
   * How long Telegram told us to wait, in seconds.
   *
   * With no fixed pacing this is the only rate signal there is, so it is read
   * and obeyed rather than treated as a failure.
   */
  cooldown(err: unknown) {
    const m = /FLOOD_WAIT_(\d+)/.exec(err instanceof Error ? err.message : String(err));
    return m ? Number(m[1]) : null;
  },

  fatal(err: unknown) {
    const secs = telegram.cooldown?.(err) ?? null;
    // Only give up when the wait is longer than any run would survive.
    if (secs === null || secs < 3600) return null;
    return `Telegram rate-limited this account for ${Math.round(secs / 3600)} hours. ` +
      `That is longer than a run can wait, so it stopped.`;
  },
};
