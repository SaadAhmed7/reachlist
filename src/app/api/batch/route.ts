import { z } from "zod";
import type { $Enums } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { MAX_ROWS_PER_BATCH, estimateRunSeconds, prepareBatch, startBatch } from "@/lib/batch";
import { summarizeList } from "@/lib/validate-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().min(1).max(120),
  text: z.string().min(1).max(2_000_000),
  region: z.string().length(2).optional(),
  channels: z.array(z.enum(["WHATSAPP", "TELEGRAM"])).min(1),
  /** Price it without charging, so the user sees the cost before committing. */
  dryRun: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "Bad request." }, { status: 400 });

    const region = parsed.data.region ?? process.env.DEFAULT_REGION ?? "US";
    const channels = [...new Set(parsed.data.channels)] as $Enums.Channel[];

    if (parsed.data.dryRun) {
      const q = prepareBatch(parsed.data.text, region, channels);
      const breakdown = summarizeList(q.rows);
      return json({
        quote: {
          totalRows: q.rows.length,
          checkable: q.checkable,
          cost: q.cost,
          headerSkipped: q.headerSkipped,
          overLimit: q.rows.length > MAX_ROWS_PER_BATCH,
          limit: MAX_ROWS_PER_BATCH,
          // How long this will actually take, shown before anything is charged.
          etaSeconds: await estimateRunSeconds(q.checkable, channels),
          affordable: user.credits >= q.cost,
          credits: user.credits,
          // The breakdown is what makes a wrong country setting visible: the
          // same ten digits are a valid US number, a valid Indian one, and a
          // Pakistani landline, so "mostly invalid" usually means wrong region.
          region,
          invalid: breakdown.invalid,
          duplicate: breakdown.duplicate,
          impossible: breakdown.impossible,
        },
      });
    }

    const started = await startBatch({
      userId: user.id, name: parsed.data.name, text: parsed.data.text, region, channels,
    });
    return json(started);
  } catch (err) {
    return fail(err);
  }
}

/** The user's uploads, newest first. */
export async function GET() {
  try {
    const user = await requireUser();
    const batches = await prisma.checkBatch.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true, name: true, channels: true, totalRows: true, checkable: true,
        done: true, creditsSpent: true, creditsRefunded: true, status: true,
        matched: true, discarded: true, createdAt: true, finishedAt: true,
      },
    });
    return json({ batches, credits: user.credits });
  } catch (err) {
    return fail(err);
  }
}
