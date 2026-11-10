/**
 * Metered CSV batches.
 *
 * The run is a background job keyed by batch id: a web request cannot sit
 * through a hundred lookups paced seven seconds apart. Progress and results are
 * written to the database as they happen, so the page polls the batch row
 * rather than holding anything in memory it could lose.
 */
import type { $Enums, Prisma } from "@prisma/client";
import { UserError } from "./api";
import { prisma } from "./db";
import { PRICE, debit, refund } from "./credits";
import { lookupManyOn, readyProviders } from "./presence/pool";
import { driverFor } from "./presence";
import { extractNumbers, prepareNumber, type Row } from "./validate-list";

/**
 * No per-run row cap: credits are the real limit, and a long run is now safe
 * because it survives a restart and paces itself through the provider gate.
 *
 * This ceiling only bounds a single HTTP body so one request cannot exhaust
 * memory; it is not a policy about how much work a user may queue.
 */
export const MAX_ROWS_PER_BATCH = 200_000;

const CHANNEL_KEY: Record<string, "whatsapp" | "telegram" | null> = {
  WHATSAPP: "whatsapp", TELEGRAM: "telegram", SMS: null,
};

/** Jobs currently running, so a stop request can reach them. */
const running = (globalThis as unknown as { __batchJobs?: Set<string> }).__batchJobs ??= new Set<string>();

