import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { linkProvider, unlinkProvider } from "@/lib/presence/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z.object({
  action: z.enum(["link", "unlink", "enable", "disable"]),
  /** Unlink also logs the device out of the phone unless told otherwise. */
  logout: z.boolean().optional(),
});

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const parsed = Patch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "Bad request." }, { status: 400 });

    switch (parsed.data.action) {
      case "link":
        await linkProvider(id);
        break;
      case "unlink":
        await unlinkProvider(id, parsed.data.logout ?? true);
        break;
      case "enable":
        await prisma.providerAccount.update({ where: { id }, data: { enabled: true, lastError: null } });
        break;
      case "disable":
        await prisma.providerAccount.update({ where: { id }, data: { enabled: false } });
        break;
    }
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    await unlinkProvider(id, true).catch(() => {});
    await prisma.providerAccount.delete({ where: { id } });
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
