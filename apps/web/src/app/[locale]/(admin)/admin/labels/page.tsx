"use client";

import Checkbox from "@/components/form/input/Checkbox";
import DataTable, { type Column } from "@/components/erp/DataTable";
import { CheckField, IntField, SelectField, TextField, DecimalField } from "@/components/erp/FormFields";
import { RefSelect } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { ApiError, openPdf } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/** Tamaños comunes de rollo de etiquetas (ancho × alto en mm). */
const PRESETS = ["50x30", "40x30", "60x40", "58x40", "100x50", "30x20"] as const;
/** Datos del producto que pueden ir en el QR (el código siempre va primero: es lo que lee el escáner de la app). */
const FIELDS = ["name", "description", "brand", "category", "unit", "barcode", "location"] as const;
const DEFAULT_FIELDS = ["name", "brand"];
const PAGE_SIZE = 20;
const MAX_SELECTED = 500;

interface Product { id: string; sku: string; name: string; brand?: string | null; description?: string | null }
interface PriceList { id: string; code: string; name: string }

const PrinterIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2" /><rect x="6" y="14" width="12" height="7" rx="1" />
  </svg>
);

/**
 * Etiquetas con QR: listado de productos con una impresora por fila, cajitas para elegir qué datos lleva el QR
 * e impresión masiva (de todo lo filtrado o de lo marcado). Se genera un PDF a tamaño real del rollo.
 */
