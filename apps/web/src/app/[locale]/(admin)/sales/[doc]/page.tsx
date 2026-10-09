"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { SelectField } from "@/components/erp/FormFields";
import { SALES_DOCS } from "@/components/erp/sales-docs";
import { Card, ErrorBox, PageHeader, StatusBadge } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useRouter } from "@/i18n/navigation";
import { PlusIcon } from "@/icons";
import { fmtDate, fmtMoney } from "@/lib/format";
import { notFound, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

export default function SalesDocList() {
  const { doc } = useParams<{ doc: string }>();
  if (!SALES_DOCS[doc]) notFound();
  return <List key={doc} slug={doc} />;
}

const STATUSES: Record<string, string[]> = {
  QUOTE: ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  BUDGET: ["DRAFT", "CONFIRMED", "CONVERTED", "CANCELLED"],
  ORDER: ["DRAFT", "CONFIRMED", "PARTIALLY_INVOICED", "INVOICED", "CANCELLED"],
  INVOICE: ["DRAFT", "CONFIRMED", "CANCELLED"],
  CREDIT_NOTE: ["CONFIRMED"],
};

function List({ slug }: { slug: string }) {
  const meta = SALES_DOCS[slug];
  const t = useTranslations();
  const { can } = useAuth();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const list = useFetch<Row[]>(can(`${meta.permission}:read`) ? meta.api : null, { page, limit: 20, status: status || undefined, search: search || undefined });

  const columns: Column<Row>[] = [
    { key: "number", header: t("fields.number"), render: (r) => r.number ?? <span className="text-gray-400">{t("common.draft")}</span> },
    { key: "docDate", header: t("fields.date"), render: (r) => fmtDate(r.docDate) },
    { key: "customerId", header: t("fields.customer"), render: (r) => r.customer?.legalName ?? "" },
    ...(meta.type === "INVOICE" || meta.type === "CREDIT_NOTE" ? [{ key: "controlNo", header: t("sales.controlNo"), render: (r: Row) => r.controlNo ?? "—" }] : []),
    ...(meta.type === "QUOTE" || meta.type === "BUDGET" ? [{ key: "validUntil", header: t("fields.validUntil"), render: (r: Row) => (r.validUntil ? fmtDate(r.validUntil) : "—") }] : []),
    { key: "status", header: t("fields.status"), render: (r) => <StatusBadge status={r.status} /> },
    { key: "total", header: t("fields.total"), align: "end", render: (r) => fmtMoney(r.total) },
  ];

  if (!can(`${meta.permission}:read`)) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;

  return (
    <div>
      <PageHeader
        title={t(`sidebar.items.sales-${slug}`)}
        actions={meta.type !== "CREDIT_NOTE" && can(`${meta.permission}:create`) && (
          <Button size="sm" startIcon={<PlusIcon />} onClick={() => router.push(`/sales/${slug}/new`)}>{t("common.new")}</Button>
        )}
      />
      <Card>
        <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <input type="search" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} placeholder={t("sales.searchHint")} aria-label={t("common.search")}
            className="h-11 rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" />
          <SelectField label="" value={status} onChange={(v) => (setStatus(v), setPage(1))} options={STATUSES[meta.type].map((s) => ({ value: s, label: t(`status.${s}`) }))} placeholder={t("common.allStatuses")} />
        </div>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} onRowClick={(r) => router.push(`/sales/${slug}/${r.id}`)} />
      </Card>
    </div>
  );
}
