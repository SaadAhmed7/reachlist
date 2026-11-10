import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { stopBatch } from "@/lib/batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Full batch with every uploaded row — including the ones never looked up. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const batch = await prisma.checkBatch.findFirst({
      // Scoped by userId: a batch id must not be readable by whoever guesses it.
      where: { id, userId: user.id },
      include: { items: { orderBy: { rowNumber: "asc" } } },
    });
    if (!batch) return json({ error: "No such batch." }, { status: 404 });

    return json({ batch, credits: user.credits });
  } catch (err) {
    return fail(err);
  }
}

/** Stop early. Whatever has been answered is kept and already paid for. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const owned = await prisma.checkBatch.findFirst({
      where: { id, userId: user.id }, select: { id: true },
    });
    if (!owned) return json({ error: "No such batch." }, { status: 404 });
    stopBatch(id);
    return json({ stopped: true });
  } catch (err) {
    return fail(err);
  }
}
