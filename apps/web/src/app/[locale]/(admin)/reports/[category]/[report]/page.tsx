"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { CheckField, SelectField, TextField } from "@/components/erp/FormFields";
import { productLabel } from "@/components/erp/LinesEditor";
import { AsyncPicker, useOptions } from "@/components/erp/RefSelect";
import { BoolBadge, Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useNotice } from "@/context/NoticeContext";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError, api, downloadFile, post } from "@/lib/api";
import { fmtDate, fmtDateTime, fmtNumber } from "@/lib/format";
import { notFound, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

type Row = Record<string, any>;
interface Col { key: string; header: string; type: string }
interface Def { category: string; id: string; title: string; description: string; filters: string[]; required: string[]; columns: Col[] }
interface Result { columns: Col[]; rows: Row[]; totals: Row | null; filtersText: string[]; rowCount: number; truncated: boolean; generatedAt: string }

const PURCHASE_STATUSES = ["CONFIRMED", "PARTIALLY_FULFILLED", "FULFILLED", "INVOICED", "CANCELLED"];
const DOC_TYPES = ["PURCHASE", "ORDER", "DELIVERY_NOTE", "PURCHASE_RETURN", "DELIVERY_NOTE_RETURN", "QUOTE"];

function cell(c: Col, v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === "") return "";
  switch (c.type) {
    case "money": return fmtNumber(v as string, 2, 4);
    case "cost": return fmtNumber(v as string, 2, 6);
    case "qty": return fmtNumber(v as string, 0, 4);
    case "int": return fmtNumber(v as string, 0, 0);
    case "pct": return `${fmtNumber(v as string, 2, 2)}%`;
    case "date": return fmtDate(v as string);
    case "datetime": return fmtDateTime(v as string);
    case "bool": return <BoolBadge value={!!v} />;
    default: return String(v);
  }
}

