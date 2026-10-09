"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { SelectField, TextField } from "@/components/erp/FormFields";
import { useOptions } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import { fmtMoney, fmtNumber, fmtQty } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

export default function ValuationPage() {
  const t = useTranslations();
  const warehouses = useOptions("/warehouses", (r) => `${r.code} — ${r.name}`);
  const categories = useOptions("/categories", (r) => `${r.code} — ${r.name}`);
  const [asOf, setAsOf] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const v = useFetch<{ asOf: string; rows: Row[]; totalValue: string }>("/inventory/valuation", { asOf: asOf || undefined, warehouseId: warehouseId || undefined, categoryId: categoryId || undefined });

  const columns: Column<Row>[] = [
    { key: "sku", header: t("fields.sku") },
    { key: "name", header: t("fields.name") },
    { key: "warehouseCode", header: t("fields.warehouse") },
    { key: "quantity", header: t("fields.quantity"), align: "end", render: (r) => fmtQty(r.quantity) },
    { key: "avgCost", header: t("fields.avgCost"), align: "end", render: (r) => fmtNumber(r.avgCost, 2, 6) },
    { key: "value", header: t("fields.value"), align: "end", render: (r) => fmtMoney(r.value) },
  ];

  return (
    <div>
      <PageHeader title={t("sidebar.items.valuation")} subtitle={t("inventory.valuationSubtitle")} />
      <Card>
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TextField label={t("inventory.asOf")} type="date" value={asOf} onChange={setAsOf} hint={t("inventory.asOfHint")} />
          <SelectField label={t("fields.warehouse")} value={warehouseId} onChange={setWarehouseId} options={warehouses.options} placeholder={t("common.all")} />
          <SelectField label={t("fields.categoryId")} value={categoryId} onChange={setCategoryId} options={categories.options} placeholder={t("common.all")} />
        </div>
        <ErrorBox error={v.error} />
        <DataTable columns={columns} rows={v.data?.rows ?? null} loading={v.loading} rowKey={(r) => `${r.productId}-${r.warehouseId}`} />
        {v.data && (
          <p className="mt-4 text-end text-base font-semibold text-gray-800 dark:text-white/90">
            {t("inventory.totalValue")}: <span className="tabular-nums">{fmtMoney(v.data.totalValue)}</span>
          </p>
        )}
      </Card>
    </div>
  );
}
