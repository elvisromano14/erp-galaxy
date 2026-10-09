"use client";

import ConfirmDialog from "@/components/erp/ConfirmDialog";
import DataTable, { type Column } from "@/components/erp/DataTable";
import { DecimalField, TextField } from "@/components/erp/FormFields";
import { AsyncRefField, RefSelect } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader, StatusBadge } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { ApiError, post } from "@/lib/api";
import { fmtDate, fmtMoney, todayCaracas } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;
const customerLabel = (r: Row) => `${r.rif} — ${r.legalName}`;

export default function ReceivablesPage() {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const [page, setPage] = useState(1);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [search, setSearch] = useState("");
  const list = useFetch<Row[]>(can("treasury:receivables:read") ? "/treasury/receivables" : null, { page, limit: 20, onlyOpen: onlyOpen || undefined, search: search || undefined });
  const [modal, setModal] = useState(false);
  const [f, setF] = useState({ customerId: "", customerDisplay: "", documentNo: "", issueDate: todayCaracas(), dueDate: "", currencyId: "", exchangeRate: "", amount: "", notes: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, ...p }));

  const columns: Column<Row>[] = [
    { key: "customerName", header: t("fields.customer") },
    { key: "documentNo", header: t("fields.number") },
    { key: "entryType", header: t("fields.type"), render: (r) => t(`enums.entryType.${r.entryType}`) },
    { key: "issueDate", header: t("fields.date"), render: (r) => fmtDate(r.issueDate) },
    { key: "dueDate", header: t("fields.dueDate"), render: (r) => fmtDate(r.dueDate) },
    { key: "amount", header: t("fields.amount"), align: "end", render: (r) => `${fmtMoney(r.amount)} ${r.currency}` },
    { key: "balance", header: t("fields.balance"), align: "end", render: (r) => fmtMoney(r.balance) },
    { key: "status", header: t("fields.status"), render: (r) => <StatusBadge status={r.status} /> },
    ...(can("treasury:receivables:create") ? [{ key: "actions", header: "", render: (r: Row) => (r.entryType === "OPENING" && r.status === "OPEN" ? <button className="text-xs text-error-600 hover:underline" onClick={() => setCancelId(r.id)}>{t("common.cancelDocument")}</button> : null) }] : []),
  ];

  async function save() {
    setBusy(true); setError(null);
    try {
      await post("/treasury/receivables/opening", { customerId: f.customerId, documentNo: f.documentNo.trim(), issueDate: f.issueDate, dueDate: f.dueDate || undefined, currencyId: f.currencyId, exchangeRate: f.exchangeRate.trim() || undefined, amount: f.amount, notes: f.notes.trim() || null });
      notice.success(t("common.saved")); setModal(false); list.reload();
    } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); }
  }
  async function cancel(reason: string) {
    setBusy(true);
    try { await post(`/treasury/receivables/${cancelId}/cancel`, { reason }); notice.success(t("treasury.cancelled")); list.reload(); } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); setCancelId(null); }
  }
  const fe = (k: string) => error?.details.find((d) => d.field === k)?.message ?? null;

  if (!can("treasury:receivables:read")) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;
  return (
    <div>
      <PageHeader title={t("sidebar.items.receivables")} actions={can("treasury:receivables:create") && <Button size="sm" onClick={() => { setError(null); setModal(true); }}>{t("treasury.openingBalance")}</Button>} />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-4">
          <input type="search" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} placeholder={t("treasury.searchDoc")} aria-label={t("common.search")}
            className="h-11 w-64 rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" />
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400"><input type="checkbox" checked={onlyOpen} onChange={(e) => (setOnlyOpen(e.target.checked), setPage(1))} />{t("treasury.onlyOpen")}</label>
        </div>
        <ErrorBox error={list.error ?? (modal ? null : error)} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} />
      </Card>
      {modal && (
        <Modal isOpen onClose={() => setModal(false)} className="m-4 max-w-2xl p-6">
          <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("treasury.openingBalance")}</h3>
          <p className="mb-4 text-sm text-gray-500">{t("treasury.openingHint")}</p>
          <ErrorBox error={error} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <AsyncRefField className="sm:col-span-2" label={t("fields.customer")} required resource="/customers" labelFn={customerLabel} value={f.customerId} display={f.customerDisplay} onPick={(r) => set({ customerId: r.id, customerDisplay: customerLabel(r) })} error={fe("customerId")} placeholder={t("sales.searchCustomer")} />
            <TextField label={t("treasury.documentNo")} required value={f.documentNo} onChange={(v) => set({ documentNo: v })} error={fe("documentNo")} />
            <RefSelect label={t("fields.currency")} required resource="/currencies" labelKey={(r) => `${r.code} — ${r.name}`} value={f.currencyId} onChange={(v) => set({ currencyId: v })} error={fe("currencyId")} />
            <TextField label={t("treasury.issueDate")} type="date" value={f.issueDate} onChange={(v) => set({ issueDate: v })} />
            <TextField label={t("fields.dueDate")} type="date" value={f.dueDate} onChange={(v) => set({ dueDate: v })} error={fe("dueDate")} hint={t("treasury.dueHint")} />
            <DecimalField label={t("fields.amount")} required value={f.amount} onChange={(v) => set({ amount: v })} align="end" hint={t("treasury.signHint")} error={fe("amount")} />
            <DecimalField label={t("fields.exchangeRate")} value={f.exchangeRate} onChange={(v) => set({ exchangeRate: v })} align="end" hint={t("purchases.rateHint")} />
            <TextField className="sm:col-span-2" label={t("fields.notes")} value={f.notes} onChange={(v) => set({ notes: v })} />
          </div>
          <div className="mt-6 flex justify-end gap-3"><Button variant="outline" size="sm" onClick={() => setModal(false)}>{t("common.cancel")}</Button><Button size="sm" disabled={busy || !f.customerId || !f.documentNo || !f.currencyId || !f.amount} onClick={save}>{t("common.save")}</Button></div>
        </Modal>
      )}
      <ConfirmDialog open={!!cancelId} busy={busy} danger requireReason title={t("common.cancelTitle")} message={t("treasury.cancelOpeningMessage")} confirmLabel={t("common.cancelDocument")} onCancel={() => setCancelId(null)} onConfirm={cancel} />
    </div>
  );
}
