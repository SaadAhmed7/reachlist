import { z } from "zod";
import { hashPassword, requireAdmin, revokeAllSessions } from "@/lib/auth";
import { topUp } from "@/lib/credits";
import { prisma } from "@/lib/db";
import { fail, json } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z.object({
  /** Credit to add (or a negative number to correct a mistake). */
  credits: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  note: z.string().max(200).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
});

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, email: true, name: true, role: true, credits: true, active: true,
        createdAt: true,
        ledger: {
          orderBy: { createdAt: "desc" }, take: 50,
          select: {
            id: true, delta: true, balanceAfter: true, kind: true,
            note: true, createdAt: true, actor: { select: { email: true } },
          },
        },
      },
    });
    if (!user) return json({ error: "No such user." }, { status: 404 });
    return json({ user });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Delete a user and everything attached to them — sessions, ledger, check
 * history. Cascades are declared on the schema, so this really is permanent.
 *
 * Kept separate from deactivation on purpose: deactivating is the reversible
 * thing you almost always want, and this is not.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true, credits: true, _count: { select: { checks: true } } },
    });
    if (!target) return json({ error: "No such user." }, { status: 404 });

    if (target.id === admin.id) {
      return json({ error: "You cannot delete yourself." }, { status: 400 });
    }

    // Removing the last admin would lock everyone out of the panel, and the
    // only way back would be the CLI.
    if (target.role === "ADMIN") {
      const admins = await prisma.user.count({ where: { role: "ADMIN", active: true } });
      if (admins <= 1) {
        return json(
          { error: "That is the only active admin. Promote someone else first." },
          { status: 400 },
        );
      }
    }

    await prisma.user.delete({ where: { id } });

    return json({
      deleted: { email: target.email, credits: target.credits, checks: target._count.checks },
    });
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const parsed = Patch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "Bad request." }, { status: 400 });

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!target) return json({ error: "No such user." }, { status: 404 });

    // An admin locking themselves out is a support ticket, so refuse it.
    if (target.id === admin.id && parsed.data.active === false) {
      return json({ error: "You cannot deactivate yourself." }, { status: 400 });
    }

    const { credits, note, active, password, role } = parsed.data;

    if (credits !== undefined && credits !== 0) {
      await topUp(id, credits, admin.id, note?.trim() || (credits > 0 ? "Payment received" : "Correction"));
    }

    const data: Record<string, unknown> = {};
    if (active !== undefined) data.active = active;
    if (role !== undefined) data.role = role;
    if (password) data.passwordHash = await hashPassword(password);
    if (Object.keys(data).length > 0) await prisma.user.update({ where: { id }, data });

    // Deactivating or changing a password must end existing logins immediately.
    if (active === false || password) await revokeAllSessions(id);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id },
      select: { id: true, email: true, credits: true, active: true, role: true },
    });
    return json({ user });
  } catch (err) {
    return fail(err);
  }
}
