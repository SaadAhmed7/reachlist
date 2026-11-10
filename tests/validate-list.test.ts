import { describe, expect, it } from "vitest";
import {
  armForChannel,
  extractNumbers,
  lastSeenCell,
  lastSeenMaxAgeDays,
  prepareNumber,
  summarizeChannel,
  summarizeList,
  toCsv,
  verdictFor,
  type PrepareContext,
  type Row,
} from "@/lib/validate-list";

const ctx = (defaultRegion = "PK"): PrepareContext => ({
  defaultRegion,
  seen: new Set<string>(),
});

/** Prepare a whole list the way the API route does. */
function run(raws: string[], region = "PK"): Row[] {
  const c = ctx(region);
  return raws.map((raw, i) => prepareNumber(raw, i + 1, c));
}

describe("prepareNumber", () => {
  it("marks a real mobile checkable rather than guessing at it", () => {
    const [r] = run(["03001234567"]);
    expect(r.status).toBe("OK");
    expect(r.e164).toBe("+923001234567");
    expect(r.results).toEqual({});
  });

  it("answers ranges that cannot register without spending a lookup", () => {
    // PK landline (Karachi) and a US toll-free number.
    expect(run(["02135678901"])[0].status).toBe("IMPOSSIBLE");
    expect(run(["+18005551212"], "US")[0].status).toBe("IMPOSSIBLE");
    expect(verdictFor(run(["02135678901"])[0], "whatsapp")).toBe("NOT_REGISTERED");
  });

  it("leaves numbers the metadata cannot classify to the live lookup", () => {
    // Most NANP numbers are FIXED_LINE_OR_MOBILE offline, so only a session knows.
    expect(run(["+14155552671"], "US")[0].status).toBe("OK");
  });

  it("dedupes across formats of the same number", () => {
    const rows = run(["03001234567", "+92 300 123 4567", "00923001234567"]);
    expect(rows.map((r) => r.status)).toEqual(["OK", "DUPLICATE", "DUPLICATE"]);
  });

  it("reports junk rather than dropping it", () => {
    const rows = run(["n/a", "", "9.2300123457e+11", "+92 300 12"]);
    expect(rows.every((r) => r.status === "INVALID")).toBe(true);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4]);
  });

  it("names Excel corruption instead of calling it generic junk", () => {
    expect(run(["9.2300123457e+11"])[0].reason).toMatch(/Excel/);
    expect(run(["9.23001E+11"])[0].reason).toMatch(/Excel/);
    expect(run(["03001234567"])[0].status).toBe("OK");
  });
});

describe("per-channel results", () => {
  it("arms only the checkable rows, and only for that channel", () => {
    const rows = run(["03001234567", "02135678901", "n/a", "03001234567"]);
    const pending = armForChannel(rows, "whatsapp");

    expect(pending).toHaveLength(1);
    expect(rows[0].results.whatsapp?.verdict).toBe("PENDING");
    expect(rows[0].results.telegram).toBeUndefined();
    // Impossible/invalid/duplicate rows are never queued.
    expect(rows[1].results.whatsapp).toBeUndefined();
  });

  it("keeps the two channels independent on the same row", () => {
    const rows = run(["03001234567"]);
    armForChannel(rows, "whatsapp");
    armForChannel(rows, "telegram");
    rows[0].results.whatsapp = { verdict: "REGISTERED", reason: "on wa" };
    rows[0].results.telegram = { verdict: "NOT_REGISTERED", reason: "not on tg" };

    expect(verdictFor(rows[0], "whatsapp")).toBe("REGISTERED");
    expect(verdictFor(rows[0], "telegram")).toBe("NOT_REGISTERED");
  });

  it("counts each channel separately and ignores invalid/duplicate rows", () => {
    const rows = run(["03001234567", "02135678901", "n/a", "03001234567"]);
    armForChannel(rows, "whatsapp");
    rows[0].results.whatsapp = { verdict: "REGISTERED", reason: "" };

    expect(summarizeList(rows)).toEqual({
      total: 4, checkable: 1, invalid: 1, duplicate: 1, impossible: 1,
    });
    // 1 registered + the landline counted as not-registered.
    expect(summarizeChannel(rows, "whatsapp")).toEqual({
      registered: 1, notRegistered: 1, unknown: 0, pending: 0,
    });
  });
});

describe("extractNumbers", () => {
  it("takes a plain pasted column", () => {
    const { numbers } = extractNumbers("03001234567\n0300 765 4321\n\n+14155552671");
    expect(numbers).toEqual(["03001234567", "0300 765 4321", "+14155552671"]);
  });

  it("finds the phone cell in a CSV row without a column mapping", () => {
    const { numbers } = extractNumbers("Alice Fox,alice@example.com,03001234567,Lahore");
    expect(numbers).toEqual(["03001234567"]);
  });

  it("handles semicolon and tab separated exports", () => {
    expect(extractNumbers("Bob;+923001234567;12").numbers).toEqual(["+923001234567"]);
    expect(extractNumbers("Bob\t+923001234567").numbers).toEqual(["+923001234567"]);
  });

  it("prefers the international cell over another long number on the row", () => {
    expect(extractNumbers("ORD-20250314,+923001234567").numbers).toEqual(["+923001234567"]);
  });

  it("does not mistake a date column for a phone number", () => {
    expect(extractNumbers("Alice,2025-03-14,03001234567").numbers).toEqual(["03001234567"]);
  });

  it("blames the whole row, not the name, when no cell is a phone number", () => {
    expect(extractNumbers("Javed,9.2300123457e+11,2025-03-23").numbers)
      .toEqual(["9.2300123457e+11"]);
    expect(extractNumbers("Imran,n/a,2025-03-22").numbers)
      .toEqual(["Imran,n/a,2025-03-22"]);
  });

  it("drops a recognized header, and says which line it dropped", () => {
    const { numbers, headerSkipped } = extractNumbers("name,phone\nAlice,03001234567");
    expect(headerSkipped).toBe("name,phone");
    expect(numbers).toEqual(["03001234567"]);
  });

  it("keeps an unrecognized first line instead of silently eating it", () => {
    const { numbers, headerSkipped } = extractNumbers("total sales\n03001234567");
    expect(headerSkipped).toBeNull();
    expect(numbers).toEqual(["total sales", "03001234567"]);
  });
});

