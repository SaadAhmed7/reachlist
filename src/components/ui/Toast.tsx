"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

type Kind = "ok" | "err" | "info";
type Item = { id: number; kind: Kind; title: string; body?: string };

const Ctx = createContext<(kind: Kind, title: string, body?: string) => void>(() => {});

/** `const toast = useToast(); toast("ok", "Saved", "250 credits added")` */
export function useToast() {
  return useContext(Ctx);
}

export function ToastHost({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((kind: Kind, title: string, body?: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, kind, title, body }]);
    // Errors stay longer — they usually need reading, not just noticing.
    setTimeout(() => dismiss(id), kind === "err" ? 7000 : 4000);
  }, [dismiss]);

  const value = useMemo(() => push, [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {items.length > 0 && (
        <div className="toasts">
          {items.map((t) => (
            <div key={t.id} className={"toast " + t.kind}>
              <i className="tdot" />
              <div>
                <b>{t.title}</b>
                {t.body && <span>{t.body}</span>}
              </div>
              <button onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}