export function stopBatch(batchId: string) { running.delete(batchId); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pick up batches that were left RUNNING with no runner behind them.
 *
 * A multi-day run now outlives deploys and crashes: progress lives in the
 * per-row results, so resuming is simply running again and skipping what is
 * already answered. Without this, removing the row cap would mean the first
 * restart silently abandoned a job the user had already paid for.
 */
export async function resumeOrphanedBatches(): Promise<number> {
  const orphans = await prisma.checkBatch.findMany({
    where: { status: "RUNNING" },
    select: { id: true, userId: true, channels: true },
  });

  let resumed = 0;
  for (const b of orphans) {
    if (running.has(b.id)) continue; // already being worked on in this process
    const channels = (Array.isArray(b.channels) ? b.channels : []) as $Enums.Channel[];
    if (channels.length === 0) continue;
    void runBatch(b.id, b.userId, channels);
    resumed++;
  }
  return resumed;
}

// Sweep on boot and periodically after, so a job orphaned by a restart is
// picked up without anyone having to notice.
const g = globalThis as unknown as { __batchResume?: NodeJS.Timeout };
g.__batchResume ??= setInterval(() => {
  void resumeOrphanedBatches().catch(() => {});
}, 60_000).unref?.() as unknown as NodeJS.Timeout;
void resumeOrphanedBatches().catch(() => {});

/**
 * Wall-clock seconds for a run, which is the slowest channel rather than the
 * sum: the two run concurrently against separate accounts.
 */
export async function estimateRunSeconds(
  checkable: number, channels: $Enums.Channel[],
): Promise<number> {
  /** Measured round trip for one provider call with no pacing on top. */
  const CALL_MS = 350;

  const perChannel = await Promise.all(channels.map(async (c) => {
    const d = driverFor(CHANNEL_KEY[c]!);
    const calls = Math.ceil(checkable / d.batchSize);
    // With pacing removed the network call itself is the floor. Without this
    // the estimate collapses to zero and promises an instant run.
    const perCall = d.delayMs > 0 ? d.delayMs * 1.25 : CALL_MS;
    // Accounts work in parallel, so the wait divides by how many are linked.
    // No waiting here: this is a price quote, not a run. A cold pool should
    // give a rough number instantly rather than stall the dialog.
    const accounts = Math.max(
      1, (await readyProviders(c, { wait: false }).catch(() => [])).length,
    );
    return (calls * perCall) / 1000 / accounts;
  }));

  // Channels run concurrently, so the wall clock is the slowest one.
  return Math.max(0, ...perChannel);
}

export type PreparedBatch = {
  rows: Row[];
  checkable: number;
  cost: number;
  headerSkipped: string | null;
};

/** Parse and price an upload without touching credits or the network. */
export function prepareBatch(
  text: string, region: string, channels: $Enums.Channel[],
): PreparedBatch {
  const { numbers, headerSkipped } = extractNumbers(text);
  const ctx = { defaultRegion: region, seen: new Set<string>() };
  const rows = numbers.map((n, i) => prepareNumber(n, i + 1, ctx));
  const checkable = rows.filter((r) => r.status === "OK").length;
  const cost = channels.reduce((n, c) => n + PRICE[c] * checkable, 0);
  return { rows, checkable, cost, headerSkipped };
}

/**
 * Charge, persist every uploaded row, and start the lookups.
 *
 * Every row is stored, not just the billable ones — an invalid or duplicate
 * line is the user's own data coming back with a reason, and it is the only way
 * to explain a charge that is smaller than the file.
 */
export async function startBatch(opts: {
  userId: string;
  name: string;
  text: string;
  region: string;
  channels: $Enums.Channel[];
}): Promise<{ batchId: string; checkable: number; cost: number }> {
  const { rows, checkable, cost, headerSkipped } = prepareBatch(
    opts.text, opts.region, opts.channels,
  );

  if (rows.length === 0) {
    throw new UserError("That file had no numbers in it.", 400);
  }
  if (rows.length > MAX_ROWS_PER_BATCH) {
    throw new UserError(
      `This file has ${rows.length.toLocaleString()} rows, past the ` +
      `${MAX_ROWS_PER_BATCH.toLocaleString()} a single upload can carry. Split it in two.`,
      413,
      { rows: rows.length, limit: MAX_ROWS_PER_BATCH },
    );
  }

  // One run at a time per user. Two of their own batches would compete for the
  // same provider budget and finish no sooner, while making progress and cost
  // much harder to reason about.
  const active = await prisma.checkBatch.findFirst({
    where: { userId: opts.userId, status: "RUNNING" },
    select: { id: true, name: true, done: true, checkable: true },
  });
  if (active) {
    throw new UserError(
      `"${active.name}" is still running (${active.done} of ${active.checkable * opts.channels.length} ` +
      `lookups done). Wait for it to finish, or stop it, then start this one.`,
      409,
    );
  }
  if (checkable === 0) {
    throw new UserError(
      "No row in that file needed a lookup — every number was invalid, a duplicate, " +
      "or a range that cannot hold an account. Check the country setting matches these numbers.",
      400,
    );
  }

  // Charge first: a crash mid-run then leaves a refundable over-charge in the
  // ledger rather than lookups nobody paid for.
  await debit(opts.userId, cost, `Batch "${opts.name}" — ${checkable} numbers x ${opts.channels.length} channel(s)`);

  const batch = await prisma.checkBatch.create({
    data: {
      userId: opts.userId,
      name: opts.name.slice(0, 120),
      channels: opts.channels,
      totalRows: rows.length,
      checkable,
      creditsSpent: cost,
      status: "RUNNING",
      error: headerSkipped ? `Header row skipped: ${headerSkipped}` : null,
      items: {
        create: rows.map((r) => ({
          rowNumber: r.index,
          raw: r.raw.slice(0, 200),
          e164: r.e164,
          countryCode: r.countryCode,
          status: r.status,
          reason: r.reason || null,
        })),
      },
    },
    select: { id: true },
  });

  void runBatch(batch.id, opts.userId, opts.channels);
  return { batchId: batch.id, checkable, cost };
}

/**
 * Run one channel over the whole list, in provider-sized chunks.
 *
 * Returns the credits owed back for lookups that could not be answered.
 */
async function runChannel(
  batchId: string, userId: string, channel: $Enums.Channel, allItems: BatchRow[],
): Promise<number> {
  // Anything this channel already answered is skipped, which is the whole of
  // what resuming needs: the per-row results are the progress record.
  const items = allItems.filter((it) => !(it.results as Record<string, unknown> | null)?.[channel]);
  if (items.length === 0) return 0;

  const driver = driverFor(CHANNEL_KEY[channel]!);
  const providers = await readyProviders(channel);
  if (providers.length === 0) {
    // Nothing to run on. Settle every row rather than leaving them waiting.
    return settleRemaining(batchId, userId, channel, items, "No account is connected for this channel");
  }

  // One worker per linked account, all pulling from the same queue. A session
  // answers one call at a time, so this is the lever that makes linking more
  // accounts actually shorten the run: ten accounts, ten numbers in flight.
  let next = 0;
  let refunded = 0;
  let stop = false;
  const done = new Set<string>();

  async function worker(providerId: string) {
    let consecutiveErrors = 0;

    for (;;) {
      if (stop || !running.has(batchId)) return;
      const i = next;
      next += driver.batchSize;
      if (i >= items.length) return;

      const chunk = items.slice(i, i + driver.batchSize);
      try {
        let res;
        try {
          res = await lookupManyOn(providerId, channel, chunk.map((c) => c.e164));
        } catch (first) {
          // A crashed transport is rebuilt by the pool and a rate limit is
          // served out before the next call; neither is the chunk's fault, so
          // burning it would charge the user for the provider's bad minute.
          const waitFor = driver.cooldown?.(first) ?? null;
          const retryable = waitFor !== null || (driver.recoverable?.(first) ?? false);
          if (!retryable) throw first;
          if (waitFor === null) await sleep(5_000);
          res = await lookupManyOn(providerId, channel, chunk.map((c) => c.e164));
        }

        const { answers, providerId: used } = res;
        for (const it of chunk) {
          const a = answers[it.e164];
          const found = a?.found === true;
          await mergeResult(it.id, channel, {
            verdict: found ? "REGISTERED" : "NOT_REGISTERED",
            lastSeen: a?.lastSeen ?? null,
          });
          if (found) {
            await prisma.checkRecord.create({
              data: {
                userId, channel, e164: it.e164, batchId, verdict: "REGISTERED",
                lastSeen: a?.lastSeen ? (a.lastSeen as object) : undefined,
                credits: PRICE[channel],
                providerId: used.startsWith("greenapi:") ? null : used,
              },
            }).catch(() => {});
          }
          done.add(it.id);
        }
        consecutiveErrors = 0;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        for (const it of chunk) {
          refunded += PRICE[channel];
          await mergeResult(it.id, channel, { verdict: "UNKNOWN", reason });
          done.add(it.id);
        }
        // A rate limit is the service pacing us, not this account failing.
        if ((driver.cooldown?.(err) ?? null) === null) consecutiveErrors++;
        // Only this worker gives up; the other accounts keep going.
        if (driver.fatal?.(err) || consecutiveErrors >= 5) return;
      }

      await prisma.checkBatch.update({
        where: { id: batchId }, data: { done: { increment: chunk.length } },
      }).catch(() => {});
    }
  }

  await Promise.all(providers.map((p) => worker(p).catch(() => {})));

  // Whatever no worker reached — every account died, or the run was stopped.
  const left = items.filter((it) => !done.has(it.id));
  if (left.length > 0) {
    refunded += await settleRemaining(
      batchId, userId, channel, left, "The run ended before this number was reached",
    );
  }
  return refunded;
}

/**
 * Give an answer to rows nobody got to, and refund them.
 *
 * Charged up front, so leaving them unanswered bills for work never done and
 * leaves the row reading "waiting" in a batch marked finished.
 */
async function settleRemaining(
  batchId: string, userId: string, channel: $Enums.Channel,
  items: BatchRow[], reason: string,
): Promise<number> {
  for (const it of items) {
    await mergeResult(it.id, channel, { verdict: "UNKNOWN", reason });
  }
  await prisma.checkBatch.update({
    where: { id: batchId }, data: { done: { increment: items.length } },
  }).catch(() => {});
  void userId;
  return items.length * PRICE[channel];
}

/**
 * Merge one channel's answer into a row's results.
 *
 * Postgres jsonb concatenation, not read-modify-write: the two channels run
 * concurrently against the same row, and a JS-side merge would lose whichever
 * write landed second.
 */
async function mergeResult(itemId: string, channel: string, value: object): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "BatchItem"
       SET "results" = COALESCE("results", '{}'::jsonb) || ${JSON.stringify({ [channel]: value })}::jsonb
     WHERE "id" = ${itemId}
  `.catch(() => {});
}

type BatchRow = { id: string; e164: string; results: Prisma.JsonValue };

/**
 * Delete every number that was not found on any requested channel.
 *
 * The operator only wants reachable numbers, and keeping the rest is a privacy
 * liability for no benefit: these are people who are not customers and never
 * will be. Counts are kept on the batch so a charge is still explainable
 * without retaining the numbers it was spent on.
 *
 * Runs after every channel has finished, because a row can be absent from
 * WhatsApp and present on Telegram — deciding per channel would throw away
 * matches the other channel had not answered yet.
 */
/**
 * What becomes of one row once every channel has had its turn.
 *
 * The distinction that matters is between "not there" and "we never got an
 * answer". Treating the second as the first is how an outage turns into a
 * silently emptied upload reported back as a list with nobody on it, so a row
 * is only deletable when every requested channel actually answered.
 */
export function rowFate(
  results: unknown, channels: $Enums.Channel[],
): "keep" | "drop" | "unanswered" {
  const res = (results ?? {}) as Record<string, { verdict?: string } | undefined>;
  if (channels.some((c) => res[c]?.verdict === "REGISTERED")) return "keep";
  const answered = channels.every((c) => res[c]?.verdict === "NOT_REGISTERED");
  return answered ? "drop" : "unanswered";
}

export async function discardNonMatches(
  batchId: string, channels: $Enums.Channel[],
): Promise<{ matched: number; discarded: number; unanswered: number }> {
  const rows = await prisma.batchItem.findMany({
    where: { batchId },
    select: { id: true, e164: true, results: true },
  });

  const keep: string[] = [];
  const drop: string[] = [];
  const dropNumbers: string[] = [];
  let unanswered = 0;

  for (const r of rows) {
    switch (rowFate(r.results, channels)) {
      case "keep": keep.push(r.id); break;
      case "unanswered": unanswered++; break;
      case "drop":
        drop.push(r.id);
        if (r.e164) dropNumbers.push(r.e164);
        break;
    }
  }

  if (drop.length > 0) {
    await prisma.batchItem.deleteMany({ where: { id: { in: drop } } });
    // The billing trail stays as counts on the batch; the per-number records
    // for misses go too, or the numbers would simply live somewhere else.
    for (let i = 0; i < dropNumbers.length; i += 500) {
      await prisma.checkRecord.deleteMany({
        where: { batchId, e164: { in: dropNumbers.slice(i, i + 500) } },
      }).catch(() => {});
    }
  }

  return { matched: keep.length, discarded: drop.length, unanswered };
}

async function runBatch(
  batchId: string, userId: string, channels: $Enums.Channel[],
): Promise<void> {
  // Guard against two runners for one batch, which resume could otherwise cause.
  if (running.has(batchId)) return;
  running.add(batchId);
  let refunded = 0;

  try {
    const rows = await prisma.batchItem.findMany({
      where: { batchId, status: "OK" },
      orderBy: { rowNumber: "asc" },
      select: { id: true, e164: true, results: true },
    });
    const items: BatchRow[] = rows.filter(
      (r): r is typeof r & { e164: string } => Boolean(r.e164),
    );

    // Channels are separate accounts, so running them at the same time costs
    // nothing in per-account request rate and halves the wall clock.
    const owed = await Promise.all(
      channels.map((c) => runChannel(batchId, userId, c, items).catch(() => 0)),
    );
    refunded = owed.reduce((a, b) => a + b, 0);

    if (refunded > 0) {
      await refund(userId, refunded, `Batch refund — ${refunded} lookup(s) could not be answered`);
    }

    // Only once every channel has answered: a number absent from WhatsApp may
    // still be on Telegram, and purging per channel would delete those.
    const { matched, discarded } = await discardNonMatches(batchId, channels);

    await prisma.checkBatch.update({
      where: { id: batchId },
      data: {
        status: running.has(batchId) ? "DONE" : "STOPPED",
        creditsRefunded: refunded,
        matched,
        discarded,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    const batch = await prisma.checkBatch.findUnique({
      where: { id: batchId }, select: { creditsSpent: true, done: true },
    });
    const owed = Math.max(0, (batch?.creditsSpent ?? 0) - (batch?.done ?? 0) - refunded);
    if (owed > 0) await refund(userId, owed, "Batch failed — unused credits returned").catch(() => {});

    // A failed run must not leave the misses behind either — the numbers are
    // dropped on every exit path, not only the happy one.
    const purge = await discardNonMatches(batchId, channels).catch(() => null);

    await prisma.checkBatch.update({
      where: { id: batchId },
      data: {
        status: "FAILED",
        error: err instanceof Error ? err.message.slice(0, 400) : String(err),
        creditsRefunded: refunded + owed,
        ...(purge ? { matched: purge.matched, discarded: purge.discarded } : {}),
        finishedAt: new Date(),
      },
    }).catch(() => {});
  } finally {
    running.delete(batchId);
  }
}
