/**
 * Link a WhatsApp account from the terminal, then verify numbers against it.
 *
 *   npx tsx src/scripts/wa-link.ts                  # show a QR to scan
 *   npx tsx src/scripts/wa-link.ts +9230... +4479...  # check numbers
 *
 * This exists to answer two questions the UI cannot answer on its own: does a
 * verdict from this driver match what the phone says, and what does one linked
 * account actually cost in memory. It uses the real driver, not a copy of it,
 * so a pass here is evidence about the shipped code.
 */
import { whatsapp } from "../lib/presence/whatsapp";
import type { Session } from "../lib/presence/types";

const numbers = process.argv.slice(2).filter((a) => /\d/.test(a));

const session: Session = {
  id: "cli-verify", channel: "whatsapp", status: "starting", qr: null,
  error: null, me: null, handle: null, scratch: null, job: null,
  lastTouched: Date.now(),
};

const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

async function main() {
  console.log(`[rss ${mb()}MB] opening socket...`);
  await whatsapp.open(session);

  let shownQr: string | null = null;
  for (let i = 0; i < 180; i++) {
    if (session.status === "ready") break;
    if (session.status === "failed") throw new Error(session.error ?? "link failed");
    if (session.qr && session.qr !== shownQr) {
      shownQr = session.qr;
      console.log("\nScan this in WhatsApp > Settings > Linked devices:\n");
      const { default: qr } = await import("qrcode");
      console.log(await qr.toString(session.qr, { type: "terminal", small: true }));
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (session.status !== "ready") throw new Error(`never became ready (status: ${session.status})`);
  console.log(`\n[rss ${mb()}MB] linked as ${session.me}`);

  if (numbers.length === 0) {
    console.log("\nNo numbers given, so nothing to check. Linked and idle.");
    console.log(`Steady-state memory for one linked account: ${mb()}MB`);
    await new Promise((r) => setTimeout(r, 5000));
    console.log(`After 5s idle: ${mb()}MB`);
  } else {
    console.log(`\nChecking ${numbers.length} number(s) in one call (batchSize ${whatsapp.batchSize})...`);
    const started = Date.now();
    const out = await whatsapp.lookup(session, numbers);
    const ms = Date.now() - started;

    for (const n of numbers) {
      const a = out[n];
      const verdict = !a ? "UNKNOWN  (no answer — row kept, not charged)"
        : a.found ? "REGISTERED" : "NOT REGISTERED";
      console.log(`  ${n.padEnd(18)} ${verdict}`);
    }
    console.log(`\n${ms}ms for ${numbers.length} number(s) = ${Math.round(ms / numbers.length)}ms each`);
    console.log(`[rss ${mb()}MB]`);
  }

  await whatsapp.close(session, false);
  process.exit(0);
}

main().catch((e) => { console.error("\nFAILED:", e?.message ?? e); process.exit(1); });
