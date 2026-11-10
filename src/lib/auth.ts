/**
 * Password and session handling for the metered checker.
 *
 * Deliberately small and dependency-free: scrypt from node:crypto for
 * passwords, a random opaque token for sessions. No JWT — a token we can
 * revoke by deleting a row is worth more here than one we cannot.
 */
import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { prisma } from "./db";

const scrypt = promisify(_scrypt) as (
  p: string | Buffer, s: string | Buffer, k: number,
) => Promise<Buffer>;

const COOKIE = "rl_session";
const SESSION_DAYS = 7;
const KEYLEN = 64;

// ------------------------------------------------------------- passwords

/** `scrypt$<salt hex>$<hash hex>`, so the format carries its own parameters. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  // Constant time: a fast "wrong" is a free oracle.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// -------------------------------------------------------------- sessions

/** Only the hash is stored, so a database dump is not a pile of live logins. */
const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createSession(userId: string, userAgent?: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);

  await prisma.userSession.create({
    data: { userId, tokenHash: tokenHash(token), expiresAt, userAgent },
  });

  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Secure is right whenever there is TLS, and fatal without it: the browser
    // would refuse to send the cookie back over http and nobody could stay
    // signed in. COOKIE_SECURE=0 is the explicit opt-out for a plain-http
    // deployment, and it means credentials travel in clear — see the README.
    secure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === "1"
      : process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export type SessionUser = {
  id: string; email: string; name: string | null;
  role: "ADMIN" | "USER"; credits: number; active: boolean;
};

/** The signed-in user, or null. Never throws — callers decide what to do. */
export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.userSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: {
      expiresAt: true,
      user: {
        select: { id: true, email: true, name: true, role: true, credits: true, active: true },
      },
    },
  });

  if (!session || session.expiresAt < new Date()) return null;
  // A deactivated user is logged out everywhere the moment the flag flips.
  if (!session.user.active) return null;
  return session.user as SessionUser;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    await prisma.userSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
  }
  jar.delete(COOKIE);
}

/** Drop every session for a user — used when an admin deactivates them. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.userSession.deleteMany({ where: { userId } });
}

// ---------------------------------------------------------------- guards

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw new AuthError(401, "Not signed in.");
  return u;
}

export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (u.role !== "ADMIN") throw new AuthError(403, "Admins only.");
  return u;
}
