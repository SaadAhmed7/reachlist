"use client";

import { useState } from "react";
import BatchPanel from "./BatchPanel";
import CheckPanel from "./CheckPanel";
import ValidateRunner from "./ValidateRunner";
import type { Channel } from "@/lib/products";

/**
 * One product's working area.
 *
 * The channel choice is already made by which page you are on, so all that is
 * left is how many numbers you have: one, or a list. The free offline product
 * has no single-number mode — typing one number into it would be a slower way
 * of learning what the list view says instantly.
 */
export default function ProductWorkspace({
  slug, name, channels, lastSeen, credits: initial, available, defaultRegion,
}: {
  slug: string;
  name: string;
  channels: Channel[];
  lastSeen: boolean;
  credits: number;
  available: Channel[];
  defaultRegion: string;
}) {
  const [tab, setTab] = useState<"list" | "one">("list");
  const [credits, setCredits] = useState(initial);

  if (channels.length === 0) {
    return <ValidateRunner defaultRegion={defaultRegion} />;
  }

  return (
    <>
      <div className="chips" style={{ marginBottom: 18 }}>
        <span className={"chip" + (tab === "list" ? " sel" : "")} onClick={() => setTab("list")}>
          A list of numbers
        </span>
        <span className={"chip" + (tab === "one" ? " sel" : "")} onClick={() => setTab("one")}>
          One number
        </span>
      </div>

      {tab === "list" ? (
        <BatchPanel
          key={`${slug}-list`}
          available={available}
          defaultRegion={defaultRegion}
          onCredits={setCredits}
          fixedChannels={channels}
          lastSeenFirst={lastSeen}
          runName={name}
        />
      ) : (
        <CheckPanel
          key={`${slug}-one`}
          credits={credits}
          available={available}
          defaultRegion={defaultRegion}
          onCredits={setCredits}
          fixedChannels={channels}
        />
      )}
    </>
  );
}
