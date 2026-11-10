"use client";

import BatchPanel from "./BatchPanel";

/**
 * Every past run, with the same result viewer the product pages use.
 *
 * A thin wrapper rather than a second table: the viewer carries the last-seen
 * filter, the copy and download buttons and the "not checked" warning, and
 * two copies of that would drift apart.
 */
export default function BatchHistory() {
  return (
    <BatchPanel
      historyOnly
      available={["WHATSAPP", "TELEGRAM"]}
      defaultRegion="US"
      onCredits={() => {}}
    />
  );
}
