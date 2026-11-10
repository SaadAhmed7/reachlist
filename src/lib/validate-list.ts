/**
 * Input preparation for the presence checks on /validate.
 *
 * One list is prepared once, then asked of every connected channel. So a row
 * carries the facts that are true everywhere — is it a real number, is it a
 * duplicate, can this range hold a messaging account at all — plus a slot per
 * channel for the answer only a live session can give.
 *
 * Pure and DOM-free so it runs on the server route and in vitest unchanged.
 */
import {
  getCountries,
  getCountryCallingCode,
  type CountryCode,
} from "libphonenumber-js/max";
import type { Channel } from "./presence/types";
import { normalizePhone, type LineHint } from "./phone";

/** What a live lookup can say. */
export type Verdict = "REGISTERED" | "NOT_REGISTERED" | "UNKNOWN" | "PENDING";

/** What the offline pass can say, before any channel is involved. */
export type RowStatus =
  /** A real, unique number — ask every connected channel about it. */
  | "OK"
  | "INVALID"
  | "DUPLICATE"
  /** A range that cannot hold a messaging account anywhere. Never looked up. */
  | "IMPOSSIBLE";

/**
 * Last activity, as coarse as the service chose to be.
 *
 * Telegram only hands over an exact `wasOnline` when the account publishes its
 * last-seen to everybody, and downgrades everyone to buckets when the *linked*
 * account hides its own. So `bucket` and `hidden` are the common cases, and the
 * UI must never imply more precision than the kind carries.
 */
export type LastSeen =
  | { kind: "online" }
  | { kind: "at"; at: number }
  | { kind: "bucket"; bucket: "recently" | "week" | "month" }
  | { kind: "hidden" };

export type ChannelResult = {
  verdict: Verdict;
  reason: string;
  /** Only ever set by channels that expose it; WhatsApp has no equivalent. */
  lastSeen?: LastSeen;
};

export type Row = {
  /** 1-based position in the submitted list, so a user can find the line. */
  index: number;
  raw: string;
  e164: string | null;
  countryCode: string | null;
  status: RowStatus;
  /** Explains a non-OK status. Empty when the row is simply fine. */
  reason: string;
  /** Per-channel answers. Absent until that channel is asked. */
  results: Partial<Record<Channel, ChannelResult>>;
};

/**
 * Ranges that cannot hold an account on any of these services, so asking is a
 * wasted lookup and pointless exposure. Mirrors NEVER_WHATSAPP in
 * scripts/whatsapp-check.ts.
 */
const IMPOSSIBLE: Partial<Record<LineHint, string>> = {
  fixed_line: "Landline",
  toll_free: "Toll-free number",
  premium_rate: "Premium rate number",
  shared_cost: "Shared cost number",
  uan: "UAN",
  voicemail: "Voicemail number",
  pager: "Pager",
};

const INVALID_REASON: Record<"empty" | "unparseable" | "invalid", string> = {
  empty: "Blank",
  unparseable: "Not a phone number",
  invalid: "Not valid for its country's numbering plan",
};

/**
 * Excel rewrites a long number as 9.23001e+11 on open, and the lost digits are
 * not recoverable. Worth its own message: the file is damaged upstream, and
 * re-exporting this list does not fix it.
 */
const SCIENTIFIC = /^\d(\.\d+)?[eE][+-]?\d+$/;

export type PrepareContext = {
  /** Country assumed for numbers written without a + or 00 prefix. */
  defaultRegion: string;
  /** E.164 numbers already seen in THIS list. Mutated as rows are prepared. */
  seen: Set<string>;
};

/** Resolve what can be resolved offline; leave the rest for the sessions. */
export function prepareNumber(
  raw: string,
  index: number,
  ctx: PrepareContext,
): Row {
  const row = (status: RowStatus, reason: string, e164: string | null = null,
               countryCode: string | null = null): Row =>
    ({ index, raw, status, reason, e164, countryCode, results: {} });

  if (SCIENTIFIC.test(raw.trim().replace(/\s/g, ""))) {
    return row("INVALID", "Excel scientific notation — the real digits are gone");
  }

  const r = normalizePhone(raw, ctx.defaultRegion);
  if (!r.ok) return row("INVALID", INVALID_REASON[r.reason]);

  // Dedupe after normalization, so +92 300 1234567 and 03001234567 collapse.
  if (ctx.seen.has(r.e164)) {
    return row("DUPLICATE", "Already in this list", r.e164, r.countryCode);
  }
  ctx.seen.add(r.e164);

  const impossible = IMPOSSIBLE[r.hint];
  if (impossible) {
    return row("IMPOSSIBLE", `${impossible} — cannot register`, r.e164, r.countryCode);
  }

  return row("OK", "", r.e164, r.countryCode);
}

