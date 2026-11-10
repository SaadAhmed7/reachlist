"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Modal from "./ui/Modal";
import { useToast } from "./ui/Toast";
import { lastSeenMaxAgeDays, type LastSeen } from "@/lib/validate-list";

type Channel = "WHATSAPP" | "TELEGRAM";

type Quote = {
  totalRows: number; checkable: number; cost: number;
  headerSkipped: string | null; overLimit: boolean; limit: number;
  etaSeconds: number; affordable: boolean; credits: number;
  region: string; invalid: number; duplicate: number; impossible: number;
};

type Item = {
  id: string; rowNumber: number; raw: string; e164: string | null;
  status: string; reason: string | null;
  results: Partial<Record<Channel, { verdict: string; reason?: string; lastSeen?: LastSeen | null }>> | null;
};

type Batch = {
  id: string; name: string; channels: Channel[]; totalRows: number; checkable: number;
  done: number; creditsSpent: number; creditsRefunded: number; status: string;
  matched: number; discarded: number;
  error: string | null; createdAt: string; items?: Item[];
};

const LABEL: Record<Channel, string> = { WHATSAPP: "WhatsApp", TELEGRAM: "Telegram" };
const UI: Record<string, { text: string; cls: string }> = {
  REGISTERED: { text: "Registered", cls: "yes" },
  NOT_REGISTERED: { text: "Not found", cls: "no" },
  UNKNOWN: { text: "Unknown", cls: "unk" },
  IMPOSSIBLE: { text: "Not found", cls: "no" },
  INVALID: { text: "Invalid", cls: "na" },
  DUPLICATE: { text: "Duplicate", cls: "na" },
};
const DAY = 86_400;

function seenText(ls: LastSeen | null | undefined): string {
  if (!ls) return "—";
  if (ls.kind === "online") return "online now";
  if (ls.kind === "bucket") {
    return ls.bucket === "recently" ? "within ~3 days" : ls.bucket === "week" ? "within a week" : "within a month";
  }
  if (ls.kind === "at") {
    const s = Math.max(0, Date.now() / 1000 - ls.at);
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < DAY) return `${Math.round(s / 3600)} h ago`;
    if (s < 30 * DAY) return `${Math.round(s / DAY)} d ago`;
    return new Date(ls.at * 1000).toISOString().slice(0, 10);
  }
  return "hidden";
}

type ActiveMode = "either" | "both" | Channel;

/**
 * The numbers a client actually wants out of a run: registered, nothing else.
 *
 * "either" is the default because selecting both channels usually means "reach
 * them any way I can", not "only the people on both".
 */
function isActive(it: Item, chs: Channel[], mode: ActiveMode): boolean {
  if (it.status !== "OK" || !it.e164) return false;
  const reg = (c: Channel) => it.results?.[c]?.verdict === "REGISTERED";
  if (mode === "either") return chs.some(reg);
  if (mode === "both") return chs.every(reg);
  return reg(mode);
}

/**
 * Was this number seen within `days`?
 *
 * Only Telegram reports activity, and only as an upper bound, so this can only
 * ever include rows it can prove. A row whose last-seen is hidden is excluded
 * and counted separately — it may well qualify, we simply cannot say.
 */
function withinDays(it: Item, days: number | null): boolean {
  if (days === null) return true;
  return lastSeenMaxAgeDays(it.results?.TELEGRAM?.lastSeen) <= days;
}

function activeItems(b: Batch, mode: ActiveMode, days: number | null): Item[] {
  const chs = b.channels ?? [];
  return (b.items ?? []).filter((it) => isActive(it, chs, mode) && withinDays(it, days));
}

function activeNumbers(b: Batch, mode: ActiveMode, days: number | null): string[] {
  return activeItems(b, mode, days).map((it) => it.e164!);
}

/**
 * Clipboard write that still works off https.
 *
 * navigator.clipboard needs a secure context; this app will often be opened on
 * a LAN address over plain http, where it silently does nothing.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Plain duration, rounded the way someone plans around it. */
