"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { CheckField } from "@/components/erp/FormFields";
import { SelectField } from "@/components/erp/FormFields";
import { useOptions } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import { fmtMoney, fmtNumber, fmtQty } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

export default function StockPage() {
  const t = useTranslations();
  const warehouses = useOptions("/warehouses", (r) => `${r.code} — ${r.name}`);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [onlyPositive, setOnlyPositive] = useState(false);
  const [belowMin, setBelowMin] = useState(false);
  const list = useFetch<Row[]>("/inventory/stock", { page, limit: 25, search: search || undefined, warehouseId: warehouseId || undefined, onlyPositive: onlyPositive || undefined, belowMin: belowMin || undefined });

  const columns: Column<Row>[] = [
    { key: "sku", header: t("fields.sku") },
    { key: "name", header: t("fields.name") },
    { key: "warehouseCode", header: t("fields.warehouse") },
    { key: "quantity", header: t("fields.quantity"), align: "end", render: (r) => <span className={Number(r.quantity) < 0 ? "text-error-500" : ""}>{fmtQty(r.quantity)}</span> },
    { key: "avgCost", header: t("fields.avgCost"), align: "end", render: (r) => fmtNumber(r.avgCost, 2, 6) },
    { key: "value", header: t("fields.value"), align: "end", render: (r) => fmtMoney(r.value) },
    { key: "minStock", header: t("fields.minStock"), align: "end", render: (r) => fmtQty(r.minStock) },
  ];

  return (
    <div>
      <PageHeader title={t("sidebar.items.stock")} subtitle={t("inventory.stockSubtitle")} />
      <Card>
        <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
          <input
            type="search"
            value={search}
            onChange={(e) => (setSearch(e.target.value), setPage(1))}
            placeholder={t("common.search")}
            aria-label={t("common.search")}
            className="h-11 rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90"
          />
          <SelectField label="" value={warehouseId} onChange={(v) => (setWarehouseId(v), setPage(1))} options={warehouses.options} placeholder={t("inventory.allWarehouses")} />
          <CheckField label={t("inventory.onlyPositive")} checked={onlyPositive} onChange={(v) => (setOnlyPositive(v), setPage(1))} />
          <CheckField label={t("inventory.belowMin")} checked={belowMin} onChange={(v) => (setBelowMin(v), setPage(1))} />
        </div>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => `${r.productId}-${r.warehouseId}`} meta={list.meta} onPage={setPage} />
      </Card>
    </div>
  );
}
