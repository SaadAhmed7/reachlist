"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import ProductIcon from "./ProductIcon";
import {
  CATEGORIES, PRODUCTS, matchesQuery, productPrice,
  type Category, type Channel, type Product,
} from "@/lib/products";

type Filter = "all" | Category | "free";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All products" },
  ...CATEGORIES.map((c) => ({ key: c as Filter, label: c })),
  { key: "free", label: "Free" },
];

/**
 * The catalogue grid.
 *
 * Every card leads somewhere that works. A product whose channel has no
 * connected account is still shown, but marked and priced honestly, because
 * hiding it would leave the client wondering where WhatsApp went.
 */
export default function ProductCatalog({ available }: { available: Channel[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const shown = useMemo(() => PRODUCTS.filter((p) => {
    if (!matchesQuery(p, query)) return false;
    if (filter === "all") return true;
    if (filter === "free") return p.channels.length === 0;
    return p.category === filter;
  }), [query, filter]);

  return (
    <>
      <section className="panel finder anim">
        <h2 className="finder-title">Find a product</h2>
        <input
          className="finder-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Try: WhatsApp, Telegram, last seen, clean my list"
          spellCheck={false}
        />
        <div className="chips" style={{ marginTop: 14 }}>
          {FILTERS.map((f) => (
            <span key={f.key} className={"chip" + (filter === f.key ? " sel" : "")}
              onClick={() => setFilter(f.key)}>
              {f.label}
            </span>
          ))}
        </div>
      </section>

      <div className="row" style={{ margin: "30px 0 14px", alignItems: "baseline" }}>
        <h2>Available products</h2>
        <span className="tail">{shown.length} of {PRODUCTS.length}</span>
      </div>

      {shown.length === 0 ? (
        <p className="note">
          Nothing matches “{query}”. These five are everything the service can do today —
          clear the search to see them all.
        </p>
      ) : (
        <div className="cards">
          {shown.map((p, i) => (
            <Card key={p.slug} p={p} available={available} delay={i} />
          ))}
        </div>
      )}
    </>
  );
}

function Card({ p, available, delay }: { p: Product; available: Channel[]; delay: number }) {
  const price = productPrice(p);
  const offline = p.channels.length === 0;
  // Offline products need nothing connected; the rest need every channel they use.
  const ready = offline || p.channels.every((c) => available.includes(c));

  return (
    <Link href={`/p/${p.slug}`} className="card anim"
      style={{ animationDelay: `${Math.min(delay, 6) * 45}ms` }}>
      <div className="card-top">
        <ProductIcon icon={p.icon} />
        <h3>{p.name}</h3>
      </div>

      <div className="chips card-tags">
        {p.tags.map((t) => (
          <span key={t} className={"tag" + (t === "Popular" ? " hot" : t === "Free" ? " free" : "")}>
            {t}
          </span>
        ))}
        <span className="tag">{p.category}</span>
      </div>

      <p className="card-blurb">{p.blurb}</p>

      <div className="card-foot">
        <div>
          <strong className="card-price">{offline ? "Free" : `${price} credit${price === 1 ? "" : "s"}`}</strong>
          <span className="card-unit">{offline ? "no credits used" : "per number"}</span>
          <span className={"card-state " + (ready ? "ok" : "off")}>
            {ready ? "Available" : "Needs an account linked"}
          </span>
        </div>
        <span className="card-cta">Use now →</span>
      </div>
    </Link>
  );
}
