"use client";

import { useCallback, useEffect, useState } from "react";
import Modal from "./ui/Modal";
import { useToast } from "./ui/Toast";

type Provider = {
  id: string; channel: "WHATSAPP" | "TELEGRAM"; label: string;
  identifier: string | null; status: string; enabled: boolean;
  lastError: string | null; lookupCount: number; lastUsedAt: string | null;
  live: string; qr: string | null; liveError: string | null;
};

type U = {
  id: string; email: string; name: string | null;
  role: "ADMIN" | "USER"; credits: number; active: boolean;
  createdAt: string; _count: { checks: number };
};

const CH: Record<string, { label: string; key: string }> = {
  WHATSAPP: { label: "WhatsApp", key: "whatsapp" },
  TELEGRAM: { label: "Telegram", key: "telegram" },
};

type Dialog =
  | { kind: "credits"; user: U }
  | { kind: "password"; user: U }
  | { kind: "deleteUser"; user: U }
  | { kind: "delete"; provider: Provider }
  | null;

export default function AdminPanel({ meId }: { meId: string }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form, setForm] = useState({ amount: "100", note: "Payment received", password: "", confirm: "" });
  const [tab, setTab] = useState<"users" | "providers">("users");
  const [users, setUsers] = useState<U[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const r = await fetch("/api/admin/users", { cache: "no-store" });
    if (r.ok) setUsers((await r.json()).users ?? []);
  }, []);

  const loadProviders = useCallback(async () => {
    const r = await fetch("/api/admin/providers", { cache: "no-store" });
    if (r.ok) setProviders((await r.json()).providers ?? []);
  }, []);

  useEffect(() => { void loadUsers(); void loadProviders(); }, [loadUsers, loadProviders]);

  // Poll only while something is mid-link, so a QR appears without hammering.
  const linking = providers.some((p) => p.live === "qr" || p.live === "starting");
  useEffect(() => {
    if (tab !== "providers") return;
    const t = setInterval(loadProviders, linking ? 2_000 : 10_000);
    return () => clearInterval(t);
  }, [tab, linking, loadProviders]);

  async function call(url: string, body: unknown, method = "PATCH") {
    setError(null);
    const r = await fetch(url, {
      method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error ?? "Request failed.");
      toast("err", "That did not work", d.error ?? "Request failed.");
      return null;
    }
    return d;
  }

  // ----------------------------------------------------------- new user

  const [nu, setNu] = useState({ email: "", password: "", name: "", credits: "0", role: "USER" });

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setBusy("new-user");
    const ok = await call("/api/admin/users", {
      email: nu.email, password: nu.password, name: nu.name || undefined,
      role: nu.role, credits: Number(nu.credits) || 0,
    }, "POST");
    setBusy(null);
    if (ok) {
      toast("ok", "User created", nu.email);
      setNu({ email: "", password: "", name: "", credits: "0", role: "USER" });
      void loadUsers();
    }
  }

  function openCredits(u: U) {
    setForm((f) => ({ ...f, amount: "100", note: "Payment received" }));
    setDialog({ kind: "credits", user: u });
  }

  async function submitCredits() {
    if (dialog?.kind !== "credits") return;
    const credits = Number(form.amount);
    if (!Number.isInteger(credits) || credits === 0) {
      toast("err", "Enter a whole, non-zero number");
      return;
    }
    setBusy(dialog.user.id);
    const ok = await call(`/api/admin/users/${dialog.user.id}`, { credits, note: form.note });
    setBusy(null);
    if (ok) {
      toast("ok", credits > 0 ? `${credits} credits added` : `${-credits} credits removed`,
            `${dialog.user.email} — balance ${ok.user.credits}`);
      setDialog(null);
      void loadUsers();
    }
  }

  function openPassword(u: U) {
    setForm((f) => ({ ...f, password: "" }));
    setDialog({ kind: "password", user: u });
  }

  async function submitPassword() {
    if (dialog?.kind !== "password") return;
    if (form.password.length < 8) { toast("err", "Password needs 8 characters or more"); return; }
    setBusy(dialog.user.id);
    const ok = await call(`/api/admin/users/${dialog.user.id}`, { password: form.password });
    setBusy(null);
    if (ok) {
      toast("ok", "Password changed", `${dialog.user.email} has been signed out everywhere.`);
      setDialog(null);
    }
  }

  async function deleteUser() {
    if (dialog?.kind !== "deleteUser") return;
    const u = dialog.user;
    if (form.confirm.trim().toLowerCase() !== u.email.toLowerCase()) {
      toast("err", "Type the email exactly to confirm");
      return;
    }
    setBusy(u.id);
    const ok = await call(`/api/admin/users/${u.id}`, undefined, "DELETE");
    setBusy(null);
    if (ok) {
      toast("ok", "Account deleted", `${u.email} and all of its history are gone.`);
      setDialog(null);
      void loadUsers();
    }
  }

  async function toggleActive(u: U) {
    setBusy(u.id);
    const ok = await call(`/api/admin/users/${u.id}`, { active: !u.active });
    setBusy(null);
    if (ok) {
      toast("ok", u.active ? "User disabled" : "User enabled", u.email);
      void loadUsers();
    }
  }

  // ------------------------------------------------------- new provider

  /** One click: create it, and the server starts linking so a QR appears. */
  async function addProvider(channel: "WHATSAPP" | "TELEGRAM") {
    setBusy(`add-${channel}`);
    const ok = await call("/api/admin/providers", { channel }, "POST");
    setBusy(null);
    if (ok) {
      toast("ok", "Scan the code below", `Open ${channel === "WHATSAPP" ? "WhatsApp" : "Telegram"} on the phone you want to add.`);
      void loadProviders();
    }
  }

  async function providerAction(p: Provider, action: string, logout?: boolean) {
    setBusy(p.id);
    const ok = await call(`/api/admin/providers/${p.id}`, { action, logout });
    setBusy(null);
    if (ok) {
      if (action === "link") toast("info", "Starting…", "A QR code will appear shortly.");
      if (action === "unlink") toast("ok", "Unlinked", p.label);
      void loadProviders();
    }
  }

  async function removeProvider() {
    if (dialog?.kind !== "delete") return;
    const p = dialog.provider;
    setBusy(p.id);
    const ok = await call(`/api/admin/providers/${p.id}`, undefined, "DELETE");
    setBusy(null);
    if (ok) { toast("ok", "Account deleted", p.label); setDialog(null); void loadProviders(); }
  }

  const dlg = dialog;

  return (
    <>
      {/* ------------------------------------------------------- dialogs */}

      <Modal
        open={dlg?.kind === "credits"}
        title="Add credits"
        description={dlg?.kind === "credits"
          ? `${dlg.user.email} currently has ${dlg.user.credits} credits. Use a negative number to correct a mistake.`
          : undefined}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="primary" onClick={submitCredits} disabled={busy !== null}>
              {busy ? <><i className="spin" />working…</> : "Apply"}
            </button>
          </>
        }
      >
        <div className="stack">
          <label className="field">
            <span>Amount</span>
            <input type="number" value={form.amount} autoFocus
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void submitCredits(); }} />
          </label>
          <label className="field">
            <span>Note — stored on the transaction</span>
            <input value={form.note} placeholder="Bank transfer #4471"
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void submitCredits(); }} />
          </label>
          {dlg?.kind === "credits" && Number(form.amount) !== 0 && Number.isInteger(Number(form.amount)) && (
            <p className="note">
              New balance will be{" "}
              <strong>{dlg.user.credits + Number(form.amount)}</strong> credits.
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={dlg?.kind === "password"}
        title="Set a new password"
        description={dlg?.kind === "password"
          ? `${dlg.user.email} will be signed out of every device immediately.`
          : undefined}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="primary" onClick={submitPassword} disabled={busy !== null}>
              {busy ? <><i className="spin" />working…</> : "Change password"}
            </button>
          </>
        }
      >
        <label className="field">
          <span>New password — 8 characters or more</span>
          <input type="text" value={form.password} autoFocus
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") void submitPassword(); }} />
        </label>
      </Modal>

      <Modal
        open={dlg?.kind === "deleteUser"}
        title="Delete this account permanently?"
        description={dlg?.kind === "deleteUser"
          ? `${dlg.user.email} has ${dlg.user.credits} credits and ${dlg.user._count.checks} checks on record. All of it — the login, the ledger and the history — is deleted. This cannot be undone. If you only want to stop them signing in, use Disable instead.`
          : undefined}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button onClick={() => setDialog(null)}>Cancel</button>
            <button className="danger" onClick={deleteUser} disabled={busy !== null}>
              {busy ? <><i className="spin" />deleting…</> : "Delete permanently"}
            </button>
          </>
        }
      >
        <label className="field">
          <span>Type <strong>{dlg?.kind === "deleteUser" ? dlg.user.email : ""}</strong> to confirm</span>
          <input value={form.confirm} autoFocus autoComplete="off"
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") void deleteUser(); }} />
        </label>
      </Modal>

      <Modal
        open={dlg?.kind === "delete"}
        title="Delete this account?"
        description={dlg?.kind === "delete"
          ? `"${dlg.provider.label}" will be logged out of the phone and removed. This cannot be undone, and any lookups it was serving will fail over to another account.`
          : undefined}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button onClick={() => setDialog(null)}>Keep it</button>
            <button className="danger" onClick={removeProvider} disabled={busy !== null}>
              {busy ? <><i className="spin" />deleting…</> : "Delete"}
            </button>
          </>
        }
      />

      <div className="chips" style={{ marginBottom: 18 }}>
        <span className={"chip" + (tab === "users" ? " sel" : "")} onClick={() => setTab("users")}>
          Users ({users.length})
        </span>
        <span className={"chip" + (tab === "providers" ? " sel" : "")} onClick={() => setTab("providers")}>
          {/*
            Reads as a count, never as a quota. The old form was "(4/5)", which
            a non-technical operator reported back as "it will not let me
            connect more than 5" — there has never been a limit on the number
            of accounts, and a label must not invent one.
          */}
          Connected accounts ({providers.filter((p) => p.status === "READY").length} working)
        </span>
      </div>

      {error && <p className="banner bad" style={{ marginBottom: 16 }}>{error}</p>}

      {tab === "users" ? (
        <>
          <div className="panel" style={{ marginBottom: 18 }}>
            <h2 style={{ margin: "0 0 14px", fontSize: 14 }}>Create a user</h2>
            <form onSubmit={createUser} className="field-row">
              <label className="field grow">
                <span>Email</span>
                <input type="email" required value={nu.email}
                  onChange={(e) => setNu({ ...nu, email: e.target.value })} />
              </label>
              <label className="field">
                <span>Password</span>
                <input type="text" required minLength={8} value={nu.password}
                  onChange={(e) => setNu({ ...nu, password: e.target.value })} />
              </label>
              <label className="field" style={{ maxWidth: 110 }}>
                <span>Credits</span>
                <input type="number" min={0} value={nu.credits}
                  onChange={(e) => setNu({ ...nu, credits: e.target.value })} />
              </label>
              <label className="field" style={{ maxWidth: 110 }}>
                <span>Role</span>
                <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                  <option value="USER">User</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </label>
              <button className="primary" type="submit" disabled={busy === "new-user"}>
                {busy === "new-user" ? "creating…" : "Create"}
              </button>
            </form>
          </div>

          <div className="panel results-table" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr><th>User</th><th>Role</th><th>Credits</th><th>Checks</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.email}</strong>
                      {u.name && <span style={{ color: "var(--muted)" }}> · {u.name}</span>}
                    </td>
                    <td>{u.role === "ADMIN" ? <span className="v unk">admin</span> : "user"}</td>
                    <td className="num"><b>{u.credits}</b></td>
                    <td className="num" style={{ color: "var(--muted)" }}>{u._count.checks}</td>
                    <td>
                      <span className={"v " + (u.active ? "yes" : "no")}>
                        {u.active ? "active" : "disabled"}
                      </span>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                        <button onClick={() => openCredits(u)} disabled={busy === u.id}>+ Credits</button>
                        <button onClick={() => openPassword(u)} disabled={busy === u.id}>Password</button>
                        <button onClick={() => toggleActive(u)} disabled={busy === u.id || u.id === meId}>
                          {u.active ? "Disable" : "Enable"}
                        </button>
                        <button className="danger" disabled={busy === u.id || u.id === meId}
                          onClick={() => { setForm((f) => ({ ...f, confirm: "" })); setDialog({ kind: "deleteUser", user: u }); }}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <p className="banner warn" style={{ marginBottom: 18 }}>
            Every user&apos;s lookups run through these accounts, so a ban stops
            the whole service. Link more than one per channel, and disable any
            account that starts erroring rather than pushing through it.
          </p>

          <div className="panel" style={{ marginBottom: 18 }}>
            <h2 style={{ margin: "0 0 6px", fontSize: 14 }}>Add an account</h2>
            <p className="sub" style={{ margin: "0 0 14px" }}>
              Each account you link makes checking faster — the work is shared
              between them. Click a button, then scan the code with that phone.
              {" "}There is no limit on how many you add.
            </p>
            <div className="row">
              <button className="primary" disabled={busy === "add-WHATSAPP"}
                onClick={() => addProvider("WHATSAPP")}>
                {busy === "add-WHATSAPP" ? <><i className="spin" />adding…</> : "+ Add WhatsApp"}
              </button>
              <button className="primary" disabled={busy === "add-TELEGRAM"}
                onClick={() => addProvider("TELEGRAM")}>
                {busy === "add-TELEGRAM" ? <><i className="spin" />adding…</> : "+ Add Telegram"}
              </button>
              <span className="tail" style={{ marginLeft: 0 }}>
                {providers.filter((p) => p.status === "READY").length} connected
              </span>
            </div>
          </div>

          <div className="conns">
            {providers.map((p) => (
              <div key={p.id} className={"conn" + (p.status === "READY" && p.enabled ? " on" : "")}
                   data-channel={CH[p.channel]?.key}>
                <div className="conn-head">
                  <span className="conn-mark">{CH[p.channel]?.label[0]}</span>
                  <span className="conn-name">{p.label}</span>
                  <span className={"dot " + (p.status === "READY" && p.enabled ? "on"
                    : p.live === "qr" || p.live === "starting" ? "wait"
                    : p.status === "FAILED" ? "err" : "")} />
                  <span className="conn-state">
                    {!p.enabled ? "disabled"
                      : p.status === "READY" ? (p.identifier ?? "connected")
                      : p.live === "qr" ? "scan to link"
                      : p.live === "starting" ? "starting…"
                      : p.status.toLowerCase()}
                  </span>
                </div>

                {p.qr && (
                  <div className="qr-wrap">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.qr} alt="QR code" width={150} height={150} />
                    <ol className="qr-steps">
                      <li>Open {CH[p.channel]?.label} on the phone</li>
                      <li>{p.channel === "WHATSAPP" ? "Settings → Linked devices" : "Settings → Devices"}</li>
                      <li>Link a device, then scan</li>
                    </ol>
                  </div>
                )}

                <p className="conn-meta">
                  {p.liveError ?? p.lastError ?? `${p.lookupCount} lookups served`}
                </p>

                <div className="conn-foot">
                  {p.status === "READY" && p.enabled ? (
                    <button onClick={() => providerAction(p, "unlink", true)} disabled={busy === p.id}>
                      Unlink
                    </button>
                  ) : p.live === "qr" ? (
                    <button onClick={() => providerAction(p, "unlink", false)} disabled={busy === p.id}>
                      Cancel
                    </button>
                  ) : (
                    <button className="primary" onClick={() => providerAction(p, "link")} disabled={busy === p.id}>
                      {busy === p.id ? "starting…" : "Link"}
                    </button>
                  )}
                  <button onClick={() => providerAction(p, p.enabled ? "disable" : "enable")} disabled={busy === p.id}>
                    {p.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="danger" style={{ marginLeft: "auto" }}
                          onClick={() => setDialog({ kind: "delete", provider: p })} disabled={busy === p.id}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {providers.length === 0 && (
              <p className="note">No accounts yet. Add one above, then link it by QR.</p>
            )}
          </div>
        </>
      )}
    </>
  );
}
