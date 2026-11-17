"use client";

import { DecimalField, IntField, SelectField, TextField } from "@/components/erp/FormFields";
import { RefSelect } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import Button from "@/components/ui/button/Button";
import { ApiError, openPdf } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useState } from "react";

/** Tamaños comunes de rollo de etiquetas (ancho × alto en mm). */
const PRESETS = ["50x30", "40x30", "60x40", "58x40", "100x50", "30x20"] as const;

/** Etiquetas con QR de los productos para pegar en cada uno (PDF a tamaño real del rollo; se imprime desde el navegador). */
export default function LabelsPage() {
  const t = useTranslations();
  const [categoryId, setCategoryId] = useState("");
  const [brand, setBrand] = useState("");
  const [search, setSearch] = useState("");
  const [copies, setCopies] = useState("1");
  const [preset, setPreset] = useState<string>("50x30");
  const [width, setWidth] = useState("50");
  const [height, setHeight] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const custom = preset === "custom";
  const [w, h] = custom ? [width, height] : preset.split("x");
  const hasFilter = !!(categoryId || brand.trim() || search.trim());

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await openPdf("/products/labels", {
        categoryId: categoryId || undefined, brand: brand.trim() || undefined, search: search.trim() || undefined,
        copies: Number(copies) || 1, width: Number(w), height: Number(h),
      });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title={t("labels.title")} subtitle={t("labels.subtitle")} />
      <ErrorBox error={error} />
      <Card title={t("labels.which")} className="mb-6">
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{hasFilter ? t("labels.filtered") : t("labels.all")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <RefSelect label={t("fields.categoryId")} resource="/categories" labelKey={(r) => `${r.code} — ${r.name}`} value={categoryId} onChange={setCategoryId} placeholder={t("common.all")} />
          <TextField label={t("fields.brand")} value={brand} onChange={setBrand} />
          <TextField label={t("common.search")} value={search} onChange={setSearch} hint={t("labels.searchHint")} />
        </div>
      </Card>
      <Card title={t("labels.format")}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <SelectField label={t("labels.size")} value={preset} onChange={setPreset} options={[...PRESETS.map((p) => ({ value: p, label: `${p.replace("x", " × ")} mm` })), { value: "custom", label: t("labels.custom") }]} />
          {custom && <DecimalField label={t("labels.width")} value={width} onChange={setWidth} align="end" />}
          {custom && <DecimalField label={t("labels.height")} value={height} onChange={setHeight} align="end" />}
          <IntField label={t("labels.copies")} value={copies} onChange={setCopies} hint={t("labels.copiesHint")} />
        </div>
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">{t("labels.printHelp")}</p>
        <div className="mt-4">
          <Button size="sm" disabled={busy} onClick={generate}>{busy ? t("labels.generating") : t("labels.generate")}</Button>
        </div>
      </Card>
    </div>
  );
}
