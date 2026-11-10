"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "./ui/Toast";

type Verdict = "mobile" | "maybe" | "landline" | "invalid" | "duplicate";

type Out = {
  raw: string;
  e164: string | null;
  country: string | null;
  verdict: Verdict;
  detail: string;
};

const LABEL: Record<Verdict, { text: string; cls: string }> = {
  mobile: { text: "Mobile", cls: "yes" },
  maybe: { text: "Possibly mobile", cls: "wait" },
  landline: { text: "Cannot hold an account", cls: "no" },
  invalid: { text: "Invalid", cls: "na" },
  duplicate: { text: "Duplicate", cls: "na" },
};

/** Mobile-capable line types. Everything else can never hold an account. */
const CAN_HOLD = new Set(["mobile", "fixed_line_or_mobile", "voip", "personal_number", "unknown"]);

const NICE: Record<string, string> = {
  fixed_line: "Landline",
  toll_free: "Toll-free",
  premium_rate: "Premium rate",
  shared_cost: "Shared cost",
  uan: "UAN",
  voicemail: "Voicemail",
  pager: "Pager",
  voip: "VoIP",
  personal_number: "Personal number",
  fixed_line_or_mobile: "Landline or mobile — cannot tell apart",
  mobile: "Mobile",
  unknown: "Type not published for this country",
};

/**
 * The free product: everything decided offline, in the browser.
 *
 * Nothing is uploaded, nothing is stored, no credits move and no linked
 * account is touched. That is the whole point of it — a client can clean a
 * million-row list down to the numbers worth paying to look up, at no cost and
 * at no risk to the WhatsApp and Telegram accounts.
 */
