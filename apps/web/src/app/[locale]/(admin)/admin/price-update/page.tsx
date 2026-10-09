"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import ConfirmDialog from "@/components/erp/ConfirmDialog";
import { DecimalField, IntField, SelectField, TextField } from "@/components/erp/FormFields";
import { RefSelect } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { ApiError, post } from "@/lib/api";
import { fmtMoney, todayCaracas } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;
interface Result { dryRun: boolean; total: number; changed: number; skipped: number; validFrom: string; rows: Row[] }

export default function PriceUpdatePage() {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const [f, setF] = useState({ priceListId: "", mode: "PERCENT", value: "", sourcePriceListId: "", categoryId: "", validFrom: todayCaracas(), decimals: "2" });
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const set = (p: Partial<typeof f>) => (setF((s) => ({ ...s, ...p })), setRes(null));
  const body = (dryRun: boolean) => ({
    priceListId: f.priceListId, mode: f.mode, value: f.value, sourcePriceListId: f.mode === "PERCENT" && f.sourcePriceListId ? f.sourcePriceListId : undefined,
    categoryId: f.categoryId || undefined, validFrom: f.validFrom, decimals: Number(f.decimals || 2), dryRun,
  });

  async function run(dryRun: boolean) {
    setBusy(true); setError(null);
    try {
      const r = await post<Result>("/products/prices/bulk", body(dryRun));
      setRes(r.data);
      if (!dryRun) { notice.success(t("priceUpdate.applied", { count: r.data.changed })); setConfirm(false); }
    } catch (e) { setConfirm(false); setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); }
  }

  const columns: Column<Row>[] = [
    { key: "sku", header: "SKU" },
    { key: "name", header: t("fields.name") },
    { key: "oldPrice", header: t("priceUpdate.old"), align: "end", render: (r) => (r.oldPrice === null ? "—" : fmtMoney(r.oldPrice, 2)) },
    { key: "newPrice", header: t("priceUpdate.new"), align: "end", render: (r) => (r.newPrice === null ? <span className="text-warning-600">{t(`priceUpdate.skipped.${r.skipped}`)}</span> : fmtMoney(r.newPrice, 2)) },
  ];

  if (!can("admin:products:update")) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;
  return (
    <div>
      <PageHeader title={t("sidebar.items.price-update")} subtitle={t("priceUpdate.subtitle")} />
      <ErrorBox error={error} />
      <Card className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <RefSelect label={t("fields.priceList")} required resource="/price-lists" labelKey={(r) => `${r.code} — ${r.name}`} value={f.priceListId} onChange={(v) => set({ priceListId: v })} />
          <SelectField label={t("priceUpdate.mode")} value={f.mode} onChange={(v) => set({ mode: v })} options={["PERCENT", "MARGIN", "SET"].map((m) => ({ value: m, label: t(`priceUpdate.modes.${m}`) }))} />
          <DecimalField label={t(`priceUpdate.value.${f.mode}`)} required value={f.value} onChange={(v) => set({ value: v })} align="end" hint={f.mode === "PERCENT" ? t("priceUpdate.percentHint") : undefined} />
          {f.mode === "PERCENT" && <RefSelect label={t("priceUpdate.source")} resource="/price-lists" labelKey={(r) => `${r.code} — ${r.name}`} value={f.sourcePriceListId} onChange={(v) => set({ sourcePriceListId: v })} hint={t("priceUpdate.sourceHint")} />}
          <RefSelect label={t("fields.categoryId")} resource="/categories" labelKey={(r) => `${r.code} — ${r.name}`} value={f.categoryId} onChange={(v) => set({ categoryId: v })} hint={t("priceUpdate.allProducts")} />
          <TextField label={t("priceUpdate.validFrom")} type="date" value={f.validFrom} onChange={(v) => set({ validFrom: v })} />
          <IntField label={t("priceUpdate.decimals")} value={f.decimals} onChange={(v) => set({ decimals: v })} />
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="outline" size="sm" disabled={busy || !f.priceListId || f.value === ""} onClick={() => run(true)}>{t("priceUpdate.preview")}</Button>
          <Button size="sm" disabled={busy || !res || res.changed === 0} onClick={() => setConfirm(true)}>{t("priceUpdate.apply")}</Button>
        </div>
      </Card>
      {res && (
        <Card title={res.dryRun ? t("priceUpdate.previewTitle") : t("priceUpdate.resultTitle")}>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">{t("priceUpdate.summary", { total: res.total, changed: res.changed, skipped: res.skipped })}</p>
          <DataTable columns={columns} rows={res.rows.slice(0, 500)} rowKey={(r) => r.productId} />
          {res.rows.length > 500 && <p className="mt-2 text-xs text-gray-500">{t("priceUpdate.firstRows", { count: 500 })}</p>}
        </Card>
      )}
      <ConfirmDialog open={confirm} busy={busy} title={t("priceUpdate.confirmTitle")} message={t("priceUpdate.confirmMessage", { count: res?.changed ?? 0 })} confirmLabel={t("priceUpdate.apply")} onCancel={() => setConfirm(false)} onConfirm={() => run(false)} />
    </div>
  );
}
