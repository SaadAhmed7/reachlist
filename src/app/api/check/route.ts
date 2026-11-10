import { z } from "zod";
import type { $Enums } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { PRICE, debit, refund } from "@/lib/credits";
import { prisma } from "@/lib/db";
import { fail, json } from "@/lib/api";
import { lookupOne } from "@/lib/presence/pool";
import { normalizePhone } from "@/lib/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  number: z.string().min(3).max(32),
  region: z.string().length(2).optional(),
  channels: z.array(z.enum(["WHATSAPP", "TELEGRAM"])).min(1),
});

/**
 * One metered lookup per channel.
 *
 * Credits are taken before the lookup and given back if it fails, rather than
 * charged after. A crash mid-flight then leaves the user owed a refund we can
 * see in the ledger, instead of having had free lookups we cannot reconstruct.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "Bad request." }, { status: 400 });

    const region = parsed.data.region ?? process.env.DEFAULT_REGION ?? "US";
    const phone = normalizePhone(parsed.data.number, region);
    if (!phone.ok) {
      // Never charge for something we refused to look up.
      return json(
        { error: "That is not a valid phone number.", reason: phone.reason }, { status: 400 },
      );
    }

    const channels = [...new Set(parsed.data.channels)] as $Enums.Channel[];
    const cost = channels.reduce((n, c) => n + PRICE[c], 0);

    const { balanceAfter } = await debit(
      user.id, cost, `Check ${phone.e164} on ${channels.join(", ")}`,
    );

    // Separate accounts, so asking both at once costs nothing in per-account
    // request rate and halves the wait.
    const outcomes = await Promise.all(channels.map(async (channel) => {
      try {
        const r = await lookupOne(channel, phone.e164);
        // Only reachable numbers are kept. A miss is answered to the caller and
        // then forgotten: storing the numbers of people who are not on the
        // service is a privacy liability with no use.
        if (r.found) {
          await prisma.checkRecord.create({
            data: {
              userId: user.id, channel, e164: phone.e164,
              verdict: "REGISTERED",
              lastSeen: r.lastSeen ? (r.lastSeen as object) : undefined,
              credits: PRICE[channel], providerId: r.providerId,
            },
          });
        }
        return [channel, {
          verdict: r.found ? "REGISTERED" : "NOT_REGISTERED",
          lastSeen: r.lastSeen ?? null,
          charged: PRICE[channel],
        }, 0] as const;
      } catch (err) {
        // A failed lookup is not an answer, so it is neither billable nor
        // worth keeping the number for.
        return [channel, {
          verdict: "UNKNOWN",
          error: err instanceof Error ? err.message : String(err),
          charged: 0,
        }, PRICE[channel]] as const;
      }
    }));

    const results: Record<string, unknown> = Object.fromEntries(
      outcomes.map(([c, r]) => [c, r]),
    );
    const refunded = outcomes.reduce((n, [, , owed]) => n + owed, 0);

    if (refunded > 0) {
      await refund(user.id, refunded, `Refund: ${refunded} lookup(s) could not be answered`);
    }

    const credits = balanceAfter + refunded;
    return json({
      e164: phone.e164, country: phone.countryCode,
      results, charged: cost - refunded, credits,
    });
  } catch (err) {
    return fail(err);
  }
}

/** Recent checks, for the user's own history table. */
export async function GET() {
  try {
    const user = await requireUser();
    const checks = await prisma.checkRecord.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, channel: true, e164: true, verdict: true,
        lastSeen: true, credits: true, createdAt: true,
      },
    });
    return json({ checks, credits: user.credits });
  } catch (err) {
    return fail(err);
  }
}
