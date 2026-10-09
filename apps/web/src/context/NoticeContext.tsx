"use client";

import { cn } from "@/utils";
import { create } from "zustand";

type Kind = "success" | "error" | "info";
interface Notice { id: number; kind: Kind; text: string }

interface NoticeStore {
  items: Notice[];
  push: (kind: Kind, text: string) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

/** Avisos efímeros: estado de UI en un store de Zustand (erp-v3 §2: Zustand solo para sesión/UI). */
const useNoticeStore = create<NoticeStore>((set) => ({
  items: [],
  push: (kind, text) => {
    const id = ++seq;
    set((s) => ({ items: [...s.items, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((n) => n.id !== id) })), kind === "error" ? 8000 : 4000);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((n) => n.id !== id) })),
}));

/** Misma API que antes: `const notice = useNotice(); notice.success("…")`. */
export const useNotice = () => {
  const push = useNoticeStore((s) => s.push);
  return { success: (t: string) => push("success", t), error: (t: string) => push("error", t), info: (t: string) => push("info", t) };
};

export function NoticeViewport() {
  const items = useNoticeStore((s) => s.items);
  return (
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
  );
}

/** Mantiene el envoltorio `<NoticeProvider>` para no tocar el layout: solo monta el visor. */
export function NoticeProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <NoticeViewport />
    </>
  );
}
