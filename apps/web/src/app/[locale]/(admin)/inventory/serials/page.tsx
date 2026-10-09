"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { SelectField } from "@/components/erp/FormFields";
import { productLabel } from "@/components/erp/LinesEditor";
import { AsyncPicker, useOptions } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { fmtDateTime, fmtQty } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;
const COLOR = { IN_STOCK: "success", SOLD: "primary", RETURNED: "warning", SCRAPPED: "error" } as const;

export default function SerialsPage() {
  const t = useTranslations();
  const warehouses = useOptions("/warehouses", (r) => `${r.code} — ${r.name}`);
  const [product, setProduct] = useState<Row | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<Row | null>(null);
  const list = useFetch<Row[]>("/inventory/serials", { page, limit: 25, productId: product?.id, warehouseId: warehouseId || undefined, status: status || undefined, search: search || undefined });
  const wh = (id?: string | null) => (id ? warehouses.rows.find((w) => w.id === id)?.code ?? "" : "—");

  const columns: Column<Row>[] = [
    { key: "serialNo", header: t("fields.serial"), render: (r) => <span className="font-mono">{r.serialNo}</span> },
    { key: "product", header: t("fields.product"), render: (r) => (r.product ? productLabel(r.product) : r.productId) },
    { key: "status", header: t("fields.status"), render: (r) => <Badge size="sm" color={COLOR[r.status as keyof typeof COLOR]}>{t(`serialStatus.${r.status}`)}</Badge> },
    { key: "warehouseId", header: t("inventory.location"), render: (r) => wh(r.warehouseId) },
    { key: "updatedAt", header: t("fields.updatedAt"), render: (r) => fmtDateTime(r.updatedAt) },
  ];

  return (
    <div>
      <PageHeader title={t("sidebar.items.serials")} subtitle={t("inventory.serialsSubtitle")} />
      <Card>
        <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-400">{t("fields.product")}</label>
            <AsyncPicker resource="/products" value={product ? productLabel(product) : ""} labelFn={productLabel} placeholder={t("inventory.allProducts")} extraQuery={{ trackingMode: "SERIAL" }} onPick={(p) => (setProduct(p), setPage(1))} />
            {product && <button className="mt-1 text-xs text-brand-500" onClick={() => (setProduct(null), setPage(1))}>{t("common.clear")}</button>}
          </div>
          <SelectField label={t("fields.warehouse")} value={warehouseId} onChange={(v) => (setWarehouseId(v), setPage(1))} options={warehouses.options} placeholder={t("common.all")} />
          <SelectField label={t("fields.status")} value={status} onChange={(v) => (setStatus(v), setPage(1))} options={["IN_STOCK", "SOLD", "RETURNED", "SCRAPPED"].map((s) => ({ value: s, label: t(`serialStatus.${s}`) }))} placeholder={t("inventory.allStatuses")} />
          <input type="search" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} placeholder={t("fields.serial")} aria-label={t("common.search")}
            className="h-11 rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" />
        </div>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} onRowClick={setDetail} />
      </Card>
      {detail && <History serial={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function History({ serial, onClose }: { serial: Row; onClose: () => void }) {
  const t = useTranslations();
  const h = useFetch<{ movements: Row[] }>("/inventory/serials/history", { productId: serial.productId, serialNo: serial.serialNo });
  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-3xl p-6">
      <h3 className="mb-1 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("inventory.history")}: <span className="font-mono">{serial.serialNo}</span></h3>
      <p className="mb-4 text-sm text-gray-500">{serial.product ? productLabel(serial.product) : ""}</p>
      <ErrorBox error={h.error} />
      <table className="w-full text-sm">
        <thead><tr className="border-b border-gray-100 text-gray-500 dark:border-gray-800"><th className="py-2 text-start">{t("fields.date")}</th><th className="text-start">{t("fields.document")}</th><th className="text-end">{t("fields.quantity")}</th></tr></thead>
        <tbody>
          {(h.data?.movements ?? []).map((m) => (
            <tr key={m.id} className="border-b border-gray-50 dark:border-gray-800">
              <td className="py-2">{fmtDateTime(m.postedAt)}</td>
              <td>{t.has(`docTypes.${m.docType}`) ? t(`docTypes.${m.docType}`) : m.docType}{m.reversalOf ? ` (${t("inventory.reversal")})` : ""}</td>
              <td className="text-end tabular-nums">{fmtQty(m.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
