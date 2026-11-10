import { NextResponse } from "next/server";
import { AuthError } from "./auth";
import { InsufficientCredits } from "./credits";
import { NoProvider } from "./presence/pool";

/**
 * An error whose message is written for the person reading it.
 *
 * `fail()` replaces unknown exception text with a fixed string so internals
 * cannot leak. That is right, but it also meant deliberate validation messages
 * ("this file is over the limit") came out as "Something went wrong." Throwing
 * this says the message was authored for display.
 */
export class UserError extends Error {
  constructor(message: string, readonly status = 400, readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

/** Nothing sensitive may be cached by a browser, proxy or CDN. */
export const NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate, private",
  pragma: "no-cache",
} as const;

export function json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { ...NO_STORE, ...(init?.headers ?? {}) },
  });
}

/**
 * Turn our error types into a status code — and nothing else.
 *
 * Only errors we raised on purpose carry their message to the client. Anything
 * unexpected is logged server-side and answered with a fixed string: raw
 * exception text is where stack frames, absolute paths, driver internals and
 * SQL end up, and a network tab is exactly where someone would go looking.
 */
export function fail(err: unknown): NextResponse {
  if (err instanceof UserError) {
    return json({ error: err.message, ...(err.detail ?? {}) }, { status: err.status });
  }
  if (err instanceof AuthError) return json({ error: err.message }, { status: err.status });
  if (err instanceof InsufficientCredits) {
    return json(
      { error: err.message, needed: err.needed, available: err.available },
      { status: 402 },
    );
  }
  if (err instanceof NoProvider) return json({ error: err.message }, { status: 503 });

  console.error("[api] unhandled:", err);
  return json({ error: "Something went wrong." }, { status: 500 });
}

/**
 * Strip host details out of a provider error before it reaches the admin UI.
 *
 * These come from Puppeteer and gramjs and routinely contain absolute paths,
 * the proxy address and internal ids.
 */
export function safeProviderError(msg: string | null): string | null {
  if (!msg) return null;
  return msg
    .replace(/\/(?:Users|home|root|var|opt)\/[^\s"')]+/g, "<path>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, "<host>")
    .slice(0, 300);
}
