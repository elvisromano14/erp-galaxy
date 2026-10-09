"use client";

import ConfirmDialog from "@/components/erp/ConfirmDialog";
import { DecimalField, TextAreaField, TextField } from "@/components/erp/FormFields";
import { AsyncRefField, RefSelect } from "@/components/erp/RefSelect";
import { Card, ErrorBox, Loading, PageHeader, StatusBadge } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { useRouter } from "@/i18n/navigation";
import { ApiError, post } from "@/lib/api";
import { fmtDate, fmtMoney, todayCaracas } from "@/lib/format";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;
const customerLabel = (r: Row) => `${r.rif} — ${r.legalName}`;

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  return id === "new" ? <NewReceipt /> : <ReceiptDetail id={id} />;
}

function NewReceipt() {
  const t = useTranslations();
  const router = useRouter();
  const notice = useNotice();
  const { can } = useAuth();
  const [h, setH] = useState({ customerId: "", customerDisplay: "", paymentMethodId: "", bankAccountId: "", currencyId: "", exchangeRate: "", receiptDate: todayCaracas(), reference: "", notes: "" });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof h>) => setH((s) => ({ ...s, ...p }));
  const open = useFetch<Row[]>(h.customerId ? "/treasury/receivables/open" : null, { customerId: h.customerId });
  const currencies = useFetch<Row[]>("/currencies", { limit: 20 });
  const payCode = currencies.data?.find((c) => c.id === h.currencyId)?.code;
  const fe = (f: string) => error?.details.find((d) => d.field === f)?.message ?? null;

  if (!can("treasury:receipts:create")) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;
  const rows = open.data ?? [];
  const applied = rows.filter((e) => Number(amounts[e.id]) !== 0 && amounts[e.id] !== undefined && amounts[e.id] !== "");
  // Estimado solo si todo está en la moneda del pago; si no, el servidor convierte con la tasa del día.
  const sameCur = applied.every((e) => e.currencyId === h.currencyId);
  const estimate = applied.reduce((a, e) => a + Number(amounts[e.id]), 0);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await post<Row>("/treasury/receipts", {
        customerId: h.customerId, paymentMethodId: h.paymentMethodId, bankAccountId: h.bankAccountId || null, currencyId: h.currencyId,
        exchangeRate: h.exchangeRate.trim() || undefined, receiptDate: h.receiptDate, reference: h.reference.trim() || null, notes: h.notes.trim() || null,
        applications: applied.map((e) => ({ receivableEntryId: e.id, amount: amounts[e.id] })),
      });
      notice.success(t("treasury.received"));
      router.replace(`/treasury/receipts/${r.data.id}`);
    } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader title={t("treasury.newReceipt")} actions={<Button variant="outline" size="sm" onClick={() => router.push("/treasury/receipts")}>{t("common.back")}</Button>} />
      <ErrorBox error={error} />
      <Card title={t("common.header")} className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <AsyncRefField className="sm:col-span-2" label={t("fields.customer")} required resource="/customers" labelFn={customerLabel} value={h.customerId} display={h.customerDisplay}
            onPick={(r) => { set({ customerId: r.id, customerDisplay: customerLabel(r) }); setAmounts({}); }} error={fe("customerId")} placeholder={t("sales.searchCustomer")} />
          <TextField label={t("fields.date")} type="date" value={h.receiptDate} onChange={(v) => set({ receiptDate: v })} error={fe("receiptDate")} />
          <RefSelect label={t("treasury.method")} required resource="/payment-methods" labelKey={(r) => `${r.code} — ${r.name}`} value={h.paymentMethodId} onChange={(v) => set({ paymentMethodId: v })} error={fe("paymentMethodId")} />
          <RefSelect label={t("fields.currency")} required resource="/currencies" labelKey={(r) => `${r.code} — ${r.name}`} value={h.currencyId} onChange={(v) => set({ currencyId: v, bankAccountId: "" })} error={fe("currencyId")} />
          <RefSelect label={t("treasury.account")} resource="/bank-accounts" labelKey={(r) => `${r.name} (${r.number.slice(-4)})`} filter={h.currencyId ? { currencyId: h.currencyId } : undefined} value={h.bankAccountId} onChange={(v) => set({ bankAccountId: v })} error={fe("bankAccountId")} hint={t("treasury.accountHint")} />
          {payCode !== "VES" && <DecimalField label={t("fields.exchangeRate")} value={h.exchangeRate} onChange={(v) => set({ exchangeRate: v })} hint={t("purchases.rateHint")} align="end" error={fe("exchangeRate")} />}
          <TextField label={t("treasury.reference")} value={h.reference} onChange={(v) => set({ reference: v })} error={fe("reference")} />
          <TextAreaField className="sm:col-span-2 xl:col-span-4" label={t("fields.notes")} rows={2} value={h.notes} onChange={(v) => set({ notes: v })} />
        </div>
      </Card>
      <Card title={t("treasury.openReceivables")}>
        {!h.customerId ? <p className="text-sm text-gray-500">{t("treasury.pickCustomer")}</p> : open.loading ? <Loading /> : rows.length === 0 ? <p className="text-sm text-gray-500">{t("treasury.noOpen")}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 text-gray-500 dark:border-gray-800"><th className="py-2 text-start">{t("fields.number")}</th><th className="text-start">{t("fields.type")}</th><th className="text-start">{t("fields.dueDate")}</th><th className="text-end">{t("fields.balance")}</th><th className="ps-4 text-end">{t("treasury.toCollect")}</th><th /></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b border-gray-50 dark:border-gray-800">
                    <td className="py-2">{e.documentNo}</td>
                    <td>{t(`enums.entryType.${e.entryType}`)}</td><td>{fmtDate(e.dueDate)}</td>
                    <td className="text-end tabular-nums">{fmtMoney(e.balance)} {e.currency}</td>
                    <td className="ps-4"><input inputMode="decimal" aria-label={t("treasury.toCollect")} value={amounts[e.id] ?? ""} onChange={(ev) => setAmounts({ ...amounts, [e.id]: ev.target.value.replace(",", ".").replace(/[^0-9.-]/g, "") })}
                      className="h-10 w-36 rounded-lg border border-gray-300 bg-transparent px-3 text-end text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" /></td>
                    <td className="ps-2"><button type="button" className="text-xs text-brand-500 hover:underline" onClick={() => setAmounts({ ...amounts, [e.id]: String(e.balance) })}>{t("treasury.payAll")}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-gray-600 dark:text-gray-400">{applied.length > 0 && (sameCur ? `${t("treasury.total")}: ${fmtMoney(estimate)} ${payCode ?? ""}` : t("treasury.convertNotice"))}</p>
          <Button size="sm" disabled={busy || !h.customerId || !h.paymentMethodId || !h.currencyId || applied.length === 0} onClick={submit}>{t("treasury.registerReceipt")}</Button>
        </div>
      </Card>
    </div>
  );
}

