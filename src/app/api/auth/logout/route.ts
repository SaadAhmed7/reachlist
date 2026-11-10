import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign out.
 *
 * Redirects rather than returning JSON because the sign-out control is a plain
 * form POST — it must work without JavaScript, and a bare {"ok":true} page is
 * what the user would otherwise be left staring at.
 */
export async function POST(req: Request) {
  await destroySession();
  return NextResponse.redirect(new URL("/login", req.url), 303);
}
