"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { SelectField } from "@/components/erp/FormFields";
import { PURCHASE_DOCS } from "@/components/erp/purchase-docs";
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

export default function PurchaseDocList() {
  const { doc } = useParams<{ doc: string }>();
  if (!PURCHASE_DOCS[doc]) notFound();
  return <List key={doc} slug={doc} />;
}

const STATUSES: Record<string, string[]> = {
  QUOTE: ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  ORDER: ["DRAFT", "CONFIRMED", "PARTIALLY_FULFILLED", "FULFILLED", "CANCELLED"],
  DELIVERY_NOTE: ["DRAFT", "CONFIRMED", "INVOICED", "CANCELLED"],
  PURCHASE: ["DRAFT", "CONFIRMED", "CANCELLED"],
  DELIVERY_NOTE_RETURN: ["DRAFT", "CONFIRMED", "CANCELLED"],
  PURCHASE_RETURN: ["DRAFT", "CONFIRMED", "CANCELLED"],
};

function List({ slug }: { slug: string }) {
  const meta = PURCHASE_DOCS[slug];
  const t = useTranslations();
  const { can } = useAuth();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const list = useFetch<Row[]>(can(`${meta.permission}:read`) ? meta.api : null, { page, limit: 20, status: status || undefined, search: search || undefined });
  const suppliers = useFetch<Row[]>(can("admin:suppliers:read") ? "/suppliers" : null, { limit: 100 });
  const supplierName = (id: string) => suppliers.data?.find((s) => s.id === id)?.legalName ?? "";

  const columns: Column<Row>[] = [
    { key: "number", header: t("fields.number"), render: (r) => r.number ?? <span className="text-gray-400">{t("common.draft")}</span> },
    { key: "docDate", header: t("fields.date"), render: (r) => fmtDate(r.docDate) },
    { key: "supplierId", header: t("fields.supplier"), render: (r) => supplierName(r.supplierId) },
    ...(meta.type === "PURCHASE" || meta.type === "DELIVERY_NOTE" ? [{ key: "supplierDocNo", header: t("fields.supplierDocNo"), render: (r: Row) => r.supplierDocNo ?? "—" }] : []),
    { key: "status", header: t("fields.status"), render: (r) => <StatusBadge status={r.status} /> },
    { key: "total", header: t("fields.total"), align: "end", render: (r) => fmtMoney(r.total) },
  ];

  if (!can(`${meta.permission}:read`)) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;

  return (
    <div>
      <PageHeader
        title={t(`sidebar.items.${slug}`)}
        actions={can(`${meta.permission}:create`) && !meta.parentSlug && (
          <Button size="sm" startIcon={<PlusIcon />} onClick={() => router.push(`/purchases/${slug}/new`)}>{t("common.new")}</Button>
        )}
      />
      <Card>
        <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <input type="search" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} placeholder={t("common.searchNumber")} aria-label={t("common.search")}
            className="h-11 rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" />
          <SelectField label="" value={status} onChange={(v) => (setStatus(v), setPage(1))} options={STATUSES[meta.type].map((s) => ({ value: s, label: t(`status.${s}`) }))} placeholder={t("common.allStatuses")} />
        </div>
        {meta.parentSlug && <p className="mb-3 text-xs text-gray-500">{t("purchases.returnHint")}</p>}
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} onRowClick={(r) => router.push(`/purchases/${slug}/${r.id}`)} />
      </Card>
    </div>
  );
}
