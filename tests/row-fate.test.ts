import { describe, expect, it } from "vitest";
import type { $Enums } from "@prisma/client";
import { rowFate } from "../src/lib/batch";

const BOTH = ["WHATSAPP", "TELEGRAM"] as $Enums.Channel[];
const WA = ["WHATSAPP"] as $Enums.Channel[];

describe("rowFate", () => {
  it("keeps a row registered on the only requested channel", () => {
    expect(rowFate({ WHATSAPP: { verdict: "REGISTERED" } }, WA)).toBe("keep");
  });

  it("keeps a row registered on either channel", () => {
    expect(rowFate(
      { WHATSAPP: { verdict: "NOT_REGISTERED" }, TELEGRAM: { verdict: "REGISTERED" } },
      BOTH,
    )).toBe("keep");
  });

  it("drops a row only when every channel said not registered", () => {
    expect(rowFate(
      { WHATSAPP: { verdict: "NOT_REGISTERED" }, TELEGRAM: { verdict: "NOT_REGISTERED" } },
      BOTH,
    )).toBe("drop");
  });

  // The bug this guards: an outage used to look exactly like "nobody is on
  // WhatsApp", and the client's numbers were deleted on the strength of it.
  it("does not drop a row nobody could answer", () => {
    expect(rowFate(
      { WHATSAPP: { verdict: "UNKNOWN" }, TELEGRAM: { verdict: "UNKNOWN" } },
      BOTH,
    )).toBe("unanswered");
  });

  it("does not drop a row when one channel answered and the other did not", () => {
    expect(rowFate(
      { WHATSAPP: { verdict: "NOT_REGISTERED" }, TELEGRAM: { verdict: "UNKNOWN" } },
      BOTH,
    )).toBe("unanswered");
  });

  it("treats a missing channel entry as unanswered, not as a miss", () => {
    expect(rowFate({ WHATSAPP: { verdict: "NOT_REGISTERED" } }, BOTH)).toBe("unanswered");
    expect(rowFate({}, WA)).toBe("unanswered");
    expect(rowFate(null, WA)).toBe("unanswered");
  });

  // A hit outranks a channel that never answered: the number is reachable
  // either way, so there is nothing to gain by holding it back.
  it("keeps a hit even when another channel is unanswered", () => {
    expect(rowFate(
      { WHATSAPP: { verdict: "REGISTERED" }, TELEGRAM: { verdict: "UNKNOWN" } },
      BOTH,
    )).toBe("keep");
  });
});
