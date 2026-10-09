"use client";

import Badge from "@/components/ui/badge/Badge";
import { ApiError } from "@/lib/api";
import { cn } from "@/utils";
import { useTranslations } from "next-intl";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-white/90">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, className, actions }: { title?: string; children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  return (
    <div className={cn("rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/3", className)}>
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <h3 className="text-base font-medium text-gray-800 dark:text-white/90">{title}</h3>
          {actions}
        </div>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  );
}

export function ErrorBox({ error }: { error: ApiError | Error | string | null }) {
  if (!error) return null;
  const msg = typeof error === "string" ? error : error.message;
  const details = error instanceof ApiError ? error.details.filter((d) => d.message || d.code) : [];
  return (
    <div role="alert" className="mb-4 rounded-lg border border-error-500 bg-error-50 p-3 text-sm text-error-700 dark:bg-error-500/15 dark:text-error-500">
      <p className="font-medium">{msg}</p>
      {details.length > 0 && (
        <ul className="mt-1 list-disc ps-5 text-theme-xs">
          {details.map((d, i) => (
            <li key={i}>{[d.field, d.message ?? d.code].filter(Boolean).join(": ")}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Loading() {
  const t = useTranslations("common");
  return (
    <p role="status" className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
      {t("loading")}
    </p>
  );
}

export function Empty({ text }: { text?: string }) {
  const t = useTranslations("common");
  return <p className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">{text ?? t("noResults")}</p>;
}

const STATUS_COLOR: Record<string, "primary" | "success" | "error" | "warning" | "info" | "light" | "dark"> = {
  DRAFT: "light", SENT: "info", ACCEPTED: "primary", REJECTED: "error", EXPIRED: "warning",
  CONFIRMED: "primary", PARTIALLY_FULFILLED: "warning", FULFILLED: "success", INVOICED: "success", CLOSED: "dark",
  CANCELLED: "error", VOIDED: "error", OPEN: "info", PARTIALLY_PAID: "warning", PAID: "success",
};

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("status");
  return (
    <Badge size="sm" color={STATUS_COLOR[status] ?? "light"}>
      {t.has(status) ? t(status) : status}
    </Badge>
  );
}

export function BoolBadge({ value }: { value: boolean | null | undefined }) {
  const t = useTranslations("common");
  return (
    <Badge size="sm" color={value ? "success" : "light"}>
      {value ? t("yes") : t("no")}
    </Badge>
  );
}

export function Pager({ page, totalPages, total, onPage }: { page: number; totalPages: number; total?: number; onPage: (p: number) => void }) {
  const t = useTranslations("common");
  if (totalPages <= 1 && !total) return null;
  const btn = "rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-theme-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400";
  return (
    <div className="flex items-center justify-between gap-3 pt-4 text-sm text-gray-500 dark:text-gray-400">
      <span>{total !== undefined ? t("totalRecords", { count: total }) : ""}</span>
      <div className="flex items-center gap-2">
        <button className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t("previous")}
        </button>
        <span>{t("pageOf", { page, total: Math.max(totalPages, 1) })}</span>
        <button className={btn} disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          {t("next")}
        </button>
      </div>
    </div>
  );
}