/** Queue a prepared list for a channel that is about to be asked. */
export function armForChannel(rows: Row[], channel: Channel): Row[] {
  const pending: Row[] = [];
  for (const r of rows) {
    if (r.status !== "OK") continue;
    r.results[channel] = { verdict: "PENDING", reason: "Queued" };
    pending.push(r);
  }
  return pending;
}

/** The answer for one row on one channel, folding in the offline verdicts. */
export function verdictFor(row: Row, channel: Channel): Verdict | RowStatus {
  if (row.status === "IMPOSSIBLE") return "NOT_REGISTERED";
  if (row.status !== "OK") return row.status;
  return row.results[channel]?.verdict ?? "PENDING";
}

// ------------------------------------------------------------------ input

const DELIMITED = /[,;\t|]/;
// `eE` is here so Excel's 9.23001e+11 is recognized as the phone cell and
// reported as corruption, rather than skipped — leaving the name cell to be
// blamed for the row.
const PHONE_CHARS = /^['+0-9eE\s\-().]+$/;
/** 2025-03-14 and 03/04/2025 both survive PHONE_CHARS; they are not numbers. */
const DATE_LIKE = /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/;
const HEADER_WORD = /\b(phone|number|mobile|cell|msisdn|whatsapp|telegram|contact|tel)\b/i;

const digits = (s: string) => (s.match(/\d/g) ?? []).length;

/**
 * Is this cell plausibly the phone one? E.164 allows 15 digits; below 7 no
 * country has a dialable subscriber number, which is what rules out house
 * numbers, quantities and order ids.
 */
function isCandidate(cell: string): boolean {
  const n = digits(cell);
  if (n < 7 || n > 15) return false;
  if (DATE_LIKE.test(cell)) return false;
  return PHONE_CHARS.test(cell);
}

export type Extraction = {
  numbers: string[];
  /** The header line, if one was recognized and dropped. Surfaced in the UI so
   *  a skipped line is never a silent deletion. */
  headerSkipped: string | null;
};

/**
 * Pull one number per line out of whatever was pasted or uploaded.
 *
 * Deliberately does not ask for a column mapping the way the import flow does.
 * A one-off check has to accept a pasted column, a `name,phone,email` export
 * and a semicolon-separated European CSV without a setup step. Lines that yield
 * nothing are still returned verbatim, so they show up as INVALID rather than
 * vanishing.
 */
export function extractNumbers(text: string): Extraction {
  const lines = text.split(/\r?\n/);
  const numbers: string[] = [];
  let headerSkipped: string | null = null;

  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (t === "") continue;

    const cells = DELIMITED.test(t)
      ? t.split(DELIMITED).map((c) => c.trim().replace(/^"(.*)"$/, "$1"))
      : [t];

    const candidates = cells.filter(isCandidate);

    if (candidates.length === 0) {
      // Only the first line gets to be a header, and only if it names a phone
      // column. Anything else is reported back to the user as a bad row.
      if (i === 0 && headerSkipped === null && digits(t) === 0 && HEADER_WORD.test(t)) {
        headerSkipped = t;
        continue;
      }
      // The whole line, not cells[0] — otherwise a row whose phone cell is
      // junk gets reported under the name sitting next to it.
      numbers.push(t);
      continue;
    }

    // An explicitly international cell beats a bare one; otherwise take the
    // longest, which beats a postcode sitting next to the real number.
    const intl = candidates.find((c) => c.startsWith("+") || c.replace(/\D/g, "").startsWith("00"));
    numbers.push(intl ?? candidates.sort((a, b) => digits(b) - digits(a))[0]);
  }

  return { numbers, headerSkipped };
}

// ----------------------------------------------------------------- output

/** Counts that describe the list itself, regardless of any channel. */
export type ListSummary = {
  total: number;
  checkable: number;
  invalid: number;
  duplicate: number;
  impossible: number;
};

