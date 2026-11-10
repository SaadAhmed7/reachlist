import { redirect } from "next/navigation";
import type { Metadata } from "next";
import ProductCatalog from "@/components/ProductCatalog";
import Shell from "@/components/Shell";
import { currentUser } from "@/lib/auth";
import { availableChannels } from "@/lib/availability";

export const metadata: Metadata = { title: "Products — Number Checker" };
export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const available = await availableChannels();

  return (
    <Shell credits={user.credits} isAdmin={user.role === "ADMIN"}>
      <div style={{ marginBottom: 26 }}>
        <span className="eyebrow">Detection services</span>
        <h1>Product overview</h1>
        <p className="lede" style={{ marginTop: 8 }}>
          Pick the check you want to run. Each one takes the same list and does one job,
          so there is nothing to configure.
        </p>
      </div>

      {available.length === 0 && (
        <p className="banner warn" style={{ marginBottom: 22 }}>
          No WhatsApp or Telegram account is connected, so the paid checks cannot run yet.
          Number validation still works — it needs no account.
        </p>
      )}

      <ProductCatalog available={available} />
    </Shell>
  );
}