export default function ValidateRunner({ defaultRegion }: { defaultRegion: string }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const fileText = useRef<string>("");
  const [fileLines, setFileLines] = useState(0);
  const [hot, setHot] = useState(false);
  const [region, setRegion] = useState(defaultRegion);
  const [countries, setCountries] = useState<{ code: string; label: string }[]>([]);
  const [rows, setRows] = useState<Out[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState<"usable" | "all">("usable");

  const lib = useRef<typeof import("@/lib/validate-list") | null>(null);
  const phone = useRef<typeof import("@/lib/phone") | null>(null);
  const load = useCallback(async () => {
    lib.current ??= await import("@/lib/validate-list");
    phone.current ??= await import("@/lib/phone");
    return { list: lib.current, phone: phone.current };
  }, []);

  useEffect(() => {
    let live = true;
    void load().then((m) => { if (live) setCountries(m.list.countryOptions()); }).catch(() => {});
    return () => { live = false; };
  }, [load]);

  async function readFile(f: File) {
    try {
      const body = await f.text();
      fileText.current = body;
      setFileLines(body.split(/\r?\n/).filter((l) => l.trim() !== "").length);
      setFileName(f.name);
      setText("");
      setRows(null);
    } catch { toast("err", "Could not read that file"); }
  }

  function clearFile() {
    fileText.current = "";
    setFileLines(0);
    setFileName("");
    setRows(null);
  }

  const payload = () => (fileText.current ? fileText.current : text);

  async function run() {
    const body = payload();
    if (!body.trim()) return;
    setBusy(true);
    try {
      const { list, phone: ph } = await load();
      const { numbers } = list.extractNumbers(body);
      const seen = new Set<string>();
      const out: Out[] = numbers.map((raw) => {
        const r = ph.normalizePhone(raw, region);
        if (!r.ok) {
          const detail = r.reason === "empty" ? "Blank"
            : r.reason === "unparseable" ? "Not a phone number"
            : "Does not fit its country's numbering plan";
          return { raw, e164: null, country: null, verdict: "invalid", detail };
        }
        if (seen.has(r.e164)) {
          return { raw, e164: r.e164, country: r.countryCode, verdict: "duplicate", detail: "Already in this list" };
        }
        seen.add(r.e164);
        const detail = NICE[r.hint] ?? r.hint;
        if (!CAN_HOLD.has(r.hint)) {
          return { raw, e164: r.e164, country: r.countryCode, verdict: "landline", detail };
        }
        const verdict: Verdict = r.hint === "mobile" ? "mobile" : "maybe";
        return { raw, e164: r.e164, country: r.countryCode, verdict, detail };
      });
      setRows(out);
    } finally { setBusy(false); }
  }

  const usable = (rows ?? []).filter((r) => r.verdict === "mobile" || r.verdict === "maybe");
  const shown = keep === "usable" ? usable : (rows ?? []);
  const nums = usable.map((r) => r.e164!).filter(Boolean);

  function download(ext: "txt" | "csv") {
    if (!rows) return;
    const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const body = ext === "txt"
      ? nums.join("\r\n")
      : [
          ["number", "country", "result", "detail"].join(","),
          ...(keep === "usable" ? usable : rows).map((r) =>
            [`'${r.e164 ?? r.raw}`, r.country ?? "", LABEL[r.verdict].text, r.detail].map(q).join(",")),
        ].join("\r\n");
    const blob = new Blob([body], { type: `${ext === "txt" ? "text/plain" : "text/csv"};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(fileName || "numbers").replace(/\.[^.]+$/, "")}-validated.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    if (nums.length === 0) { toast("info", "Nothing to copy"); return; }
    try {
      await navigator.clipboard.writeText(nums.join("\n"));
      toast("ok", `${nums.length} numbers copied`);
    } catch { toast("err", "Could not copy", "Select the text and copy manually."); }
  }

  const counts = {
    mobile: (rows ?? []).filter((r) => r.verdict === "mobile").length,
    maybe: (rows ?? []).filter((r) => r.verdict === "maybe").length,
    landline: (rows ?? []).filter((r) => r.verdict === "landline").length,
    invalid: (rows ?? []).filter((r) => r.verdict === "invalid").length,
    duplicate: (rows ?? []).filter((r) => r.verdict === "duplicate").length,
  };

  return (
    <>
      <div className="panel">
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
              onChange={(e) => { setText(e.target.value); setRows(null); }}
              placeholder={"03001234567\n+44 7911 123456\nAlice,alice@example.com,+923009876543"} />
          </>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <button className={payload().trim() && !busy ? "primary" : undefined}
            onClick={run} disabled={!payload().trim() || busy}>
            {busy ? <><i className="spin" />checking…</> : "Check this list — free"}
          </button>
          <label className="sub" style={{ margin: 0, marginLeft: "auto" }}>
            Local numbers are{" "}
            <select value={region} onChange={(e) => { setRegion(e.target.value); setRows(null); }}
              style={{ width: "auto" }}>
              {countries.length === 0 ? <option value={region}>{region}</option>
                : countries.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
        </div>
      </div>

      {rows && (
        <div style={{ marginTop: 22 }}>
          <div className="grid" style={{ marginBottom: 18 }}>
            <div className="stat"><div className="k">Worth checking</div>
              <div className="v" style={{ color: "var(--accent)" }}>{usable.length.toLocaleString()}</div></div>
            <div className="stat"><div className="k">Mobile</div><div className="v">{counts.mobile.toLocaleString()}</div></div>
            <div className="stat"><div className="k">Cannot hold an account</div><div className="v">{counts.landline.toLocaleString()}</div></div>
            <div className="stat"><div className="k">Invalid</div><div className="v">{counts.invalid.toLocaleString()}</div></div>
            <div className="stat"><div className="k">Duplicates</div><div className="v">{counts.duplicate.toLocaleString()}</div></div>
          </div>

          {usable.length < (rows?.length ?? 0) && (
            <p className="note" style={{ marginBottom: 16 }}>
              Checking only the {usable.length.toLocaleString()} usable{" "}
              {usable.length === 1 ? "number" : "numbers"} instead of all{" "}
              {rows.length.toLocaleString()} would save{" "}
              <strong>{(rows.length - usable.length).toLocaleString()} credits</strong> per
              platform. Copy them below and paste them into the WhatsApp or Telegram check.
            </p>
          )}

          <div className="active-box">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <strong style={{ fontSize: 14 }}>
                {usable.length.toLocaleString()} number{usable.length === 1 ? "" : "s"} worth checking
              </strong>
              <div className="row" style={{ gap: 7 }}>
                <button className="primary" onClick={copy} disabled={nums.length === 0}>Copy all</button>
                <button onClick={() => download("txt")} disabled={nums.length === 0}>.txt</button>
                <button onClick={() => download("csv")} disabled={!rows.length}>.csv</button>
              </div>
            </div>
            <textarea className="numbers" rows={Math.min(8, Math.max(3, nums.length))} readOnly
              value={nums.join("\n")}
              placeholder="Nothing in this list can hold a WhatsApp or Telegram account."
              onFocus={(e) => e.currentTarget.select()} />
            <p className="sub" style={{ margin: "8px 0 0" }}>
              Worked out in your browser. These numbers were never sent anywhere and nothing was stored.
            </p>
          </div>

          <div className="chips" style={{ margin: "18px 0 10px" }}>
            <span className={"chip" + (keep === "usable" ? " sel" : "")} onClick={() => setKeep("usable")}>
              Worth checking ({usable.length.toLocaleString()})
            </span>
            <span className={"chip" + (keep === "all" ? " sel" : "")} onClick={() => setKeep("all")}>
              Everything ({rows.length.toLocaleString()})
            </span>
          </div>

          <div className="panel results-table" style={{ padding: 0, maxHeight: 420 }}>
            <table>
              <thead>
                <tr><th>#</th><th>Number</th><th>Country</th><th>Result</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {shown.slice(0, 300).map((r, i) => (
                  <tr key={i}>
                    <td className="num" style={{ color: "var(--muted)" }}>{i + 1}</td>
                    <td className="num">{r.e164 ?? r.raw.slice(0, 24)}</td>
                    <td style={{ color: "var(--muted)" }}>{r.country ?? "—"}</td>
                    <td><span className={"v " + LABEL[r.verdict].cls}>{LABEL[r.verdict].text}</span></td>
                    <td style={{ color: "var(--muted)", fontSize: 12 }}>{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length > 300 && (
            <p className="sub" style={{ marginTop: 10 }}>
              Showing the first 300 of {shown.length.toLocaleString()}. Download the CSV for all of them.
            </p>
          )}
        </div>
      )}
    </>
  );
}