export function summarizeList(rows: readonly Row[]): ListSummary {
  const s: ListSummary = { total: rows.length, checkable: 0, invalid: 0, duplicate: 0, impossible: 0 };
  for (const r of rows) {
    if (r.status === "OK") s.checkable++;
    else if (r.status === "INVALID") s.invalid++;
    else if (r.status === "DUPLICATE") s.duplicate++;
    else s.impossible++;
  }
  return s;
}

/** Counts for one channel's answers. */
export type ChannelSummary = {
  registered: number;
  notRegistered: number;
  unknown: number;
  pending: number;
};

export function summarizeChannel(rows: readonly Row[], channel: Channel): ChannelSummary {
  const s: ChannelSummary = { registered: 0, notRegistered: 0, unknown: 0, pending: 0 };
  for (const r of rows) {
    if (r.status === "INVALID" || r.status === "DUPLICATE") continue;
    const v = verdictFor(r, channel);
    if (v === "REGISTERED") s.registered++;
    else if (v === "NOT_REGISTERED") s.notRegistered++;
    else if (v === "UNKNOWN") s.unknown++;
    else s.pending++;
  }
  return s;
}

const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const CELL: Record<string, string> = {
  REGISTERED: "yes",
  NOT_REGISTERED: "no",
  UNKNOWN: "unknown",
  PENDING: "",
  INVALID: "",
  DUPLICATE: "",
  IMPOSSIBLE: "no",
};

/**
 * Export every row, including the bad ones — the rejects are the part worth
 * having, because they are the user's own data handed back with a reason.
 * A leading apostrophe keeps Excel from turning +923001234567 into a formula.
 */
/**
 * The newest age, in days, that a last-seen answer can *guarantee*.
 *
 * Telegram's buckets are ranges, not points: "within a week" could be two days
 * ago or six. So a day filter can only include rows it can prove, and this
 * returns the upper bound of each answer — `recently` is at most 3 days old,
 * `week` at most 7, `month` at most 30. Anything we cannot bound returns
 * Infinity, which keeps it out of a filter rather than quietly assuming it
 * qualifies.
 */
export function lastSeenMaxAgeDays(ls: LastSeen | null | undefined): number {
  if (!ls) return Infinity;
  switch (ls.kind) {
    case "online": return 0;
    case "at": return Math.max(0, (Date.now() / 1000 - ls.at) / 86_400);
    case "bucket":
      return ls.bucket === "recently" ? 3 : ls.bucket === "week" ? 7 : 30;
    default: return Infinity; // hidden — no claim can be made
  }
}

/** Stable, sortable text for a spreadsheet — never a relative phrase. */
export function lastSeenCell(ls: LastSeen | undefined): string {
  if (!ls) return "";
  if (ls.kind === "online") return "online";
  if (ls.kind === "at") return new Date(ls.at * 1000).toISOString().slice(0, 16).replace("T", " ");
  if (ls.kind === "bucket") return `within ${ls.bucket === "week" ? "a week" : ls.bucket === "month" ? "a month" : "~3 days"}`;
  return "hidden";
}

export function toCsv(rows: readonly Row[], channels: readonly Channel[]): string {
  // Only Telegram reports activity, so the column appears only when asked for.
  const seenCols = channels.filter((c) => c === "telegram");
  const header = [
    "row", "input", "e164", "country", "status", ...channels,
    ...seenCols.map((c) => `${c}_last_seen`), "notes",
  ];
  const body = rows.map((r) => {
    const notes = [
      r.reason,
      ...channels.map((c) => {
        const res = r.results[c];
        return res && res.verdict === "UNKNOWN" ? `${c}: ${res.reason}` : "";
      }),
    ].filter(Boolean).join("; ");

    return [
      String(r.index),
      r.raw,
      r.e164 ? `'${r.e164}` : "",
      r.countryCode ?? "",
      r.status.toLowerCase(),
      ...channels.map((c) => CELL[verdictFor(r, c)] ?? ""),
      ...seenCols.map((c) => lastSeenCell(r.results[c]?.lastSeen)),
      notes,
    ].map(quote).join(",");
  });
  return [header.join(","), ...body].join("\r\n");
}

/** Country list for the "numbers without a + belong to…" selector. */
export function countryOptions(): { code: string; label: string }[] {
  const names =
    typeof Intl !== "undefined" && "DisplayNames" in Intl
      ? new Intl.DisplayNames(["en"], { type: "region" })
      : null;

  return getCountries()
    .map((code: CountryCode) => ({
      code,
      label: `${names?.of(code) ?? code} (+${getCountryCallingCode(code)})`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
