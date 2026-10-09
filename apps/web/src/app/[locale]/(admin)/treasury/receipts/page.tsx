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

export default function ReceiptsList() {
  const t = useTranslations();
  const { can } = useAuth();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const list = useFetch<Row[]>(can("treasury:receipts:read") ? "/treasury/receipts" : null, { page, limit: 20, status: status || undefined, search: search || undefined });
  const currencies = useFetch<Row[]>("/currencies", { limit: 20 });
  const cur = (id: string) => currencies.data?.find((c) => c.id === id)?.code ?? "";

  const columns: Column<Row>[] = [
    { key: "number", header: t("fields.number") },
    { key: "receiptDate", header: t("fields.date"), render: (r) => fmtDate(r.receiptDate) },
    { key: "customerName", header: t("fields.customer") },
    { key: "reference", header: t("treasury.reference"), render: (r) => r.reference ?? "—" },
    { key: "amount", header: t("fields.amount"), align: "end", render: (r) => `${fmtMoney(r.amount)} ${cur(r.currencyId)}` },
    { key: "status", header: t("fields.status"), render: (r) => <StatusBadge status={r.status} /> },
  ];
  if (!can("treasury:receipts:read")) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;
  return (
    <div>
      <PageHeader title={t("sidebar.items.receipts")} actions={can("treasury:receipts:create") && <Button size="sm" startIcon={<PlusIcon />} onClick={() => router.push("/treasury/receipts/new")}>{t("common.new")}</Button>} />
      <Card>
        <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <input type="search" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} placeholder={t("treasury.searchHint")} aria-label={t("common.search")}
            className="h-11 rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" />
          <SelectField label="" value={status} onChange={(v) => (setStatus(v), setPage(1))} options={["CONFIRMED", "CANCELLED"].map((s) => ({ value: s, label: t(`status.${s}`) }))} placeholder={t("common.allStatuses")} />
        </div>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} onRowClick={(r) => router.push(`/treasury/receipts/${r.id}`)} />
      </Card>
    </div>
  );
}