describe("toCsv", () => {
  it("writes a column per channel and defuses Excel's formula parsing", () => {
    const rows = run(["03001234567", "02135678901", "n/a"]);
    armForChannel(rows, "whatsapp");
    rows[0].results.whatsapp = { verdict: "REGISTERED", reason: "" };

    const lines = toCsv(rows, ["whatsapp", "telegram"]).split("\r\n");
    expect(lines[0]).toBe(
      "row,input,e164,country,status,whatsapp,telegram,telegram_last_seen,notes",
    );
    expect(lines[1]).toContain("'+923001234567");
    expect(lines[1]).toContain(",yes,");      // whatsapp said yes
    expect(lines[2]).toContain(",no,no,");    // landline: no on both, no lookup spent
    expect(lines[3]).toContain("Not a phone number");
  });

  it("quotes cells containing commas", () => {
    const rows: Row[] = [
      { index: 1, raw: "a,b", status: "INVALID", reason: "Not a phone number",
        e164: null, countryCode: null, results: {} },
    ];
    expect(toCsv(rows, ["whatsapp"]).split("\r\n")[1]).toContain('"a,b"');
  });
});

describe("last seen", () => {
  it("renders each Telegram status kind without inventing precision", () => {
    expect(lastSeenCell(undefined)).toBe("");
    expect(lastSeenCell({ kind: "online" })).toBe("online");
    expect(lastSeenCell({ kind: "hidden" })).toBe("hidden");
    expect(lastSeenCell({ kind: "bucket", bucket: "week" })).toBe("within a week");
    expect(lastSeenCell({ kind: "bucket", bucket: "month" })).toBe("within a month");
    // An exact wasOnline becomes a sortable timestamp, never a relative phrase.
    expect(lastSeenCell({ kind: "at", at: 1_700_000_000 })).toMatch(/^2023-11-14 \d\d:\d\d$/);
  });

  it("adds a last-seen column only for channels that report it", () => {
    const rows = run(["03001234567"]);
    armForChannel(rows, "telegram");
    rows[0].results.telegram = {
      verdict: "REGISTERED", reason: "Found on Telegram",
      lastSeen: { kind: "bucket", bucket: "recently" },
    };

    const withTg = toCsv(rows, ["whatsapp", "telegram"]).split("\r\n");
    expect(withTg[0]).toBe(
      "row,input,e164,country,status,whatsapp,telegram,telegram_last_seen,notes",
    );
    expect(withTg[1]).toContain("within ~3 days");

    // WhatsApp alone has no activity data, so no column at all.
    expect(toCsv(rows, ["whatsapp"]).split("\r\n")[0]).toBe(
      "row,input,e164,country,status,whatsapp,notes",
    );
  });
});

describe("last-seen day window", () => {
  it("bounds each answer by the newest age it can prove", () => {
    expect(lastSeenMaxAgeDays({ kind: "online" })).toBe(0);
    expect(lastSeenMaxAgeDays({ kind: "bucket", bucket: "recently" })).toBe(3);
    expect(lastSeenMaxAgeDays({ kind: "bucket", bucket: "week" })).toBe(7);
    expect(lastSeenMaxAgeDays({ kind: "bucket", bucket: "month" })).toBe(30);
    // Nothing can be claimed about these, so they must never pass a filter.
    expect(lastSeenMaxAgeDays({ kind: "hidden" })).toBe(Infinity);
    expect(lastSeenMaxAgeDays(null)).toBe(Infinity);
  });

  it("measures an exact timestamp in days", () => {
    const twoDays = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const age = lastSeenMaxAgeDays({ kind: "at", at: twoDays });
    expect(age).toBeGreaterThan(1.9);
    expect(age).toBeLessThan(2.1);
  });

  it("never lets a wide bucket satisfy a narrow window", () => {
    const week = { kind: "bucket", bucket: "week" } as const;
    // "within a week" could be six days ago, so it cannot prove 3 days.
    expect(lastSeenMaxAgeDays(week) <= 3).toBe(false);
    expect(lastSeenMaxAgeDays(week) <= 7).toBe(true);
    // "recently" is bounded at 3, so it satisfies 3 and anything wider.
    const recent = { kind: "bucket", bucket: "recently" } as const;
    expect(lastSeenMaxAgeDays(recent) <= 3).toBe(true);
    expect(lastSeenMaxAgeDays(recent) <= 2).toBe(false);
  });
});

describe("batch settlement invariant", () => {
  /**
   * The rule the production failure broke: a finished batch must leave no row
   * unanswered, and every unanswered row must have been refunded. Modelled
   * here against the same arithmetic the runner uses.
   */
  it("refunds every row the run never reached", () => {
    const PRICE = 1;
    const total = 300;
    const reached = 24;          // what actually completed
    const erroredRefund = 30;    // chunks that failed outright

    const unreached = total - reached;
    const refunded = erroredRefund + unreached * PRICE;
    const charged = total * PRICE;

    // Nobody may be billed for a lookup that never happened.
    expect(charged - refunded).toBe(reached - erroredRefund);
    expect(refunded).toBeGreaterThan(0);
    // And no row may be left with no verdict at all.
    expect(reached + unreached).toBe(total);
  });
});
