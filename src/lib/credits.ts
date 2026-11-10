/**
 * The credit ledger.
 *
 * Two rules the rest of the system depends on:
 *
 * 1. `User.credits` is never written outside a transaction that also appends a
 *    CreditTx. The ledger is the record; the column is a cache of it.
 * 2. A debit is conditional on the balance in the same statement, so two
 *    concurrent checks cannot both spend the last credit.
 */
import type { $Enums } from "@prisma/client";
import { prisma } from "./db";

/** What a single lookup costs. Telegram's last-seen rides along with the
 *  registration lookup — it is the same API call, so it is not charged twice. */
export const PRICE: Record<$Enums.Channel, number> = {
  WHATSAPP: 1,
  TELEGRAM: 1,
  SMS: 1,
};

export class InsufficientCredits extends Error {
  constructor(readonly needed: number, readonly available: number) {
    super(`Needs ${needed} credit${needed === 1 ? "" : "s"}, ${available} available.`);
  }
}

/**
 * Reserve `amount` credits up front. Returns the transaction id, which the
 * caller passes to refund() if the work could not be done.
 *
 * Charging before the lookup rather than after is deliberate: a crash mid-run
 * then leaves the user over-charged by a refundable amount, instead of letting
 * them spend credits they no longer have.
 */
export async function debit(
  userId: string, amount: number, note: string,
): Promise<{ txId: string; balanceAfter: number }> {
  if (amount <= 0) throw new Error("debit amount must be positive");

  return prisma.$transaction(async (tx) => {
    // Conditional decrement — the balance check and the write are one statement,
    // so concurrent requests cannot both pass it.
    const updated = await tx.user.updateMany({
      where: { id: userId, credits: { gte: amount } },
      data: { credits: { decrement: amount } },
    });

    if (updated.count === 0) {
      const u = await tx.user.findUnique({ where: { id: userId }, select: { credits: true } });
      throw new InsufficientCredits(amount, u?.credits ?? 0);
    }

    const after = await tx.user.findUniqueOrThrow({
      where: { id: userId }, select: { credits: true },
    });

    const row = await tx.creditTx.create({
      data: {
        userId, delta: -amount, balanceAfter: after.credits,
        kind: "DEBIT", note,
      },
      select: { id: true },
    });

    return { txId: row.id, balanceAfter: after.credits };
  });
}

/** Give back credits for work that could not be delivered. */
export async function refund(
  userId: string, amount: number, note: string,
): Promise<void> {
  if (amount <= 0) return;

  await prisma.$transaction(async (tx) => {
    const after = await tx.user.update({
      where: { id: userId },
      data: { credits: { increment: amount } },
      select: { credits: true },
    });
    await tx.creditTx.create({
      data: { userId, delta: amount, balanceAfter: after.credits, kind: "REFUND", note },
    });
  });
}

/** Admin adds credit after being paid outside the system. */
export async function topUp(
  userId: string, amount: number, actorId: string, note: string,
): Promise<number> {
  if (amount === 0) throw new Error("top-up must be non-zero");

  return prisma.$transaction(async (tx) => {
    if (amount < 0) {
      // A negative adjustment must not push the balance below zero.
      const ok = await tx.user.updateMany({
        where: { id: userId, credits: { gte: -amount } },
        data: { credits: { increment: amount } },
      });
      if (ok.count === 0) {
        const u = await tx.user.findUnique({ where: { id: userId }, select: { credits: true } });
        throw new InsufficientCredits(-amount, u?.credits ?? 0);
      }
    } else {
      await tx.user.update({ where: { id: userId }, data: { credits: { increment: amount } } });
    }

    const after = await tx.user.findUniqueOrThrow({
      where: { id: userId }, select: { credits: true },
    });

    await tx.creditTx.create({
      data: {
        userId, delta: amount, balanceAfter: after.credits,
        kind: amount > 0 ? "TOPUP" : "ADJUST", note, actorId,
      },
    });

    return after.credits;
  });
}
