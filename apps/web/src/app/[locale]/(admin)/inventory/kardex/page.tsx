"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { SelectField, TextField } from "@/components/erp/FormFields";
import { AsyncPicker, useOptions } from "@/components/erp/RefSelect";
import { productLabel } from "@/components/erp/LinesEditor";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import Button from "@/components/ui/button/Button";
import { ApiError, api } from "@/lib/api";
import { fmtDateTime, fmtNumber, fmtQty } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

type Row = Record<string, any>;
const DOC_TYPES = ["TRANSFER", "CHARGE", "DISCHARGE", "ADJUSTMENT", "COST_ADJUSTMENT", "PURCHASE", "DELIVERY_NOTE", "PURCHASE_RETURN", "DELIVERY_NOTE_RETURN"];

export default function KardexPage() {
  const t = useTranslations();
  const warehouses = useOptions("/warehouses", (r) => `${r.code} — ${r.name}`);
  const [product, setProduct] = useState<Row | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [docType, setDocType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(
    async (after?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const r = await api<Row[]>("/inventory/kardex", {
          query: { limit: 50, productId: product?.id, warehouseId: warehouseId || undefined, docType: docType || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, cursor: after ?? undefined },
        });
        setRows((prev) => (after ? [...prev, ...r.data] : r.data));
        setCursor(r.meta?.nextCursor ?? null);
      } catch (e) {
        setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
      } finally {
        setLoading(false);
      }
    },
    [product?.id, warehouseId, docType, dateFrom, dateTo],
  );

  useEffect(() => {
    load(null);
  }, [load]);

  const wh = (id: string) => warehouses.rows.find((w) => w.id === id)?.code ?? "";
  const columns: Column<Row>[] = [
    { key: "postedAt", header: t("fields.date"), render: (r) => fmtDateTime(r.postedAt) },
    { key: "product", header: t("fields.product"), render: (r) => (r.product ? productLabel(r.product) : r.productId) },
    { key: "warehouseId", header: t("fields.warehouse"), render: (r) => wh(r.warehouseId) },
    { key: "docType", header: t("fields.document"), render: (r) => (<span>{t.has(`docTypes.${r.docType}`) ? t(`docTypes.${r.docType}`) : r.docType}{r.reversalOf ? ` (${t("inventory.reversal")})` : ""}</span>) },
    { key: "quantity", header: t("fields.quantity"), align: "end", render: (r) => <span className={Number(r.quantity) < 0 ? "text-error-500" : "text-success-600"}>{fmtQty(r.quantity)}</span> },
    { key: "unitCost", header: t("fields.unitCost"), align: "end", render: (r) => fmtNumber(r.unitCost, 2, 6) },
    { key: "totalCost", header: t("fields.totalCost"), align: "end", render: (r) => fmtNumber(r.totalCost, 2, 4) },
    { key: "warehouseQtyAfter", header: t("inventory.balanceWarehouse"), align: "end", render: (r) => fmtQty(r.warehouseQtyAfter) },
    { key: "qtyAfter", header: t("inventory.balanceTotal"), align: "end", render: (r) => fmtQty(r.qtyAfter) },
    { key: "avgCostAfter", header: t("fields.avgCost"), align: "end", render: (r) => fmtNumber(r.avgCostAfter, 2, 6) },
  ];

  return (
    <div>
      <PageHeader title={t("sidebar.items.kardex")} subtitle={t("inventory.kardexSubtitle")} />
      <Card>
        <div className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-400">{t("fields.product")}</label>
            <AsyncPicker resource="/products" value={product ? productLabel(product) : ""} labelFn={productLabel} placeholder={t("inventory.allProducts")} onPick={setProduct} />
            {product && <button className="mt-1 text-xs text-brand-500" onClick={() => setProduct(null)}>{t("common.clear")}</button>}
          </div>
          <SelectField label={t("fields.warehouse")} value={warehouseId} onChange={setWarehouseId} options={warehouses.options} placeholder={t("common.all")} />
          <SelectField label={t("fields.document")} value={docType} onChange={setDocType} options={DOC_TYPES.map((d) => ({ value: d, label: t(`docTypes.${d}`) }))} placeholder={t("common.all")} />
          <TextField label={t("common.dateFrom")} type="date" value={dateFrom} onChange={setDateFrom} />
          <TextField label={t("common.dateTo")} type="date" value={dateTo} onChange={setDateTo} />
        </div>
        <ErrorBox error={error} />
        <DataTable columns={columns} rows={rows} loading={loading && rows.length === 0} rowKey={(r) => r.id} />
        {cursor && (
          <div className="mt-4 flex justify-center">
            <Button variant="outline" size="sm" disabled={loading} onClick={() => load(cursor)}>{t("common.loadMore")}</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
