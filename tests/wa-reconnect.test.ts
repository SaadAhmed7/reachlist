/**
 * The post-pairing reconnect.
 *
 * After a QR is scanned, WhatsApp always drops the socket with 515
 * `restartRequired` and expects the client to reconnect immediately with the
 * credentials it just saved. A driver that reports "closed" instead leaves the
 * phone on "Logging in… keep WhatsApp open on both devices" for ever and the
 * account can never be linked — which is exactly what shipped once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (u: unknown) => void;

/** Sockets handed out by the mocked factory, newest last. */
const sockets: Array<{ on: Record<string, Handler[]>; ended: boolean }> = [];

function emit(index: number, event: string, payload: unknown) {
  for (const h of sockets[index].on[event] ?? []) h(payload);
}

vi.mock("@whiskeysockets/baileys", () => {
  const makeWASocket = () => {
    const on: Record<string, Handler[]> = {};
    const sock = {
      on,
      ended: false,
      ev: { on: (e: string, cb: Handler) => { (on[e] ??= []).push(cb); } },
      user: { id: "923001234567:7@s.whatsapp.net" },
      end: () => { sock.ended = true; },
      logout: async () => {},
      executeUSyncQuery: async () => ({ list: [] }),
    };
    sockets.push(sock);
    return sock;
  };
  return {
    default: makeWASocket,
    makeWASocket,
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    Browsers: { appropriate: () => ["x", "y", "z"] },
    DisconnectReason: {
      loggedOut: 401, forbidden: 403, timedOut: 408, connectionClosed: 428,
      connectionReplaced: 440, badSession: 500, restartRequired: 515,
      connectionLost: 408, unavailableService: 503,
    },
    USyncQuery: class { withContactProtocol() { return this; } withUser() { return this; } },
    USyncUser: class { withPhone() { return this; } },
  };
});

const { whatsapp } = await import("@/lib/presence/whatsapp");
import type { Session } from "@/lib/presence/types";

const makeSession = (): Session => ({
  id: "t1", channel: "whatsapp", status: "starting", qr: null, error: null,
  me: null, handle: null, scratch: null, job: null, lastTouched: Date.now(),
});

describe("WhatsApp session lifecycle", () => {
  beforeEach(() => { sockets.length = 0; vi.useRealTimers(); });

  it("reconnects after the 515 that always follows a successful pairing", async () => {
    const s = makeSession();
    await whatsapp.open(s);
    expect(sockets).toHaveLength(1);

    // The phone scans the code.
    emit(0, "connection.update", { qr: "code-1" });
    expect(s.status).toBe("qr");

    // WhatsApp immediately drops the socket asking for a restart.
    emit(0, "connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });

    // It must NOT be reported as closed — that is what hangs the phone.
    expect(s.status).toBe("starting");

    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 1000 });

    // The reconnected socket completes the link.
    emit(1, "connection.update", { connection: "open" });
    expect(s.status).toBe("ready");
    expect(s.me).toBe("+923001234567");
  });

  it("does not reconnect a session that was deliberately closed", async () => {
    const s = makeSession();
    await whatsapp.open(s);
    await whatsapp.close(s, false);

    emit(0, "connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });

    expect(sockets).toHaveLength(1);
    expect(s.status).toBe("closed");
  });

  it("asks for a fresh scan when the phone unlinked the device", async () => {
    const s = makeSession();
    await whatsapp.open(s);
    emit(0, "connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/scan the code again/i);
    expect(sockets).toHaveLength(1);
  });

  it("gives up with an actionable message rather than reconnecting for ever", async () => {
    const s = makeSession();
    await whatsapp.open(s);

    for (let i = 0; i < 8; i++) {
      const latest = sockets.length - 1;
      emit(latest, "connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 515 } } },
      });
      await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(Math.min(i + 2, 6)), { timeout: 1000 })
        .catch(() => {});
    }

    expect(sockets.length).toBeLessThanOrEqual(6);
    expect(s.status).toBe("closed");
    expect(s.error).toMatch(/scan the code again/i);
  });

  it("ignores events from a socket that has already been replaced", async () => {
    const s = makeSession();
    await whatsapp.open(s);
    emit(0, "connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 1000 });
    emit(1, "connection.update", { connection: "open" });
    expect(s.status).toBe("ready");

    // The dead first socket emits late; it must not clobber the live one.
    emit(0, "connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    expect(s.status).toBe("ready");
  });
});
