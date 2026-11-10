// `/max` metadata, not the default `/min` build. The min build carries no
// number-type data at all, so getType() returns undefined for most countries
// (every PK number, for one) and the `hint` below is uselessly always "unknown".
// The max bundle is ~150kB larger and is what makes the free landline filter work.
import {
  parsePhoneNumberWithError,
  type CountryCode,
  type NumberType,
} from "libphonenumber-js/max";

export type LineHint =
  | "mobile"
  | "fixed_line"
  | "fixed_line_or_mobile"
  | "toll_free"
  | "premium_rate"
  | "shared_cost"
  | "voip"
  | "personal_number"
  | "pager"
  | "uan"
  | "voicemail"
  | "unknown";

/** libphonenumber's own type names -> ours. Anything unlisted stays "unknown". */
const TYPE_TO_HINT: Partial<Record<NonNullable<NumberType>, LineHint>> = {
  MOBILE: "mobile",
  FIXED_LINE: "fixed_line",
  FIXED_LINE_OR_MOBILE: "fixed_line_or_mobile",
  TOLL_FREE: "toll_free",
  PREMIUM_RATE: "premium_rate",
  SHARED_COST: "shared_cost",
  VOIP: "voip",
  PERSONAL_NUMBER: "personal_number",
  PAGER: "pager",
  UAN: "uan",
  VOICEMAIL: "voicemail",
};

export type NormalizeResult =
  | {
      ok: true;
      e164: string;
      countryCode: string | null;
      nationalNumber: string;
      /** libphonenumber's own type guess. Cheap, offline, and often "unknown" —
       *  it is a pre-filter, not a substitute for a carrier lookup. */
      hint: LineHint;
    }
  | { ok: false; reason: "empty" | "unparseable" | "invalid" };

/** Characters people put in spreadsheet phone columns that carry no meaning. */
const NOISE = /[\s\-(). ​‐-―]/g;

/**
 * Normalize one raw cell into E.164.
 *
 * Handles the things that actually show up in customer CSVs:
 *   "0300 123 4567"      -> +923001234567 (with defaultRegion PK)
 *   "00923001234567"     -> +923001234567
 *   "92-300-1234567"     -> +923001234567
 *   "+92 (300) 123-4567" -> +923001234567
 *   "3.00123e+11"        -> rejected, not silently mangled
 */
export function normalizePhone(
  raw: unknown,
  defaultRegion: string,
): NormalizeResult {
  if (raw === null || raw === undefined) return { ok: false, reason: "empty" };

  let s = String(raw).trim();
  if (s === "") return { ok: false, reason: "empty" };

  // Excel turns long numbers into scientific notation. Recovering a real number
  // from "3.00123E+11" is guesswork, so refuse it loudly instead.
  if (/e\+?\d+$/i.test(s.replace(NOISE, ""))) {
    return { ok: false, reason: "unparseable" };
  }

  s = s.replace(NOISE, "");

  // International prefix written as 00 (common outside NANP).
  if (s.startsWith("00")) s = "+" + s.slice(2);

  // Some exports keep a leading apostrophe to force text formatting.
  if (s.startsWith("'")) s = s.slice(1);

  if (!/^\+?\d+$/.test(s)) return { ok: false, reason: "unparseable" };

  try {
    const parsed = parsePhoneNumberWithError(
      s,
      s.startsWith("+") ? undefined : (defaultRegion as CountryCode),
    );
    if (!parsed.isValid()) return { ok: false, reason: "invalid" };

    const t = parsed.getType();
    const hint: LineHint = (t && TYPE_TO_HINT[t]) || "unknown";

    return {
      ok: true,
      e164: parsed.number,
      countryCode: parsed.country ?? null,
      nationalNumber: parsed.nationalNumber,
      hint,
    };
  } catch {
    return { ok: false, reason: "unparseable" };
  }
}
