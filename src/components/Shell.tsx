"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import ProductIcon from "./ProductIcon";
import { productsByCategory } from "@/lib/products";

/**
 * The frame every signed-in page sits in: a fixed left rail of services and a
 * scrolling main column.
 *
 * The rail is the whole navigation model — a client who gets lost can always
 * see every check the product offers and click straight to it. It collapses to
 * a drawer under 980px rather than stacking, which would push the actual work
 * off the first screen on a laptop.
 */
export default function Shell({
  credits, isAdmin, children,
}: {
  credits: number;
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const groups = productsByCategory();

  return (
    <div className={"shell" + (open ? " nav-open" : "")}>
      <button className="nav-scrim" aria-label="Close menu" onClick={() => setOpen(false)} />

      <aside className="rail">
        <div className="rail-brand">
          <span className="rail-logo" aria-hidden>N</span>
          <div>
            <strong>Number Checker</strong>
            <span>WhatsApp · Telegram</span>
          </div>
        </div>

        <nav className="rail-nav">
          <Link href="/" className={"rail-link" + (path === "/" ? " on" : "")}
            onClick={() => setOpen(false)}>
            <span className="rail-ico" aria-hidden>▦</span> Product overview
          </Link>

          {groups.map((g) => (
            <div key={g.category} className="rail-group">
              <p className="rail-head">{g.category}</p>
              {g.items.map((p) => {
                const href = `/p/${p.slug}`;
                return (
                  <Link key={p.slug} href={href}
                    className={"rail-link" + (path === href ? " on" : "")}
                    onClick={() => setOpen(false)}>
                    <ProductIcon icon={p.icon} size={22} /> {p.name}
                  </Link>
                );
              })}
            </div>
          ))}

          <div className="rail-group">
            <p className="rail-head">Tools &amp; account</p>
            <Link href="/uploads" className={"rail-link" + (path === "/uploads" ? " on" : "")}
              onClick={() => setOpen(false)}>
              <span className="rail-ico" aria-hidden>☰</span> Your uploads
            </Link>
            {isAdmin && (
              <Link href="/admin" className={"rail-link" + (path === "/admin" ? " on" : "")}
                onClick={() => setOpen(false)}>
                <span className="rail-ico" aria-hidden>⚙</span> Administration
              </Link>
            )}
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="rail-link rail-out">
                <span className="rail-ico" aria-hidden>↩</span> Sign out
              </button>
            </form>
          </div>
        </nav>
      </aside>

      <div className="main">
        <header className="bar">
          <button className="burger" aria-label="Menu" onClick={() => setOpen((v) => !v)}>
            <span /><span /><span />
          </button>
          <span className="bar-spacer" />
          <span className="balance"><b>{credits.toLocaleString()}</b> credits</span>
        </header>
        <div className="main-inner">{children}</div>
      </div>
    </div>
  );
}
