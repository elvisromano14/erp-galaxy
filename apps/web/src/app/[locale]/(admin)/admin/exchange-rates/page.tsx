"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { SelectField } from "@/components/erp/FormFields";
import { RDecimal, RSelect, RText } from "@/components/erp/rhf";
import { useOptions } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import Badge from "@/components/ui/badge/Badge";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { ApiError, post } from "@/lib/api";
import { fmtDate, fmtNumber, todayCaracas } from "@/lib/format";
import { reqPositiveDecimal, reqSelect } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type Row = Record<string, any>;
const schema = z.object({ currencyId: reqSelect, rate: reqPositiveDecimal, date: z.string().min(1, "Obligatorio") });

export default function ExchangeRatesPage() {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const currencies = useOptions("/currencies", (r) => `${r.code} — ${r.name}`);
  const [page, setPage] = useState(1);
  const [currencyId, setCurrencyId] = useState("");
  const [source, setSource] = useState("");
  const list = useFetch<Row[]>("/exchange-rates", { page, limit: 20, currencyId: currencyId || undefined, source: source || undefined });
  const [syncing, setSyncing] = useState(false);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { currencyId: "", rate: "", date: todayCaracas() } });
  const code = (id: string) => currencies.rows.find((c) => c.id === id)?.code ?? id;
  const nonVes = currencies.options.filter((o) => !o.label.startsWith("VES"));

  const columns: Column<Row>[] = [
    { key: "date", header: t("fields.date"), render: (r) => fmtDate(r.date) },
    { key: "currencyId", header: t("fields.currency"), render: (r) => code(r.currencyId) },
    { key: "rate", header: t("fx.rate"), align: "end", render: (r) => fmtNumber(r.rate, 2, 8) },
    { key: "source", header: t("fields.source"), render: (r) => <Badge size="sm" color={r.source === "BCV" ? "primary" : "warning"}>{r.source === "BCV" ? t("fx.sourceBcv") : t("fx.sourceManual")}</Badge> },
    { key: "createdAt", header: t("fields.createdAt"), render: (r) => new Date(r.createdAt).toLocaleString("es-VE") },
  ];

  async function syncNow() {
    setSyncing(true);
    setApiError(null);
    try {
      const r = await post<{ currency: string; rate: string; date: string; status: string; reason?: string }[]>("/exchange-rates/sync");
      const inserted = r.data.filter((x) => x.status === "INSERTED");
      notice.success(inserted.length ? t("fx.syncDone", { detail: inserted.map((x) => `${x.currency} ${fmtNumber(x.rate, 2, 4)}`).join(" · ") }) : t("fx.syncNoChanges"));
      list.reload();
    } catch (e) {
      setApiError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
    } finally {
      setSyncing(false);
    }
  }

  const submit = form.handleSubmit(async (v) => {
    setApiError(null);
    try {
      await post("/exchange-rates", v);
      notice.success(t("common.saved"));
      form.reset({ ...v, rate: "" });
      list.reload();
    } catch (err) {
      setApiError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });

  return (
    <div>
      <PageHeader
        title={t("sidebar.items.exchange-rates")}
        subtitle={t("fx.subtitle")}
        actions={can("admin:exchange-rates:create") && <Button size="sm" variant="outline" disabled={syncing} onClick={syncNow}>{syncing ? t("fx.syncing") : t("fx.syncNow")}</Button>}
      />
      <ErrorBox error={apiError} />
      {can("admin:exchange-rates:create") && (
        <Card title={t("fx.addManual")} className="mb-6">
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{t("fx.manualHelp")}</p>
          <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <RSelect control={form.control} name="currencyId" label={t("fields.currency")} required options={nonVes} />
            <RDecimal control={form.control} name="rate" label={t("fx.rate")} required hint={t("fx.rateHint")} align="end" />
            <RText control={form.control} name="date" type="date" label={t("fields.date")} required />
            <div className="flex items-end">
              <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>{t("fx.saveManual")}</Button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SelectField label={t("fields.currency")} value={currencyId} onChange={(v) => (setCurrencyId(v), setPage(1))} options={currencies.options} placeholder={t("common.all")} />
          <SelectField label={t("fields.source")} value={source} onChange={(v) => (setSource(v), setPage(1))} options={[{ value: "BCV", label: t("fx.sourceBcv") }, { value: "MANUAL", label: t("fx.sourceManual") }]} placeholder={t("common.all")} />
        </div>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} />
      </Card>
    </div>
  );
}
