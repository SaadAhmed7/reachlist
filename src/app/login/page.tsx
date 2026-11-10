import { redirect } from "next/navigation";
import type { Metadata } from "next";
import LoginForm from "@/components/LoginForm";
import { currentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Sign in — Number Checker" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentUser()) redirect("/");
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-logo" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff"
               strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <span className="eyebrow">WhatsApp · Telegram</span>
        <h1 style={{ fontSize: 25, margin: "8px 0 4px" }}>Number Checker</h1>
        <p className="sub" style={{ marginBottom: 22 }}>Sign in to validate numbers.</p>
        <LoginForm />
      </div>
    </div>
  );
}
