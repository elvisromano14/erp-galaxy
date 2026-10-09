"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { DecimalField, TextField } from "@/components/erp/FormFields";
import { RefSelect } from "@/components/erp/RefSelect";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { useRouter } from "@/i18n/navigation";
import { ApiError, post } from "@/lib/api";
import { fmtMoney, todayCaracas } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

export default function AccountsPage() {
  const t = useTranslations();
  const { can } = useAuth();
  const router = useRouter();
  const notice = useNotice();
  const list = useFetch<Row[]>(can("treasury:movements:read") ? "/treasury/accounts/balances" : null);
  const [modal, setModal] = useState<null | "movement" | "transfer">(null);
  const [f, setF] = useState({ bankAccountId: "", kind: "DEPOSIT", amount: "", movementDate: todayCaracas(), reference: "", description: "", fromAccountId: "", toAccountId: "", amountIn: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((s) => ({ ...s, ...p }));
  const accounts = list.data ?? [];
  const cur = (id: string) => accounts.find((a) => a.id === id)?.currency;

  const columns: Column<Row>[] = [
    { key: "name", header: t("fields.name") },
    { key: "number", header: t("treasury.number"), render: (r) => `…${String(r.number).slice(-4)}` },
    { key: "currency", header: t("fields.currency") },
    { key: "balance", header: t("treasury.bookBalance"), align: "end", render: (r) => fmtMoney(r.balance) },
    { key: "reconciledBalance", header: t("treasury.reconciledBalance"), align: "end", render: (r) => fmtMoney(r.reconciledBalance) },
    { key: "unreconciledCount", header: t("treasury.pending"), align: "end" },
  ];

  async function submit() {
    setBusy(true); setError(null);
    try {
      if (modal === "movement") await post("/treasury/movements", { bankAccountId: f.bankAccountId, kind: f.kind, amount: f.amount, movementDate: f.movementDate, reference: f.reference.trim() || null, description: f.description.trim() || null });
      else await post("/treasury/transfers", { fromAccountId: f.fromAccountId, toAccountId: f.toAccountId, amountOut: f.amount, amountIn: f.amountIn.trim() || undefined, movementDate: f.movementDate, reference: f.reference.trim() || null });
      notice.success(t("common.saved")); setModal(null); list.reload();
    } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); }
  }
  const needsIn = modal === "transfer" && f.fromAccountId && f.toAccountId && cur(f.fromAccountId) !== cur(f.toAccountId);
  const accOpts = (r: Row) => `${r.name} (${r.currency})`;

  if (!can("treasury:movements:read")) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;
  return (
    <div>
      <PageHeader title={t("sidebar.items.accounts")} actions={can("treasury:movements:create") && (
        <>
          <Button variant="outline" size="sm" onClick={() => { setError(null); setModal("transfer"); }}>{t("treasury.transfer")}</Button>
          <Button size="sm" onClick={() => { setError(null); setModal("movement"); }}>{t("treasury.newMovement")}</Button>
        </>
      )} />
      <Card><ErrorBox error={list.error} /><DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/treasury/accounts/${r.id}`)} /></Card>

      {modal && (
        <Modal isOpen onClose={() => setModal(null)} className="m-4 max-w-xl p-6">
          <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{modal === "movement" ? t("treasury.newMovement") : t("treasury.transfer")}</h3>
          <ErrorBox error={error} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {modal === "movement" ? (
              <>
                <div className="sm:col-span-2"><RefSelect label={t("treasury.account")} required resource="/bank-accounts" labelKey={(r) => `${r.name} (${r.number.slice(-4)})`} value={f.bankAccountId} onChange={(v) => set({ bankAccountId: v })} /></div>
                <label className="block text-sm"><span className="mb-1.5 block font-medium text-gray-700 dark:text-gray-400">{t("treasury.kind")}</span>
                  <select value={f.kind} onChange={(e) => set({ kind: e.target.value })} className="h-11 w-full rounded-lg border border-gray-300 bg-transparent px-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white/90">
                    {["DEPOSIT", "WITHDRAWAL", "FEE", "ADJUSTMENT"].map((k) => <option key={k} value={k}>{t(`treasury.kinds.${k}`)}</option>)}
                  </select></label>
              </>
            ) : (
              <>
                <RefSelect label={t("treasury.from")} required resource="/treasury/accounts/balances" labelKey={accOpts} value={f.fromAccountId} onChange={(v) => set({ fromAccountId: v })} />
                <RefSelect label={t("treasury.to")} required resource="/treasury/accounts/balances" labelKey={accOpts} value={f.toAccountId} onChange={(v) => set({ toAccountId: v })} />
              </>
            )}
            <DecimalField label={modal === "transfer" ? t("treasury.amountOut") : t("fields.amount")} required value={f.amount} onChange={(v) => set({ amount: v })} align="end" hint={modal === "movement" && f.kind === "ADJUSTMENT" ? t("treasury.adjustHint") : undefined} />
            {needsIn && <DecimalField label={t("treasury.amountIn")} required value={f.amountIn} onChange={(v) => set({ amountIn: v })} align="end" />}
            <TextField label={t("fields.date")} type="date" value={f.movementDate} onChange={(v) => set({ movementDate: v })} />
            <TextField label={t("treasury.reference")} value={f.reference} onChange={(v) => set({ reference: v })} />
            {modal === "movement" && <TextField className="sm:col-span-2" label={t("fields.description")} value={f.description} onChange={(v) => set({ description: v })} />}
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="outline" size="sm" onClick={() => setModal(null)}>{t("common.cancel")}</Button>
            <Button size="sm" disabled={busy || !f.amount || (modal === "movement" ? !f.bankAccountId : !f.fromAccountId || !f.toAccountId)} onClick={submit}>{t("common.save")}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
