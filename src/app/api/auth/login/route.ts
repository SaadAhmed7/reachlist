import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession, hashPassword, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NO_STORE, json } from "@/lib/api";
import { clearLimit, clientKey, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

/**
 * A throwaway hash, computed once, so a login for an address that does not
 * exist costs the same wall-clock time as one that does. Returning early on
 * "no such user" is a free oracle for which addresses are real.
 */
let decoyHash: string | null = null;
async function decoy(password: string) {
  decoyHash ??= await hashPassword("decoy-password-never-matches");
  await verifyPassword(password, decoyHash);
}

export async function POST(req: Request) {
  // Five attempts a minute per address, and twenty per client: enough for a
  // forgotten password, useless for guessing one.
  const ip = clientKey(req);
  const byIp = rateLimit(`login:ip:${ip}`, 20, 60_000);
  if (!byIp.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(byIp.retryAfter) } },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Bad request." }, { status: 400 });

  const email = parsed.data.email.trim().toLowerCase();
  const byUser = rateLimit(`login:user:${email}`, 5, 60_000);
  if (!byUser.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(byUser.retryAfter) } },
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // One message for every failure: a different one tells an attacker which
  // addresses are real.
  const bad = () => json({ error: "Wrong email or password." }, { status: 401 });

  if (!user || !user.active) {
    await decoy(parsed.data.password);
    return bad();
  }
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) return bad();

  await createSession(user.id, req.headers.get("user-agent") ?? undefined);
  clearLimit(`login:user:${email}`);
  return json({ role: user.role });
}
