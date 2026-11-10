/**
 * Try GREEN-API locally before anything is wired into the product.
 *
 *   npm run greenapi:test
 *   npm run greenapi:test -- +923441110001 +923141110002
 *
 * Prints the full raw response for every call, which is how the undocumented
 * last-seen question gets settled: the docs say CheckAccount returns no
 * activity field, support says it does when available, and this shows which.
 */
import { greenApiCheck, greenApiConfig } from "../lib/presence/greenapi";

/** The three numbers whose real status we already know, from earlier testing. */
const KNOWN: Record<string, { WHATSAPP: boolean; TELEGRAM: boolean }> = {
  "+923441110001": { WHATSAPP: true, TELEGRAM: true },
  "+923141110002": { WHATSAPP: true, TELEGRAM: false },
  "+923121110003": { WHATSAPP: false, TELEGRAM: false },
};

type Checkable = "WHATSAPP" | "TELEGRAM";
const CHANNELS: Checkable[] = ["WHATSAPP", "TELEGRAM"];

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const numbers = args.length > 0 ? args : Object.keys(KNOWN);

  console.log("\n  Configuration");
  for (const c of CHANNELS) {
    const cfg = greenApiConfig(c);
    console.log(
      `    ${c.padEnd(9)} ${cfg ? `instance ${cfg.id} at ${cfg.url}` : "NOT CONFIGURED"}`,
    );
  }

  const configured = CHANNELS.filter((c) => greenApiConfig(c));
  if (configured.length === 0) {
    console.error(
      "\n  Nothing to test. Put GREENAPI_WA_* and/or GREENAPI_TG_* in .env first.\n",
    );
    process.exit(1);
  }

  let checked = 0;
  let matchedExpectation = 0;
  let sawLastSeen = 0;

  for (const number of numbers) {
    console.log(`\n  ${number}`);
    for (const channel of configured) {
      process.stdout.write(`    ${channel.padEnd(9)} `);
      const t0 = Date.now();
      try {
        const r = await greenApiCheck(channel, number);
        const ms = Date.now() - t0;
        checked++;

        const expected = KNOWN[number]?.[channel];
        let verdict = r.found ? "REGISTERED" : "not found";
        if (expected !== undefined) {
          const ok = r.found === expected;
          if (ok) matchedExpectation++;
          verdict += ok ? "   ✓ matches what we know" : `   ✗ EXPECTED ${expected ? "registered" : "not found"}`;
        }
        console.log(`${verdict}   (${ms}ms)`);

        if (r.lastSeen) {
          sawLastSeen++;
          console.log(`               last seen: ${JSON.stringify(r.lastSeen)}`);
        }
        // The point of the exercise: show everything they sent back.
        console.log(`               raw: ${JSON.stringify(r.raw)}`);
      } catch (err) {
        console.log(`ERROR  ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`\n  ${checked} lookups done`);
  if (checked > 0) {
    const known = numbers.filter((n) => KNOWN[n]).length * configured.length;
    if (known > 0) console.log(`  ${matchedExpectation}/${known} agreed with the known answers`);
    console.log(
      sawLastSeen > 0
        ? `  last seen present on ${sawLastSeen} response(s) — the day filter can work through GREEN-API`
        : `  no last-seen field on any response — check the raw output above before trusting support's answer`,
    );
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
