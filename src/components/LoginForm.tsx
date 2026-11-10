"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./ui/Toast";

export default function LoginForm() {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? "Could not sign in."); return; }
      toast("ok", "Welcome back");
      router.replace("/");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <label className="field">
        <span>Email</span>
        <input type="email" value={email} autoComplete="username" required
          onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" value={password} autoComplete="current-password" required
          onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button className="primary" type="submit" disabled={busy || !email || !password}>
        {busy ? <><i className="spin" />signing in…</> : "Sign in"}
      </button>
      {error && <p className="banner bad">{error}</p>}
    </form>
  );
}
