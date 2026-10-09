"use client";

import { cn } from "@/utils";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

type Kind = "success" | "error" | "info";
interface Notice {
  id: number;
  kind: Kind;
  text: string;
}

interface NoticeContextType {
  success: (text: string) => void;
  error: (text: string) => void;
  info: (text: string) => void;
}

const NoticeContext = createContext<NoticeContextType | undefined>(undefined);

export const useNotice = () => {
  const ctx = useContext(NoticeContext);
  if (!ctx) throw new Error("useNotice debe usarse dentro de NoticeProvider");
  return ctx;
};

let seq = 0;

/** Avisos efímeros (esquina superior derecha). */
export function NoticeProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Notice[]>([]);

  const push = useCallback((kind: Kind, text: string) => {
    const id = ++seq;
    setItems((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setItems((prev) => prev.filter((n) => n.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);

  const value = useMemo<NoticeContextType>(
    () => ({ success: (t) => push("success", t), error: (t) => push("error", t), info: (t) => push("info", t) }),
    [push],
  );

  return (
    <NoticeContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-e-4 top-20 z-999999 flex w-full max-w-sm flex-col gap-2">
        {items.map((n) => (
          <div
            key={n.id}
            role={n.kind === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto rounded-xl border p-4 text-sm shadow-theme-lg",
              n.kind === "success" && "border-success-500 bg-success-50 text-success-700 dark:bg-success-500/15 dark:text-success-500",
              n.kind === "error" && "border-error-500 bg-error-50 text-error-700 dark:bg-error-500/15 dark:text-error-500",
              n.kind === "info" && "border-blue-light-500 bg-blue-light-50 text-blue-light-500 dark:bg-blue-light-500/15",
            )}
          >
            {n.text}
          </div>
        ))}
      </div>
    </NoticeContext.Provider>
  );
}