export default function LabelsPage() {
  const t = useTranslations();
  const [categoryId, setCategoryId] = useState("");
  const [brand, setBrand] = useState("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState({ search: "", brand: "", categoryId: "" });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("sku");
  const [fields, setFields] = useState<string[]>(DEFAULT_FIELDS);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [copies, setCopies] = useState("1");
  const [preset, setPreset] = useState<string>("50x30");
  const [width, setWidth] = useState("50");
  const [height, setHeight] = useState("30");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // La búsqueda se aplica al escribir con una pequeña espera (no consulta en cada tecla).
  useEffect(() => {
    const id = setTimeout(() => { setApplied({ search: search.trim(), brand: brand.trim(), categoryId }); setPage(1); }, 350);
    return () => clearTimeout(id);
  }, [search, brand, categoryId]);

  const list = useFetch<Product[]>("/products", {
    page, limit: PAGE_SIZE, sort, isActive: true, isService: false,
    search: applied.search || undefined, brand: applied.brand || undefined, categoryId: applied.categoryId || undefined,
  });
  const lists = useFetch<PriceList[]>("/price-lists", { limit: 100, sort: "code" });
  const total = list.meta?.total ?? 0;

  const custom = preset === "custom";
  const [w, h] = custom ? [width, height] : preset.split("x");
  const toggle = (f: string, on: boolean) => setFields((cur) => (on ? [...cur, f] : cur.filter((x) => x !== f)));
  const rows = list.data ?? [];
  const pageAllSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleRow(r: Product, on: boolean) {
    setSelected((cur) => { const n = new Map(cur); if (on) n.set(r.id, r.sku); else n.delete(r.id); return n; });
  }
  function togglePage(on: boolean) {
    setSelected((cur) => { const n = new Map(cur); for (const r of rows) { if (on) n.set(r.id, r.sku); else n.delete(r.id); } return n; });
  }

  async function print(key: string, extra: Record<string, string | number | undefined>) {
    setBusy(key);
    setError(null);
    try {
      await openPdf("/products/labels", { ...extra, fields: fields.join(",") || undefined, copies: Number(copies) || 1, width: Number(w), height: Number(h) });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
    } finally {
      setBusy(null);
    }
  }
  const printOne = (r: Product) => print(r.id, { ids: r.id });
  const printSelected = () => print("sel", { ids: [...selected.keys()].join(",") });
  const printAll = () => print("all", { search: applied.search || undefined, brand: applied.brand || undefined, categoryId: applied.categoryId || undefined });

  const columns: Column<Product>[] = [
    {
      key: "pick", header: "", className: "w-10",
      render: (r) => <Checkbox checked={selected.has(r.id)} onChange={(v) => toggleRow(r, v)} />,
    },
    { key: "sku", header: t("fields.sku"), sort: "sku", render: (r) => <span className="font-medium">{r.sku}</span> },
    { key: "name", header: t("fields.name"), sort: "name" },
    { key: "brand", header: t("fields.brand"), sort: "brand", render: (r) => r.brand || "—" },
    {
      key: "actions", header: t("labels.actions"), align: "end",
      render: (r) => (
        <button
          type="button" title={t("labels.printOne")} aria-label={t("labels.printOne")} disabled={busy !== null}
          onClick={() => printOne(r)}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-brand-600 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-white/5"
        >
          {busy === r.id ? "…" : <PrinterIcon />}
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("labels.title")} subtitle={t("labels.subtitle")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null || selected.size === 0 || selected.size > MAX_SELECTED} onClick={printSelected} startIcon={<PrinterIcon />}>
              {t("labels.printSelected", { count: selected.size })}
            </Button>
            <Button size="sm" disabled={busy !== null || total === 0} onClick={printAll} startIcon={<PrinterIcon />}>
              {busy === "all" ? t("labels.generating") : t("labels.printAll", { count: total })}
            </Button>
          </div>
        }
      />
      <ErrorBox error={error} />

      <Card title={t("labels.contentTitle")} className="mb-6">
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t("labels.contentHelp")}</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          <CheckField label={t("labels.f.sku")} checked disabled onChange={() => {}} hint={t("labels.skuHint")} />
          {FIELDS.map((f) => <CheckField key={f} label={t(`labels.f.${f}`)} checked={fields.includes(f)} onChange={(v) => toggle(f, v)} />)}
          {(lists.data ?? []).map((l) => (
            <CheckField key={l.id} label={t("labels.f.price", { list: l.name })} checked={fields.includes(`price:${l.id}`)} onChange={(v) => toggle(`price:${l.id}`, v)} />
          ))}
        </div>
      </Card>

      <Card title={t("labels.format")} className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <SelectField label={t("labels.size")} value={preset} onChange={setPreset} options={[...PRESETS.map((p) => ({ value: p, label: `${p.replace("x", " × ")} mm` })), { value: "custom", label: t("labels.custom") }]} />
          {custom && <DecimalField label={t("labels.width")} value={width} onChange={setWidth} align="end" />}
          {custom && <DecimalField label={t("labels.height")} value={height} onChange={setHeight} align="end" />}
          <IntField label={t("labels.copies")} value={copies} onChange={setCopies} hint={t("labels.copiesHint")} />
        </div>
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">{t("labels.printHelp")}</p>
      </Card>

      <Card title={t("labels.which")}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <RefSelect label={t("fields.categoryId")} resource="/categories" labelKey={(r) => `${r.code} — ${r.name}`} value={categoryId} onChange={setCategoryId} placeholder={t("common.all")} />
          <TextField label={t("fields.brand")} value={brand} onChange={setBrand} />
          <TextField label={t("common.search")} value={search} onChange={setSearch} hint={t("labels.searchHint")} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
          <label className="inline-flex items-center gap-2">
            <Checkbox checked={pageAllSelected} onChange={togglePage} /> {t("labels.selectPage")}
          </label>
          {selected.size > 0 && (
            <>
              <span>{t("labels.selectedCount", { count: selected.size })}</span>
              <button type="button" className="text-brand-600 hover:underline" onClick={() => setSelected(new Map())}>{t("labels.clearSelection")}</button>
              {selected.size > MAX_SELECTED && <span className="text-error-600">{t("labels.tooManySelected", { max: MAX_SELECTED })}</span>}
            </>
          )}
        </div>
        <div className="mt-4">
          <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} sort={sort} onSort={setSort} />
        </div>
      </Card>
    </div>
  );
}