function humanDuration(secs: number): string {
  if (secs < 90) {
    const n = Math.max(1, Math.round(secs));
    return `${n} second${n === 1 ? "" : "s"}`;
  }
  const m = secs / 60;
  if (m < 90) return `${Math.round(m)} minutes`;
  const h = m / 60;
  if (h < 36) return `${h < 10 ? h.toFixed(1) : Math.round(h)} hours`;
  return `${(h / 24).toFixed(1)} days`;
}

/** Row verdict for one channel, folding in the offline statuses. */
function cell(it: Item, ch: Channel): { text: string; cls: string } {
  if (it.status !== "OK") return UI[it.status] ?? UI.INVALID;
  const v = it.results?.[ch]?.verdict;
  return v ? (UI[v] ?? UI.UNKNOWN) : { text: "waiting", cls: "wait" };
}

export default function BatchPanel({
  available, defaultRegion, onCredits, fixedChannels, lastSeenFirst, runName, historyOnly,
}: {
  available: Channel[];
  defaultRegion: string;
  onCredits: (n: number) => void;
  /**
   * Set by a product page: this panel then checks exactly these channels and
   * the picker disappears. One screen, one job — the client never has to work
   * out which combination of toggles matches what they came here to do.
   */
  fixedChannels?: Channel[];
  /** Open the Telegram activity filter straight away. */
  lastSeenFirst?: boolean;
  /** Label stored against runs started here, so history can be split by product. */
  runName?: string;
  /** Show past runs only — no way to start a new one from here. */
  historyOnly?: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  /**
   * An uploaded file's contents live here, never in the textarea.
   *
   * A controlled <textarea> re-renders its whole value; dropping a 450KB list
   * into one locks the tab for seconds. The file is summarised instead, and
   * only the summary is rendered.
   */
  const fileText = useRef<string>("");
  const [fileLines, setFileLines] = useState(0);
  const [hot, setHot] = useState(false);
  const [region, setRegion] = useState(defaultRegion);
  const [freePick, setFreePick] = useState<Channel[]>(available);
  const picked = fixedChannels ?? freePick;
  const [countries, setCountries] = useState<{ code: string; label: string }[]>([]);

  const [quote, setQuote] = useState<Quote | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [open, setOpen] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ActiveMode>("either");
  /** null = no last-seen filter. */
  // The last-seen product exists to answer "who is still active", so it opens
  // on a week rather than on "Any" — otherwise its first result is identical
  // to the plain Telegram check and the difference looks like nothing.
  const [days, setDays] = useState<number | null>(lastSeenFirst ? 7 : null);
  const [customDays, setCustomDays] = useState("");

  const lib = useRef<typeof import("@/lib/validate-list") | null>(null);
  const load = useCallback(async () => {
    lib.current ??= await import("@/lib/validate-list");
    return lib.current;
  }, []);

  useEffect(() => {
    let live = true;
    load().then((m) => { if (live) setCountries(m.countryOptions()); }).catch(() => {});
    return () => { live = false; };
  }, [load]);

  const scope = fixedChannels ? [...fixedChannels].sort().join() : null;
  const loadBatches = useCallback(async () => {
    const r = await fetch("/api/batch", { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    // On a product page, show only runs of that product. Seeing a Telegram run
    // listed under WhatsApp is exactly the confusion the split was meant to end.
    const all: Batch[] = d.batches ?? [];
    setBatches(scope === null ? all
      : all.filter((b) => [...(b.channels ?? [])].sort().join() === scope));
    onCredits(d.credits ?? 0);
  }, [onCredits, scope]);

  useEffect(() => { void loadBatches(); }, [loadBatches]);

  // Poll while anything is running, and keep the open batch fresh with it.
  const anyRunning = batches.some((b) => b.status === "RUNNING");
  useEffect(() => {
    if (!anyRunning && !open) return;
    const t = setInterval(async () => {
      void loadBatches();
      if (open) {
        const r = await fetch(`/api/batch/${open.id}`, { cache: "no-store" });
        if (r.ok) setOpen((await r.json()).batch);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [anyRunning, open, loadBatches]);

  async function readFile(f: File) {
    try {
      const body = await f.text();
      fileText.current = body;
      setFileLines(body.split(/\r?\n/).filter((l) => l.trim() !== "").length);
      setFileName(f.name);
      setText("");
      setQuote(null);
    } catch { toast("err", "Could not read that file"); }
  }

  function clearFile() {
    fileText.current = "";
    setFileLines(0);
    setFileName("");
    setQuote(null);
  }

  /** Whatever the user actually supplied — an upload wins over the textarea. */
  const payload = () => (fileText.current ? fileText.current : text);

  async function getQuote() {
    // Guard on payload(), not text: an uploaded file lives in a ref so that a
    // large one never renders, and text is empty in that case.
    if (!payload().trim() || picked.length === 0) return;
    setBusy(true);
    try {
      const r = await fetch("/api/batch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: (fileName || runName || "Pasted list"), text: payload(), region, channels: picked, dryRun: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) { toast("err", "Could not read that list", d.error); return; }
      setQuote(d.quote);
    } finally { setBusy(false); }
  }

  async function confirmRun() {
    setBusy(true);
    try {
      const r = await fetch("/api/batch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: (fileName || runName || "Pasted list"), text: payload(), region, channels: picked }),
      });
      const d = await r.json();
      if (!r.ok) { toast("err", "Could not start", d.error); return; }
      toast("ok", "Upload started", `${d.checkable} numbers · ${d.cost} credits charged`);
      setQuote(null); setText(""); clearFile();
      void loadBatches();
      const full = await fetch(`/api/batch/${d.batchId}`, { cache: "no-store" });
      if (full.ok) setOpen((await full.json()).batch);
    } finally { setBusy(false); }
  }

  async function stop(b: Batch) {
    await fetch(`/api/batch/${b.id}`, { method: "DELETE" }).catch(() => {});
    toast("info", "Stopping…", "Answers already received are kept.");
    void loadBatches();
  }

  async function openBatch(b: Batch) {
    const r = await fetch(`/api/batch/${b.id}`, { cache: "no-store" });
    if (r.ok) setOpen((await r.json()).batch);
  }

  async function copyActive(b: Batch) {
    const nums = activeNumbers(b, mode, days);
    if (nums.length === 0) { toast("info", "Nothing to copy", "No active numbers in this run."); return; }
    const ok = await copyText(nums.join("\n"));
    toast(ok ? "ok" : "err",
          ok ? `${nums.length} numbers copied` : "Could not copy",
          ok ? "Paste them straight into your sender." : "Select the text and copy manually.");
  }

  /** Plain list, one number per line — what gets pasted into a sender. */
  function downloadActive(b: Batch) {
    const nums = activeNumbers(b, mode, days);
    if (nums.length === 0) { toast("info", "Nothing to download"); return; }
    save(b, "txt", nums.length, nums.join("\r\n"), "text/plain");
  }

  /** The same filtered rows as a spreadsheet, with why each one qualified. */
  function downloadActiveCsv(b: Batch) {
    const items = activeItems(b, mode, days);
    if (items.length === 0) { toast("info", "Nothing to download"); return; }
    const chs = b.channels ?? [];
    const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = ["number", ...chs, ...(chs.includes("TELEGRAM") ? ["telegram_last_seen"] : [])];
    const lines = items.map((it) => [
      `'${it.e164}`,
      ...chs.map((c) => (it.results?.[c]?.verdict === "REGISTERED" ? "yes" : "no")),
      ...(chs.includes("TELEGRAM") ? [seenText(it.results?.TELEGRAM?.lastSeen)] : []),
    ].map(q).join(","));
    save(b, "csv", items.length, [header.join(","), ...lines].join("\r\n"), "text/csv");
  }

  function save(b: Batch, ext: string, n: number, body: string, mime: string) {
    const blob = new Blob([body], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const tag = days === null ? "active" : `active-${days}d`;
    a.download = `${b.name.replace(/\.[^.]+$/, "")}-${tag}-${n}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadCsv(b: Batch) {
    if (!b.items) return;
    const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const chs = b.channels;
    const header = ["row", "input", "e164", "status", ...chs,
      ...(chs.includes("TELEGRAM") ? ["telegram_last_seen"] : []), "notes"];
    const lines = b.items.map((it) => [
      String(it.rowNumber), it.raw, it.e164 ? `'${it.e164}` : "", it.status.toLowerCase(),
      ...chs.map((c) => {
        const v = it.status !== "OK" ? (it.status === "IMPOSSIBLE" ? "no" : "") : it.results?.[c]?.verdict;
        return v === "REGISTERED" ? "yes" : v === "NOT_REGISTERED" || v === "no" ? "no" : v === "UNKNOWN" ? "unknown" : "";
      }),
      ...(chs.includes("TELEGRAM") ? [seenText(it.results?.TELEGRAM?.lastSeen)] : []),
      it.reason ?? "",
    ].map(q).join(","));
    const blob = new Blob([[header.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${b.name.replace(/\.[^.]+$/, "")}-results.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const canQuote = payload().trim() !== "" && picked.length > 0 && !busy;

  return (
    <>
      {/* ------------------------------------------------- cost confirmation */}
      <Modal
        open={quote !== null}
        title="Confirm this upload"
        description={quote
          ? `${quote.totalRows} rows, of which ${quote.checkable} need a lookup on ${picked.length} channel${picked.length === 1 ? "" : "s"}.`
          : undefined}
        onClose={() => setQuote(null)}
        footer={
          <>
            <button onClick={() => setQuote(null)}>Cancel</button>
            <button className="primary" onClick={confirmRun}
              disabled={busy || !quote?.affordable || quote?.overLimit}>
              {busy ? <><i className="spin" />starting…</> : `Charge ${quote?.cost} credits & run`}
            </button>
          </>
        }
      >
        {quote && (
          <div className="stack">
            <div className="grid">
              <div className="stat"><div className="k">Rows</div><div className="v">{quote.totalRows}</div></div>
              <div className="stat"><div className="k">Chargeable</div><div className="v">{quote.checkable}</div></div>
              <div className="stat"><div className="k">Cost</div><div className="v">{quote.cost}</div></div>
              <div className="stat"><div className="k">Balance after</div>
                <div className="v">{quote.credits - quote.cost}</div></div>
              <div className="stat"><div className="k">Takes about</div>
                <div className="v" style={{ fontSize: 18 }}>{humanDuration(quote.etaSeconds)}</div></div>
            </div>

            {quote.etaSeconds > 3600 && (
              <p className="banner warn">
                This runs for about <strong>{humanDuration(quote.etaSeconds)}</strong>. It keeps
                going if you close the page, and survives a restart — check back from “Your
                uploads”. Lookups are paced to protect the linked accounts, so the only way to
                finish sooner is to connect more of them.
              </p>
            )}
            <p className="note">
              Only numbers found on {picked.map((c) => LABEL[c]).join(" or ")} are kept. The
              rest are deleted when the run finishes and are not stored anywhere.
            </p>
            {quote.totalRows > quote.checkable && (
              <p className="note">
                {quote.totalRows - quote.checkable} rows are invalid, duplicates or
                ranges that cannot hold an account. They are stored with your upload
                but <strong>not charged</strong>.
              </p>
            )}
            {quote.headerSkipped && (
              <p className="note">Header skipped: <code>{quote.headerSkipped}</code></p>
            )}
            {quote.overLimit && (
              <p className="banner bad">
                <strong>{quote.totalRows.toLocaleString()} rows</strong> is past the{" "}
                {quote.limit.toLocaleString()} a single upload can carry. Split it in two.
              </p>
            )}
            {/* A wrong country setting looks exactly like a file full of junk,
                and that is worth saying even when the file is also too big. */}
            {quote.totalRows > 0 &&
              (quote.invalid + quote.impossible) / quote.totalRows > 0.3 && (
              <p className="banner warn">
                {(quote.invalid + quote.impossible).toLocaleString()} of{" "}
                {quote.totalRows.toLocaleString()} rows are invalid or cannot hold an account
                for <strong>{quote.region}</strong>. If these numbers are from another country,
                change “Local numbers are” and price it again — the same ten digits can be a
                valid number in one country and nonsense in another.
              </p>
            )}
            {!quote.affordable && (
              <p className="banner warn">
                Not enough credits — you have {quote.credits} and this needs {quote.cost}.
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------ batch detail */}
      <Modal
        open={open !== null}
        wide
        title={open?.name ?? ""}
        description={open
          ? `${open.totalRows.toLocaleString()} ${open.totalRows === 1 ? "row" : "rows"} · ${open.done}/${open.checkable * open.channels.length} lookups · ${open.creditsSpent - open.creditsRefunded} credits`
          : undefined}
        onClose={() => setOpen(null)}
        footer={
          <>
            {open?.status === "RUNNING" && <button onClick={() => open && stop(open)}>Stop</button>}
            <button onClick={() => open && downloadCsv(open)}>Download CSV</button>
            <button className="primary" onClick={() => setOpen(null)}>Close</button>
          </>
        }
      >
        {open && (() => {
          const chs = open.channels ?? [];
          const nums = activeNumbers(open, mode, days);
          const hasTelegram = chs.includes("TELEGRAM");
          // How many were dropped only because their activity is unknowable.
          const hiddenOut = days === null ? 0
            : (open.items ?? []).filter((it) => isActive(it, chs, mode) && !withinDays(it, days)).length;
          // Misses are deleted once a run ends, so everything stored is a match
          // — except rows no account could answer, which are kept on purpose so
          // an outage is visible instead of looking like an empty result.
          const shownItems = activeItems(open, mode, days);
          const unchecked = (open.items ?? []).filter((it) =>
            chs.some((c) => (it.results?.[c]?.verdict ?? "UNKNOWN") === "UNKNOWN"),
          ).length;
          return (
          <>
            {/* Say it before the results, not after: a run that could not reach
                its accounts looks exactly like a list with nobody on it. */}
            {unchecked > 0 && open.status !== "RUNNING" && (
              <div className="banner warn" style={{ marginBottom: 14 }}>
                <strong>{unchecked.toLocaleString()}</strong> of {open.totalRows.toLocaleString()}{" "}
                {unchecked === 1 ? "number was" : "numbers were"} not checked — no connected
                account was available. You were not charged for{" "}
                {unchecked === 1 ? "it" : "them"}, and {unchecked === 1 ? "it is" : "they are"}{" "}
                still in this list. Reconnect the account, then run the list again.
              </div>
            )}

            {/* What the run was actually for: the reachable numbers, ready to copy. */}
            <div className="active-box">
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <strong style={{ fontSize: 14 }}>
                  {nums.length} active number{nums.length === 1 ? "" : "s"}
                </strong>
                <div className="row" style={{ gap: 7 }}>
                  <button className="primary" onClick={() => copyActive(open)} disabled={nums.length === 0}>
                    Copy all
                  </button>
                  <button onClick={() => downloadActive(open)} disabled={nums.length === 0}>.txt</button>
                  <button onClick={() => downloadActiveCsv(open)} disabled={nums.length === 0}>.csv</button>
                </div>
              </div>

              {chs.length > 1 && (
                <div className="chips" style={{ marginBottom: 10 }}>
                  {([["either", "On either"], ["both", "On both"],
                     ...chs.map((c) => [c, LABEL[c]] as [string, string])] as [ActiveMode, string][])
                    .map(([k, label]) => (
                      <span key={k} className={"chip" + (mode === k ? " sel" : "")} onClick={() => setMode(k)}>
                        {label}
                      </span>
                    ))}
                </div>
              )}

              {hasTelegram && (
                <div style={{ marginBottom: 10 }}>
                  <p className="sub" style={{ margin: "0 0 7px" }}>Seen within</p>
                  <div className="chips">
                    <span className={"chip" + (days === null ? " sel" : "")} onClick={() => { setDays(null); setCustomDays(""); }}>
                      Any
                    </span>
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <span key={d} className={"chip" + (days === d ? " sel" : "")}
                        onClick={() => { setDays(d); setCustomDays(""); }}>
                        {d}d
                      </span>
                    ))}
                    <input
                      type="number" min={1} max={365} placeholder="custom"
                      value={customDays}
                      onChange={(e) => {
                        setCustomDays(e.target.value);
                        const n = Number(e.target.value);
                        setDays(Number.isInteger(n) && n >= 1 ? n : null);
                      }}
                      style={{ width: 92, padding: "5px 10px", fontSize: 12 }}
                    />
                  </div>
                  {hiddenOut > 0 && (
                    <p className="sub" style={{ margin: "8px 0 0" }}>
                      <strong>{hiddenOut}</strong> registered {hiddenOut === 1 ? "number is" : "numbers are"} left
                      out — their last-seen is hidden or older than {days} {days === 1 ? "day" : "days"}.
                      Telegram reports ranges, so only rows provably inside the window are included.
                    </p>
                  )}
                </div>
              )}

              <textarea className="numbers" rows={Math.min(8, Math.max(3, nums.length))} readOnly
                value={nums.join("\n")}
                placeholder={open.status === "RUNNING" ? "Filling in as the run goes…"
                  : unchecked > 0 ? "Nothing to show yet — the numbers above were not checked."
                  : "No active numbers found."}
                onFocus={(e) => e.currentTarget.select()} />
              <p className="sub" style={{ margin: "8px 0 0" }}>
                Registered only{days !== null ? `, seen within ${days} ${days === 1 ? "day" : "days"}` : ""}.
                Numbers not on these services are deleted when the run finishes and are never stored.
              </p>
            </div>

            {open.status === "RUNNING" && (
              <div style={{ marginBottom: 14 }}>
                <div className="bar">
                  <i style={{ width: `${Math.round((open.done / Math.max(1, open.checkable * open.channels.length)) * 100)}%` }} />
                </div>
                <p className="sub" style={{ margin: "8px 0 0" }}>Running — leave this open or come back later.</p>
              </div>
            )}
            {open.discarded > 0 && (
              <p className="sub" style={{ margin: "16px 0 10px" }}>
                {open.discarded.toLocaleString()} of {open.totalRows.toLocaleString()} numbers
                were not on {chs.map((c) => LABEL[c]).join(" or ")} and have been deleted —
                only the reachable ones are kept.
              </p>
            )}

            <div className="results-table" style={{ maxHeight: 300 }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th><th>Number</th>
                    {open.channels.map((c) => <th key={c}>{LABEL[c]}</th>)}
                    {open.channels.includes("TELEGRAM") && <th>Last seen</th>}
                  </tr>
                </thead>
                <tbody>
                  {shownItems.slice(0, 300).map((it) => (
                    <tr key={it.id}>
                      <td className="num" style={{ color: "var(--muted)" }}>{it.rowNumber}</td>
                      <td className="num">{it.e164 ?? it.raw.slice(0, 24)}</td>
                      {open.channels.map((c) => {
                        const u = cell(it, c);
                        return <td key={c}><span className={"v " + u.cls}>{u.text}</span></td>;
                      })}
                      {open.channels.includes("TELEGRAM") && (
                        <td style={{ color: "var(--muted)" }}>{seenText(it.results?.TELEGRAM?.lastSeen)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shownItems.length === 0 && (
              <p className="note" style={{ marginTop: 10 }}>
                {unchecked > 0
                  ? "Nothing was checked, so there is nothing to report yet."
                  : "No reachable numbers found."}
              </p>
            )}
          </>
          );
        })()}
      </Modal>

      {/* ------------------------------------------------------------ upload */}
      {!historyOnly && (
      <div className="panel anim">
        <div
          className={"drop" + (hot ? " hot" : "")}
          onDragOver={(e) => { e.preventDefault(); setHot(true); }}
          onDragLeave={() => setHot(false)}
          onDrop={(e) => { e.preventDefault(); setHot(false); const f = e.dataTransfer.files?.[0]; if (f) void readFile(f); }}
        >
          <strong>{fileName || "Drop a CSV here"}</strong>
          {fileName ? (
            <p>
              {fileLines.toLocaleString()} non-empty {fileLines === 1 ? "line" : "lines"} loaded —{" "}
              <span onClick={clearFile}
                style={{ color: "var(--brand-1)", cursor: "pointer", textDecoration: "underline" }}>
                remove
              </span>
            </p>
          ) : (
            <p>
              or{" "}
              <label style={{ color: "var(--brand-1)", cursor: "pointer", textDecoration: "underline" }}>
                choose a file
                <input type="file" accept=".csv,.tsv,.txt" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); }} />
              </label>{" "}
              — any column layout, no mapping needed
            </p>
          )}
        </div>

        {!fileName && (
          <>
            <p className="sub" style={{ margin: "16px 0 7px" }}>or paste numbers</p>
            <textarea className="numbers" rows={5} spellCheck={false} value={text}
              onChange={(e) => { setText(e.target.value); setQuote(null); }}
              placeholder={"03001234567\n+44 7911 123456\nAlice,alice@example.com,+923009876543"} />
          </>
        )}

        {!fixedChannels && (
          <div className="chips" style={{ marginTop: 16 }}>
            {(["WHATSAPP", "TELEGRAM"] as Channel[]).map((c) => {
              const off = !available.includes(c);
              return (
                <span key={c} className={"chip" + (picked.includes(c) ? " sel" : "") + (off ? " dead" : "")}
                  onClick={() => !off && setFreePick((p) => p.includes(c) ? p.filter((x) => x !== c) : [...p, c])}>
                  {LABEL[c]}{off ? " — unavailable" : ""}
                </span>
              );
            })}
          </div>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <button className={canQuote ? "primary" : undefined} onClick={getQuote} disabled={!canQuote}>
            {busy ? <><i className="spin" />reading…</> : "Price this upload"}
          </button>
          <label className="sub" style={{ margin: 0, marginLeft: "auto" }}>
            Local numbers are{" "}
            <select value={region} onChange={(e) => setRegion(e.target.value)} style={{ width: "auto" }}>
              {countries.length === 0 ? <option value={region}>{region}</option>
                : countries.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
        </div>
      </div>
      )}

      {batches.length === 0 && historyOnly && (
        <p className="note">
          You have not run any lists yet. Pick a product from the menu to start one.
        </p>
      )}

      {batches.length > 0 && (
        <>
          {!historyOnly && (
            <div className="step"><span className="n">·</span><h2>Your uploads</h2></div>
          )}
          <div className="panel results-table" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr><th>File</th><th>Found</th><th>Progress</th><th>Credits</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const total = Math.max(1, b.checkable * (b.channels?.length ?? 1));
                  return (
                    <tr key={b.id}>
                      <td><strong>{b.name}</strong><br />
                        <span style={{ color: "var(--muted)", fontSize: 11 }}>
                          {new Date(b.createdAt).toLocaleString()}
                        </span>
                      </td>
                      <td className="num">
                        <strong style={{ color: "var(--accent)" }}>{b.matched ?? 0}</strong>
                        <span style={{ color: "var(--muted)" }}> / {b.totalRows}</span>
                      </td>
                      <td style={{ minWidth: 130 }}>
                        <div className="bar"><i style={{ width: `${Math.round((b.done / total) * 100)}%` }} /></div>
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>{b.done}/{total}</span>
                      </td>
                      <td className="num">{b.creditsSpent - b.creditsRefunded}</td>
                      <td>
                        <span className={"v " + (b.status === "DONE" ? "yes" : b.status === "RUNNING" ? "wait" : b.status === "FAILED" ? "no" : "unk")}>
                          {b.status.toLowerCase()}
                        </span>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                          {b.status === "RUNNING" && <button onClick={() => stop(b)}>Stop</button>}
                          <button onClick={() => openBatch(b)}>View</button>
                        </div>
                      </td>
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
