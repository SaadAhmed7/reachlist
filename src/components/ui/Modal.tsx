"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * A glass dialog rendered into a portal.
 *
 * Replaces window.prompt/confirm: those block the main thread, cannot be
 * styled, and on a credit system give the user no idea what they are about to
 * change. Escape and a backdrop click both close; focus lands on the first
 * field so the keyboard path works.
 */
export default function Modal({
  open, title, description, onClose, children, footer, wide,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // Stop the page scrolling behind the dialog.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the first control so the dialog is usable without a mouse.
    const t = setTimeout(() => {
      box.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus();
    }, 40);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" ref={box} role="dialog" aria-modal="true" aria-label={title}
           style={wide ? { maxWidth: 620 } : undefined}>
        <h2>{title}</h2>
        {description && <p className="modal-sub">{description}</p>}
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
