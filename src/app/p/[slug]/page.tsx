import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import ProductIcon from "@/components/ProductIcon";
import ProductWorkspace from "@/components/ProductWorkspace";
import Shell from "@/components/Shell";
import { currentUser } from "@/lib/auth";
import { availableChannels } from "@/lib/availability";
import { PRODUCTS, productBySlug, productPrice } from "@/lib/products";

export const dynamic = "force-dynamic";

/** One page per product, so each has a real URL the client can bookmark. */
export function generateStaticParams() {
  return PRODUCTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const p = productBySlug((await params).slug);
  return { title: p ? `${p.name} — Number Checker` : "Number Checker" };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const product = productBySlug((await params).slug);
  if (!product) notFound();

  const available = await availableChannels();
  const price = productPrice(product);
  const offline = product.channels.length === 0;
  const missing = product.channels.filter((c) => !available.includes(c));

  return (
    <Shell credits={user.credits} isAdmin={user.role === "ADMIN"}>
      <Link href="/" className="crumb">← All products</Link>

      <header className="prod-head">
        <ProductIcon icon={product.icon} size={54} />
        <div>
          <h1>{product.name}</h1>
          <p className="lede" style={{ marginTop: 6 }}>{product.about}</p>
        </div>
        <div className="prod-price">
          <strong>{offline ? "Free" : price}</strong>
          <span>{offline ? "no credits used" : `credit${price === 1 ? "" : "s"} per number`}</span>
        </div>
      </header>

      <ul className="prod-notes">
        {product.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>

      {missing.length > 0 && (
        <p className="banner warn" style={{ margin: "0 0 20px" }}>
          No {missing.map((c) => (c === "WHATSAPP" ? "WhatsApp" : "Telegram")).join(" or ")}{" "}
          account is connected, so this check cannot run yet. An administrator needs to link
          one first — until then, nothing you start here will return answers.
        </p>
      )}

      <ProductWorkspace
        slug={product.slug}
        name={product.name}
        channels={product.channels}
        lastSeen={product.lastSeen ?? false}
        credits={user.credits}
        available={available}
        defaultRegion={process.env.DEFAULT_REGION ?? "US"}
      />
    </Shell>
  );
}
