import { z } from "zod";
import { hashPassword, requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fail, json } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Create = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Use at least 8 characters."),
  name: z.string().max(120).optional(),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
  credits: z.number().int().min(0).max(1_000_000).default(0),
});

export async function GET() {
  try {
    await requireAdmin();
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, email: true, name: true, role: true, credits: true,
        active: true, createdAt: true,
        _count: { select: { checks: true } },
      },
    });
    return json({ users });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const parsed = Create.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return json(
        { error: parsed.error.issues[0]?.message ?? "Bad request." }, { status: 400 },
      );
    }

    const email = parsed.data.email.trim().toLowerCase();
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      return json({ error: "That email already exists." }, { status: 409 });
    }

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(parsed.data.password),
        name: parsed.data.name || null,
        role: parsed.data.role,
      },
      select: { id: true, email: true },
    });

    // Opening credit goes through the ledger like any other, so the balance is
    // always the sum of its transactions.
    if (parsed.data.credits > 0) {
      const { topUp } = await import("@/lib/credits");
      await topUp(user.id, parsed.data.credits, admin.id, "Opening balance");
    }

    return json({ user });
  } catch (err) {
    return fail(err);
  }
}
