import { redirect } from "next/navigation";
import type { Metadata } from "next";
import AdminPanel from "@/components/AdminPanel";
import Shell from "@/components/Shell";
import { currentUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Admin — Number Checker" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/");

  return (
    <Shell credits={user.credits} isAdmin>
      <div style={{ marginBottom: 24 }}>
        <span className="eyebrow">Administration</span>
        <h1>Accounts &amp; credits</h1>
      </div>
      <AdminPanel meId={user.id} />
    </Shell>
  );
}
