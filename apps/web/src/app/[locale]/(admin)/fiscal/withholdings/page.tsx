"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { SelectField } from "@/components/erp/FormFields";
import { Card, ErrorBox, PageHeader, StatusBadge } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useRouter } from "@/i18n/navigation";
import { PlusIcon } from "@/icons";
import { fmtDate, fmtMoney } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

export default function WithholdingsList() {
  const t = useTranslations();
  const { can } = useAuth();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [f, setF] = useState({ direction: "", kind: "", status: "", search: "" });
  const list = useFetch<Row[]>(can("fiscal:withholdings:read") ? "/fiscal/withholdings" : null, { page, limit: 20, direction: f.direction || undefined, kind: f.kind || undefined, status: f.status || undefined, search: f.search || undefined });
  const set = (p: Partial<typeof f>) => (setF((s) => ({ ...s, ...p })), setPage(1));

  const columns: Column<Row>[] = [
    { key: "number", header: t("fields.number") },
    { key: "voucherDate", header: t("fields.date"), render: (r) => fmtDate(r.voucherDate) },
    { key: "direction", header: t("fiscal.direction"), render: (r) => t(`fiscal.directions.${r.direction}`) },
    { key: "kind", header: t("fiscal.kind") },
    { key: "partyName", header: t("fiscal.party") },
    { key: "baseBs", header: t("fiscal.base"), align: "end", render: (r) => fmtMoney(r.baseBs) },
    { key: "percentage", header: "%", align: "end", render: (r) => fmtMoney(r.percentage) },
    { key: "amountBs", header: t("fiscal.withheld"), align: "end", render: (r) => fmtMoney(r.amountBs) },
    { key: "status", header: t("fields.status"), render: (r) => <StatusBadge status={r.status} /> },
  ];
  if (!can("fiscal:withholdings:read")) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;
  return (
    <div>
      <PageHeader title={t("sidebar.items.withholdings")} subtitle={t("fiscal.subtitle")} actions={can("fiscal:withholdings:create") && <Button size="sm" startIcon={<PlusIcon />} onClick={() => router.push("/fiscal/withholdings/new")}>{t("common.new")}</Button>} />
      <Card>
        <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
          <input type="search" value={f.search} onChange={(e) => set({ search: e.target.value })} placeholder={t("fiscal.searchHint")} aria-label={t("common.search")}
            className="h-11 rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" />
          <SelectField label="" value={f.direction} onChange={(v) => set({ direction: v })} options={["ISSUED", "RECEIVED"].map((d) => ({ value: d, label: t(`fiscal.directions.${d}`) }))} placeholder={t("fiscal.allDirections")} />
          <SelectField label="" value={f.kind} onChange={(v) => set({ kind: v })} options={["IVA", "ISLR"].map((k) => ({ value: k, label: k }))} placeholder={t("fiscal.allKinds")} />
          <SelectField label="" value={f.status} onChange={(v) => set({ status: v })} options={["CONFIRMED", "CANCELLED"].map((s) => ({ value: s, label: t(`status.${s}`) }))} placeholder={t("common.allStatuses")} />
        </div>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} onRowClick={(r) => router.push(`/fiscal/withholdings/${r.id}`)} />
      </Card>
    </div>
  );
}
