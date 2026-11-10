/**
 * GREEN-API: hosted WhatsApp and Telegram lookups.
 *
 * The important difference from the session drivers is that there is no
 * session here at all — no Chromium, no QR, no profile lock, nothing to
 * survive a restart. GREEN-API holds the logged-in account; we make an HTTP
 * call. That removes the entire class of failure this project kept hitting.
 *
 * Config is per channel, because each messenger is a separate instance with
 * its own id, token and host.
 */
import type { $Enums } from "@prisma/client";
import type { LastSeen } from "../validate-list";

export type GreenConfig = { url: string; id: string; token: string };

/** Credentials for one channel, or null when it is not configured. */
export function greenApiConfig(channel: $Enums.Channel): GreenConfig | null {
  const p = channel === "WHATSAPP" ? "GREENAPI_WA" : channel === "TELEGRAM" ? "GREENAPI_TG" : null;
  if (!p) return null;

  const url = process.env[`${p}_URL`]?.replace(/\/+$/, "");
  const id = process.env[`${p}_ID`];
  const token = process.env[`${p}_TOKEN`];
  return url && id && token ? { url, id, token } : null;
}

export function greenApiEnabled(channel: $Enums.Channel): boolean {
  return greenApiConfig(channel) !== null;
}

/**
 * Pull an activity hint out of whatever GREEN-API returns.
 *
 * Their docs list no last-seen field on the account check, but support says
 * one is sent when available — so rather than trusting either, this reads
 * several plausible shapes and the caller keeps the raw payload to settle it.
 */
export function parseLastSeen(body: Record<string, unknown>): LastSeen | undefined {
  const raw =
    body.lastSeen ?? body.lastseen ?? body.last_seen ??
    body.lastOnline ?? body.status ?? body.userStatus;
  if (raw === undefined || raw === null || raw === "") return undefined;

  if (typeof raw === "number") {
    // Seconds or milliseconds since epoch; anything in the far future is junk.
    const secs = raw > 1e12 ? Math.floor(raw / 1000) : raw;
    return secs > 0 && secs < Date.now() / 1000 + 86_400 ? { kind: "at", at: secs } : undefined;
  }

  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (!s) return undefined;
    if (s === "online") return { kind: "online" };
    if (s.includes("recent")) return { kind: "bucket", bucket: "recently" };
    if (s.includes("week")) return { kind: "bucket", bucket: "week" };
    if (s.includes("month")) return { kind: "bucket", bucket: "month" };
    if (s.includes("long") || s.includes("hidden")) return { kind: "hidden" };

    const n = Number(s);
    if (Number.isFinite(n) && n > 0) {
      const secs = n > 1e12 ? Math.floor(n / 1000) : n;
      return { kind: "at", at: secs };
    }
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return { kind: "at", at: Math.floor(t / 1000) };
  }
  return undefined;
}

export type GreenAnswer = {
  found: boolean;
  lastSeen?: LastSeen;
  /** The untouched response, so an undocumented field is visible rather than lost. */
  raw: unknown;
};

/**
 * Check one number.
 *
 * `force: true` on every call: a cached answer is not a fresh check, and
 * billing a user for one would be charging them for someone else's lookup.
 */
export async function greenApiCheck(
  channel: $Enums.Channel, e164: string, timeoutMs = 20_000,
): Promise<GreenAnswer> {
  const cfg = greenApiConfig(channel);
  if (!cfg) throw new Error(`GREEN-API is not configured for ${channel}.`);

  const digits = e164.replace(/\D/g, "");
  const method = channel === "WHATSAPP" ? "checkWhatsapp" : "checkAccount";
  const body = channel === "WHATSAPP"
    ? { chatId: `${digits}@c.us`, force: true }
    : { phoneNumber: Number(digits), force: true };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}/waInstance${cfg.id}/${method}/${cfg.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      // Their errors carry the reason in the body, which is what tells an
      // unauthorized instance apart from a rate limit.
      throw new Error(`GREEN-API ${res.status}: ${text.slice(0, 200)}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`GREEN-API returned non-JSON: ${text.slice(0, 160)}`);
    }

    const found = channel === "WHATSAPP"
      ? parsed.existsWhatsapp === true
      : parsed.exist === true;

    return { found, lastSeen: parseLastSeen(parsed), raw: parsed };
  } finally {
    clearTimeout(timer);
  }
}
