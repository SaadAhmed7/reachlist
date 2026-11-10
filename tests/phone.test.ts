import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/phone";

describe("normalizePhone", () => {
  it("normalizes national-format PK numbers", () => {
    for (const raw of ["03001234567", "0300 123 4567", "0300-123-4567", "(0300) 1234567"]) {
      const r = normalizePhone(raw, "PK");
      expect(r.ok, raw).toBe(true);
      if (r.ok) expect(r.e164).toBe("+923001234567");
    }
  });

  it("handles 00 and + international prefixes", () => {
    const a = normalizePhone("00923001234567", "PK");
    const b = normalizePhone("+92 300 123 4567", "US");
    expect(a.ok && a.e164).toBe("+923001234567");
    expect(b.ok && b.e164).toBe("+923001234567");
  });

  it("ignores the default region when the number is already international", () => {
    const r = normalizePhone("+14155552671", "PK");
    expect(r.ok && r.e164).toBe("+14155552671");
    expect(r.ok && r.countryCode).toBe("US");
  });

  it("strips non-breaking spaces and zero-width junk from spreadsheets", () => {
    const r = normalizePhone("+92 300​1234567", "PK");
    expect(r.ok && r.e164).toBe("+923001234567");
  });

  it("refuses Excel scientific notation instead of guessing", () => {
    const r = normalizePhone("9.2300123457e+11", "PK");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unparseable");
  });

  it("rejects empty, junk and too-short values", () => {
    expect(normalizePhone("", "PK").ok).toBe(false);
    expect(normalizePhone(null, "PK").ok).toBe(false);
    expect(normalizePhone("n/a", "PK").ok).toBe(false);
    expect(normalizePhone("12345", "PK").ok).toBe(false);
  });

  // Regression: the default `libphonenumber-js` build ships "min" metadata with
  // no number-type data, so getType() returned undefined for every PK number and
  // `hint` was silently always "unknown". The import must come from
  // `libphonenumber-js/max` or the free landline filter quietly does nothing.
  it("classifies mobile vs landline instead of returning unknown", () => {
    const mobile = normalizePhone("0300 123 4567", "PK");
    expect(mobile.ok && mobile.hint).toBe("mobile");

    for (const landline of ["0512345678", "042 35678901"]) {
      const r = normalizePhone(landline, "PK");
      expect(r.ok && r.hint, landline).toBe("fixed_line");
    }
  });

  it("does not claim mobile for numbers the metadata cannot separate", () => {
    // Most NANP numbers are genuinely ambiguous offline.
    const r = normalizePhone("+14155552671", "PK");
    expect(r.ok && r.hint).toBe("fixed_line_or_mobile");
  });

  it("rejects a number invalid for its own country", () => {
    const r = normalizePhone("+92 000 0000000", "PK");
    expect(r.ok).toBe(false);
  });
});