function ReceiptDetail({ id }: { id: string }) {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const router = useRouter();
  const pay = useFetch<Row>(`/treasury/receipts/${id}`);
  const currencies = useFetch<Row[]>("/currencies", { limit: 20 });
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const p = pay.data;
  if (pay.loading && !p) return <Loading />;
  const cur = currencies.data?.find((c) => c.id === p?.currencyId)?.code ?? "";

  async function cancel(reason: string) {
    setBusy(true); setError(null);
    try { await post(`/treasury/receipts/${id}/cancel`, { reason }); notice.success(t("treasury.cancelled")); setDialog(false); pay.reload(); }
    catch (e) { setDialog(false); setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); }
  }
  return (
    <div>
      <PageHeader title={`${t("treasury.receipt")} ${p?.number ?? ""}`} subtitle={p ? fmtDate(p.receiptDate) : undefined}
        actions={<>{p && <StatusBadge status={p.status} />}<Button variant="outline" size="sm" onClick={() => router.push("/treasury/receipts")}>{t("common.back")}</Button></>} />
      <ErrorBox error={pay.error ?? error} />
      {p?.status === "CANCELLED" && <p className="mb-4 rounded-lg bg-error-50 p-3 text-sm text-error-700 dark:bg-error-500/15 dark:text-error-500">{t("common.cancelReason")}: {p.cancelReason}</p>}
      {p && (
        <>
          <Card title={t("common.header")} className="mb-6">
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <Item label={t("fields.customer")} value={p.customer ? `${p.customer.rif} — ${p.customer.legalName}` : ""} />
              <Item label={t("treasury.method")} value={p.method?.name} />
              <Item label={t("treasury.account")} value={p.account ? `${p.account.name} (${p.account.number.slice(-4)})` : "—"} />
              <Item label={t("fields.amount")} value={`${fmtMoney(p.amount)} ${cur}`} />
              <Item label={t("fields.exchangeRate")} value={fmtMoney(p.exchangeRate, 4)} />
              <Item label={t("treasury.reference")} value={p.reference ?? "—"} />
              <Item label={t("fields.notes")} value={p.notes ?? "—"} />
            </dl>
          </Card>
          <Card title={t("treasury.applications")}>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-100 text-gray-500 dark:border-gray-800"><th className="py-2 text-start">{t("fields.number")}</th><th className="text-start">{t("fields.type")}</th><th className="text-end">{t("fields.amount")}</th><th className="text-end">{t("treasury.balanceNow")}</th></tr></thead>
              <tbody>
                {(p.applications as Row[]).map((a) => (
                  <tr key={a.id} className="border-b border-gray-50 dark:border-gray-800"><td className="py-2">{a.documentNo ?? "—"}</td><td>{a.entryType ? t(`enums.entryType.${a.entryType}`) : "—"}</td>
                    <td className="text-end tabular-nums">{fmtMoney(a.amount)}</td><td className="text-end tabular-nums">{fmtMoney(a.balanceNow)}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
          {p.status === "CONFIRMED" && can("treasury:receipts:cancel") && (
            <div className="mt-6 flex justify-end"><Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog(true)}>{t("common.cancelDocument")}</Button></div>
          )}
        </>
      )}
      <ConfirmDialog open={dialog} busy={busy} danger requireReason title={t("common.cancelTitle")} message={t("treasury.cancelReceiptMessage")} confirmLabel={t("common.cancelDocument")} onCancel={() => setDialog(false)} onConfirm={cancel} />
    </div>
  );
}

function Item({ label, value }: { label: string; value?: string }) {
  return <div><dt className="text-gray-500">{label}</dt><dd className="font-medium text-gray-800 dark:text-white/90">{value}</dd></div>;
}
