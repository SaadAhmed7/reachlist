/**
 * The one place "not on WhatsApp" could be confused with "no answer".
 *
 * An earlier version of this system treated an unanswered row as a negative
 * and deleted it, which silently emptied a client's uploaded list. These tests
 * exist so that cannot come back through the new driver.
 */
import { describe, expect, it } from "vitest";
import { readUSyncAnswers, type USyncEntry } from "@/lib/presence/whatsapp";

const entry = (id: string, contact: unknown): USyncEntry => ({ id, contact });

describe("readUSyncAnswers", () => {
  it("reads a positive as found", () => {
    const out = readUSyncAnswers([entry("923001234567@s.whatsapp.net", true)], ["+923001234567"]);
    expect(out).toEqual({ "+923001234567": { found: true } });
  });

  it("reads an explicit negative as not found, rather than dropping it", () => {
    const out = readUSyncAnswers([entry("923001234567@s.whatsapp.net", false)], ["+923001234567"]);
    expect(out).toEqual({ "+923001234567": { found: false } });
  });

  it("omits a number the server did not answer for, so it becomes UNKNOWN", () => {
    const out = readUSyncAnswers([], ["+923001234567"]);
    expect(out).toEqual({});
    expect("+923001234567" in out).toBe(false);
  });

  it("does not let one answered number imply anything about an unanswered one", () => {
    const out = readUSyncAnswers(
      [entry("923001234567@s.whatsapp.net", true)],
      ["+923001234567", "+923009999999"],
    );
    expect(out).toEqual({ "+923001234567": { found: true } });
  });

  it("matches on digits, ignoring jid decoration and device suffixes", () => {
    const out = readUSyncAnswers(
      [entry("923001234567:12@s.whatsapp.net", false)],
      ["+92 300 123 4567"],
    );
    expect(out).toEqual({ "+92 300 123 4567": { found: false } });
  });

  it("ignores an entry whose contact field is not a boolean", () => {
    // A protocol change that turned `contact` into an object must read as
    // "no answer", never as a confident negative.
    const out = readUSyncAnswers(
      [entry("923001234567@s.whatsapp.net", { found: false })],
      ["+923001234567"],
    );
    expect(out).toEqual({});
  });

  it("ignores an entry with no id", () => {
    const out = readUSyncAnswers([{ contact: true }], ["+923001234567"]);
    expect(out).toEqual({});
  });

  it("handles a whole batch with a mix of all three outcomes", () => {
    const out = readUSyncAnswers(
      [
        entry("923001111111@s.whatsapp.net", true),
        entry("923002222222@s.whatsapp.net", false),
      ],
      ["+923001111111", "+923002222222", "+923003333333"],
    );
    expect(out).toEqual({
      "+923001111111": { found: true },
      "+923002222222": { found: false },
    });
  });
});
