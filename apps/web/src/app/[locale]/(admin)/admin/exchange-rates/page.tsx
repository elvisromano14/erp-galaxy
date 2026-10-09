"use client";

import { DecimalField, SelectField, TextField } from "@/components/erp/FormFields";
import DataTable, { type Column } from "@/components/erp/DataTable";
import { useOptions } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { ApiError, post } from "@/lib/api";
import { fmtDate, fmtNumber, todayCaracas } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

export default function ExchangeRatesPage() {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const currencies = useOptions("/currencies", (r) => `${r.code} — ${r.name}`);
  const [page, setPage] = useState(1);
  const [currencyId, setCurrencyId] = useState("");
  const list = useFetch<Row[]>("/exchange-rates", { page, limit: 20, currencyId: currencyId || undefined });
  const [form, setForm] = useState({ currencyId: "", rate: "", date: todayCaracas() });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const code = (id: string) => currencies.rows.find((c) => c.id === id)?.code ?? id;

  const columns: Column<Row>[] = [
    { key: "date", header: t("fields.date"), render: (r) => fmtDate(r.date) },
    { key: "currencyId", header: t("fields.currency"), render: (r) => code(r.currencyId) },
    { key: "rate", header: t("fields.rate"), align: "end", render: (r) => fmtNumber(r.rate, 2, 8) },
    { key: "source", header: t("fields.source") },
    { key: "createdAt", header: t("fields.createdAt"), render: (r) => new Date(r.createdAt).toLocaleString("es-VE") },
  ];

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/exchange-rates", { ...form, source: "MANUAL" });
      notice.success(t("common.saved"));
      setForm((f) => ({ ...f, rate: "" }));
      list.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title={t("sidebar.items.exchange-rates")} subtitle={t("fx.subtitle")} />
      {can("admin:exchange-rates:create") && (
        <Card title={t("fx.add")} className="mb-6">
          <ErrorBox error={error} />
          <form onSubmit={add} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <SelectField label={t("fields.currency")} required value={form.currencyId} onChange={(v) => setForm({ ...form, currencyId: v })} options={currencies.options.filter((o) => !o.label.startsWith("VES"))} />
            <DecimalField label={t("fields.rate")} required hint={t("fx.rateHint")} value={form.rate} onChange={(v) => setForm({ ...form, rate: v })} align="end" />
            <TextField label={t("fields.date")} type="date" required value={form.date} onChange={(v) => setForm({ ...form, date: v })} />
            <div className="flex items-end">
              <Button type="submit" size="sm" disabled={busy || !form.currencyId || !form.rate}>{t("common.save")}</Button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        <div className="mb-4 max-w-xs">
          <SelectField label={t("fields.currency")} value={currencyId} onChange={(v) => (setCurrencyId(v), setPage(1))} options={currencies.options} placeholder={t("common.all")} />
        </div>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} />
      </Card>
    </div>
  );
}