export default function ReportPage() {
  const { category, report } = useParams<{ category: string; report: string }>();
  const t = useTranslations();
  const notice = useNotice();
  const catalog = useFetch<Def[]>("/reports");
  const def = catalog.data?.find((d) => d.category === category && d.id === report);
  const warehouses = useOptions("/warehouses", (r) => `${r.code} — ${r.name}`);
  const categories = useOptions("/categories", (r) => `${r.code} — ${r.name}`);
  const lists = useOptions("/price-lists", (r) => `${r.code} — ${r.name}`);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<"run" | "pdf" | "xlsx" | "csv" | null>(null);
  const set = (k: string, v: string | boolean) => setValues((s) => ({ ...s, [k]: v }));

  const query = useMemo(() => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "" && v !== false)) as Record<string, string | boolean>, [values]);
  const missing = (def?.required ?? []).filter((k) => !values[k]);

  async function run() {
    setBusy("run");
    setError(null);
    try {
      setResult((await api<Result>(`/reports/${category}/${report}`, { query: { ...query, format: "json" } })).data as unknown as Result);
    } catch (e) {
      setResult(null);
      setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
    } finally {
      setBusy(null);
    }
  }

  const router = useRouter();
  async function inBackground(format: "pdf" | "xlsx" | "csv") {
    setBusy("run");
    try {
      await post("/reports/jobs", { category, report, format, filters: query });
      notice.success(t("reports.queued"));
      router.push("/reports/jobs");
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function exportAs(format: "pdf" | "xlsx" | "csv") {
    setBusy(format);
    try {
      await downloadFile(`/reports/${category}/${report}`, { ...query, format });
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Los reportes sin filtros obligatorios se generan al abrirlos.
  useEffect(() => {
    if (def && missing.length === 0 && !result && !error && busy === null) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def]);

  if (catalog.loading && !catalog.data) return <Loading />;
  if (catalog.data && !def) notFound();
  if (!def) return <ErrorBox error={catalog.error} />;

  const rows: Row[] = result ? [...result.rows, ...(result.totals ? [{ __total: true, ...result.totals }] : [])] : [];
  const columns: Column<Row>[] = (result?.columns ?? def.columns).map((c, i) => ({
    key: c.key, header: c.header, align: ["money", "cost", "qty", "int", "pct"].includes(c.type) ? "end" : "start",
    render: (r) => (r.__total ? <strong>{r[c.key] !== undefined ? cell(c, r[c.key]) : i === 0 ? t("reports.total") : ""}</strong> : cell(c, r[c.key])),
  }));
  const has = (k: string) => def.filters.includes(k);
  const req = (k: string) => def.required.includes(k);

  return (
    <div>
      <PageHeader
        title={def.title}
        subtitle={def.description}
        actions={
          <>
            <Link href={`/reports/${category}`} className="text-sm text-gray-500 hover:text-brand-500">← {t("reports.cat." + category)}</Link>
            {(["pdf", "xlsx", "csv"] as const).map((f) => (
              <Button key={f} variant="outline" size="sm" disabled={busy !== null || missing.length > 0} onClick={() => exportAs(f)}>
                {busy === f ? t("reports.exporting") : t(`reports.export${f === "pdf" ? "Pdf" : f === "xlsx" ? "Xlsx" : "Csv"}`)}
              </Button>
            ))}
            <select aria-label={t("reports.background")} disabled={busy !== null || missing.length > 0} value="" onChange={(e) => e.target.value && inBackground(e.target.value as "pdf" | "xlsx" | "csv")}
              className="h-9 rounded-lg border border-gray-300 bg-transparent px-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
              <option value="">{t("reports.background")}</option>
              {(["xlsx", "csv", "pdf"] as const).map((f) => <option key={f} value={f}>{t(`reports.export${f === "pdf" ? "Pdf" : f === "xlsx" ? "Xlsx" : "Csv"}`)}</option>)}
            </select>
          </>
        }
      />
      {def.filters.length > 0 && (
        <Card title={t("reports.filters")} className="mb-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {has("dateFrom") && <TextField label={t("fields.dateFrom")} type="date" value={String(values.dateFrom ?? "")} onChange={(v) => set("dateFrom", v)} />}
            {has("dateTo") && <TextField label={t("fields.dateTo")} type="date" value={String(values.dateTo ?? "")} onChange={(v) => set("dateTo", v)} />}
            {has("asOf") && <TextField label={t("fields.asOf")} type="date" value={String(values.asOf ?? "")} onChange={(v) => set("asOf", v)} />}
            {has("warehouseId") && <SelectField label={t("fields.warehouse")} required={req("warehouseId")} value={String(values.warehouseId ?? "")} onChange={(v) => set("warehouseId", v)} options={warehouses.options} placeholder={t("common.all")} />}
            {has("categoryId") && <SelectField label={t("fields.categoryId")} value={String(values.categoryId ?? "")} onChange={(v) => set("categoryId", v)} options={categories.options} placeholder={t("common.all")} />}
            {has("priceListId") && <SelectField label={t("fields.priceList")} value={String(values.priceListId ?? "")} onChange={(v) => set("priceListId", v)} options={lists.options} placeholder={t("common.default")} />}
            {has("supplierId") && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-400">{t("fields.supplier")} {req("supplierId") && <span className="text-error-500">*</span>}</label>
                <AsyncPicker resource="/suppliers" value={labels.supplierId ?? ""} labelFn={(r) => `${r.rif} — ${r.legalName}`} placeholder={t("common.all")} onPick={(r) => (set("supplierId", r.id), setLabels((l) => ({ ...l, supplierId: `${r.rif} — ${r.legalName}` })))} />
                {values.supplierId && <button className="mt-1 text-xs text-brand-500" onClick={() => (set("supplierId", ""), setLabels((l) => ({ ...l, supplierId: "" })))}>{t("common.clear")}</button>}
              </div>
            )}
            {has("customerId") && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-400">{t("fields.customer")} {req("customerId") && <span className="text-error-500">*</span>}</label>
                <AsyncPicker resource="/customers" value={labels.customerId ?? ""} labelFn={(r) => `${r.rif} — ${r.legalName}`} placeholder={t("common.all")} onPick={(r) => (set("customerId", r.id), setLabels((l) => ({ ...l, customerId: `${r.rif} — ${r.legalName}` })))} />
                {values.customerId && <button className="mt-1 text-xs text-brand-500" onClick={() => (set("customerId", ""), setLabels((l) => ({ ...l, customerId: "" })))}>{t("common.clear")}</button>}
              </div>
            )}
            {has("productId") && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-400">{t("fields.product")} {req("productId") && <span className="text-error-500">*</span>}</label>
                <AsyncPicker resource="/products" value={labels.productId ?? ""} labelFn={productLabel} placeholder={t("common.all")} onPick={(r) => (set("productId", r.id), setLabels((l) => ({ ...l, productId: productLabel(r) })))} />
                {values.productId && <button className="mt-1 text-xs text-brand-500" onClick={() => (set("productId", ""), setLabels((l) => ({ ...l, productId: "" })))}>{t("common.clear")}</button>}
              </div>
            )}
            {has("docType") && <SelectField label={t("fields.docType")} value={String(values.docType ?? "")} onChange={(v) => set("docType", v)} options={(category === "sales" ? ["QUOTE", "BUDGET", "ORDER", "INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"] : DOC_TYPES).map((d) => ({ value: d, label: category === "sales" ? t(`sales.docTypes.${d}`) : t(`docTypes.${d}`) }))} placeholder={t("common.all")} />}
            {has("status") && (
              <SelectField label={t("fields.status")} value={String(values.status ?? "")} onChange={(v) => set("status", v)} placeholder={t("common.all")}
                options={(report === "serials" ? ["IN_STOCK", "SOLD", "RETURNED", "SCRAPPED"] : category === "sales" ? ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CONFIRMED", "CONVERTED", "CANCELLED"] : category === "fiscal" ? ["CONFIRMED", "CANCELLED"] : PURCHASE_STATUSES).map((s) => ({ value: s, label: report === "serials" ? t(`serialStatus.${s}`) : t(`status.${s}`) }))} />
            )}
            {has("search") && <TextField label={t("fields.search")} value={String(values.search ?? "")} onChange={(v) => set("search", v)} />}
            {has("onlyWithStock") && <CheckField label={t("reports.onlyWithStock")} checked={!!values.onlyWithStock} onChange={(v) => set("onlyWithStock", v)} />}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" disabled={busy !== null || missing.length > 0} onClick={run}>{busy === "run" ? t("reports.running") : t("reports.run")}</Button>
            {missing.length > 0 && <span className="text-sm text-warning-600">{t("reports.required")}</span>}
          </div>
        </Card>
      )}
      <ErrorBox error={error} />
      {result && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-500 dark:text-gray-400">
            <span>{t("reports.rows", { count: result.rowCount })}{result.filtersText.length ? ` · ${result.filtersText.join(" · ")}` : ""}</span>
            <span>{t("reports.generated")}: {fmtDateTime(result.generatedAt)}</span>
          </div>
          {result.truncated && <p className="mb-3 rounded-lg bg-warning-50 p-2 text-sm text-warning-700 dark:bg-warning-500/15 dark:text-orange-400">{t("reports.truncated", { count: result.rows.length })}</p>}
          <DataTable columns={columns} rows={rows} rowKey={(r) => (r.__total ? "__total" : JSON.stringify(r).slice(0, 120) + rows.indexOf(r))} emptyText={t("reports.noRows")} />
        </Card>
      )}
    </div>
  );
}
