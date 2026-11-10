"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./ui/Toast";
import type { LastSeen } from "@/lib/validate-list";

type Channel = "WHATSAPP" | "TELEGRAM";

type Outcome = {
  verdict: "REGISTERED" | "NOT_REGISTERED" | "UNKNOWN";
  lastSeen?: LastSeen | null;
  charged: number;
  error?: string;
};

type CheckResponse = {
  e164: string;
  country: string | null;
  results: Partial<Record<Channel, Outcome>>;
  charged: number;
  credits: number;
};

type HistoryRow = {
  id: string; channel: Channel; e164: string; verdict: string;
  lastSeen: LastSeen | null; credits: number; createdAt: string;
};

const META: Record<Channel, { label: string; key: string }> = {
  WHATSAPP: { label: "WhatsApp", key: "whatsapp" },
  TELEGRAM: { label: "Telegram", key: "telegram" },
};

const VERDICT_UI: Record<string, { text: string; cls: string }> = {
  REGISTERED: { text: "Registered", cls: "yes" },
  NOT_REGISTERED: { text: "Not found", cls: "no" },
  UNKNOWN: { text: "Couldn't check", cls: "unk" },
};

const DAY = 86_400;

/** Vague where the data is vague — a bucket never becomes a date. */
function lastSeenText(ls: LastSeen | null | undefined): string {
  if (!ls) return "—";
  switch (ls.kind) {
    case "online": return "online now";
    case "bucket":
      return ls.bucket === "recently" ? "within ~3 days"
        : ls.bucket === "week" ? "within a week" : "within a month";
    case "at": {
      const secs = Math.max(0, Date.now() / 1000 - ls.at);
      if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))} min ago`;
      if (secs < DAY) return `${Math.round(secs / 3600)} h ago`;
      if (secs < 30 * DAY) return `${Math.round(secs / DAY)} d ago`;
      return new Date(ls.at * 1000).toISOString().slice(0, 10);
    }
    default: return "hidden";
  }
}

export default function CheckPanel({
  credits: initialCredits, available, defaultRegion, onCredits, fixedChannels,
}: {
  credits: number;
  available: Channel[];
  defaultRegion: string;
  onCredits?: (n: number) => void;
  /** Set by a product page: these channels are checked and the picker is gone. */
  fixedChannels?: Channel[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [credits, setCredits] = useState(initialCredits);
  const [number, setNumber] = useState("");
  const [region, setRegion] = useState(defaultRegion);
  const [freePick, setFreePick] = useState<Channel[]>(available);
  const picked = fixedChannels ?? freePick;
  const [countries, setCountries] = useState<{ code: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResponse | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const lib = useRef<typeof import("@/lib/validate-list") | null>(null);
  const loadCountries = useCallback(async () => {
    lib.current ??= await import("@/lib/validate-list");
    return lib.current.countryOptions();
  }, []);

  useEffect(() => {
    let live = true;
    loadCountries().then((c) => { if (live) setCountries(c); }).catch(() => {});
    return () => { live = false; };
  }, [loadCountries]);

  const refreshHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/check", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setHistory(d.checks ?? []);
      setCredits(d.credits ?? 0);
      onCredits?.(d.credits ?? 0);
    } catch { /* transient */ }
  }, [onCredits]);

  useEffect(() => { void refreshHistory(); }, [refreshHistory]);

  const cost = picked.length;
  const canRun = picked.length > 0 && number.trim() !== "" && !busy && credits >= cost;

  function toggle(c: Channel) {
    setFreePick((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  }

  async function run() {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await fetch("/api/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ number, region, channels: picked }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error ?? "Check failed.");
        toast("err", "Check failed", d.error);
        return;
      }
      const hits = Object.values(d.results as Record<string, { verdict: string }>)
        .filter((x) => x.verdict === "REGISTERED").length;
      toast(hits > 0 ? "ok" : "info",
            hits > 0 ? `Found on ${hits} ${hits === 1 ? "service" : "services"}` : "Not found",
            `${d.e164} · ${d.charged} credit${d.charged === 1 ? "" : "s"} charged`);
      setResult(d);
      setCredits(d.credits);
      onCredits?.(d.credits);
      void refreshHistory();
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel anim">
        <div className="field-row">
          <label className="field grow">
            <span>Phone number</span>
            <input
              value={number} disabled={busy} placeholder="03001234567 or +923001234567"
              onChange={(e) => setNumber(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canRun) void run(); }}
            />
          </label>
          <label className="field">
            <span>Country for local format</span>
            <select value={region} disabled={busy} onChange={(e) => setRegion(e.target.value)}>
              {countries.length === 0
                ? <option value={region}>{region}</option>
                : countries.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
        </div>

        {!fixedChannels && (
          <>
            <p className="sub" style={{ margin: "16px 0 8px" }}>Check on</p>
            <div className="chips">
              {(["WHATSAPP", "TELEGRAM"] as Channel[]).map((c) => {
                const off = !available.includes(c);
                return (
                  <span
                    key={c}
                    className={"chip" + (picked.includes(c) ? " sel" : "") + (off ? " dead" : "")}
                    onClick={() => !off && !busy && toggle(c)}
                    title={off ? "No account connected for this channel" : "1 credit"}
                  >
                    {META[c].label}{off ? " — unavailable" : " · 1 credit"}
                  </span>
                );
              })}
            </div>
          </>
        )}

        <div className="row" style={{ marginTop: 18 }}>
          <button className={canRun ? "primary" : undefined} onClick={run} disabled={!canRun}>
            {busy ? <><i className="spin" />checking…</>
              : cost === 0 ? "Pick a channel"
              : `Check — ${cost} credit${cost === 1 ? "" : "s"}`}
          </button>
          <span className="tail" style={{ marginLeft: 0 }}>
            Balance <b>{credits}</b>
          </span>
        </div>

        {credits < cost && (
          <p className="banner warn" style={{ marginTop: 14 }}>
            Not enough credits. Contact your administrator to top up.
          </p>
        )}
        {error && <p className="banner bad" style={{ marginTop: 14 }}>{error}</p>}
      </div>

      {result && (
        <>
          <div className="step"><span className="n">✓</span><h2>{result.e164}</h2>
            <span className="tail">charged {result.charged}</span>
          </div>
          <div className="scoreboard">
            {(Object.entries(result.results) as [Channel, Outcome][]).map(([ch, out]) => {
              const ui = VERDICT_UI[out.verdict] ?? VERDICT_UI.UNKNOWN;
              return (
                <div key={ch} className="score" data-channel={META[ch].key}>
                  <h3>{META[ch].label}</h3>
                  <div style={{ marginBottom: 8 }}>
                    <span className={"v " + ui.cls} style={{ fontSize: 13, padding: "5px 12px" }}>
                      {ui.text}
                    </span>
                  </div>
                  {ch === "TELEGRAM" && out.verdict !== "UNKNOWN" && (
                    <p className="sub" style={{ margin: 0 }}>
                      Last seen: <strong>{lastSeenText(out.lastSeen)}</strong>
                    </p>
                  )}
                  {out.error && <p className="sub" style={{ margin: 0 }}>{out.error}</p>}
                  {out.charged === 0 && (
                    <p className="sub" style={{ margin: "6px 0 0" }}>Not charged — refunded.</p>
                  )}
                </div>
              );
            })}
          </div>

          {Object.values(result.results).some((r) => r.verdict === "UNKNOWN") && (
            <p className="note" style={{ marginTop: 14 }}>
              A failed lookup is never recorded as a &ldquo;no&rdquo;, and is never
              charged. Try again shortly.
            </p>
          )}
        </>
      )}

      {history.length > 0 && (
        <>
          <div className="step"><span className="n">·</span><h2>Recent checks</h2></div>
          <div className="panel results-table" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr><th>When</th><th>Number</th><th>Channel</th><th>Result</th><th>Last seen</th><th>Cost</th></tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const ui = VERDICT_UI[h.verdict] ?? VERDICT_UI.UNKNOWN;
                  return (
                    <tr key={h.id}>
                      <td style={{ color: "var(--muted)" }}>
                        {new Date(h.createdAt).toLocaleString()}
                      </td>
                      <td className="num">{h.e164}</td>
                      <td>{META[h.channel]?.label ?? h.channel}</td>
                      <td><span className={"v " + ui.cls}>{ui.text}</span></td>
                      <td style={{ color: "var(--muted)" }}>
                        {h.channel === "TELEGRAM" ? lastSeenText(h.lastSeen) : "—"}
                      </td>
                      <td className="num">{h.credits}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
