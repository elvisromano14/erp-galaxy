"use client";

import { CheckField, DecimalField, IntField, TextField } from "@/components/erp/FormFields";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import DataTable, { type Column } from "@/components/erp/DataTable";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { useRouter } from "@/i18n/navigation";
import { ApiError, post, uploadFile } from "@/lib/api";
import { fmtDate, fmtMoney, todayCaracas } from "@/lib/format";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

export default function LedgerPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations();
  const { can } = useAuth();
  const router = useRouter();
  const notice = useNotice();
  const [page, setPage] = useState(1);
  const [onlyPending, setOnlyPending] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState(false);
  const [stmt, setStmt] = useState({ date: todayCaracas(), balance: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [stModal, setStModal] = useState(false);
  const [stFile, setStFile] = useState<File | null>(null);
  const [st, setSt] = useState({ tolerance: "3", date: todayCaracas(), balance: "", createMissing: false });
  const [proposal, setProposal] = useState<Row | null>(null);
  const balances = useFetch<Row[]>("/treasury/accounts/balances");
  const acc = balances.data?.find((a) => a.id === id);
  const list = useFetch<Row[]>(`/treasury/accounts/${id}/movements`, { page, limit: 25, onlyUnreconciled: onlyPending || undefined });
  const canRec = can("treasury:reconciliations:create");
  const toggle = (mid: string) => setSelected((s) => { const n = new Set(s); n.has(mid) ? n.delete(mid) : n.add(mid); return n; });
  const sel = (list.data ?? []).filter((m) => selected.has(m.id));
  const selTotal = sel.reduce((a, m) => a + Number(m.amount), 0);

  const columns: Column<Row>[] = [
    ...(canRec ? [{ key: "sel", header: "", render: (r: Row) => (r.reconciled ? <span className="text-success-600">✓</span> : <input type="checkbox" aria-label={t("treasury.reconcile")} checked={selected.has(r.id)} onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} />) }] : []),
    { key: "movementDate", header: t("fields.date"), render: (r) => fmtDate(r.movementDate) },
    { key: "kind", header: t("treasury.kind"), render: (r) => t(`treasury.kinds.${r.kind}`) },
    { key: "reference", header: t("treasury.reference"), render: (r) => r.reference ?? "—" },
    { key: "description", header: t("fields.description"), render: (r) => r.description ?? "—" },
    { key: "amount", header: t("fields.amount"), align: "end", render: (r) => <span className={Number(r.amount) < 0 ? "text-error-600" : ""}>{fmtMoney(r.amount)}</span> },
    { key: "balance", header: t("treasury.runningBalance"), align: "end", render: (r) => fmtMoney(r.balance) },
  ];

  async function runStatement(mode: "validate" | "commit") {
    if (!stFile) return;
    setBusy(true); setError(null);
    try {
      const r = await uploadFile<Row>(`/treasury/accounts/${id}/statement`, stFile, {
        mode, toleranceDays: Number(st.tolerance || 3), ...(mode === "commit" ? { statementDate: st.date, statementBalance: st.balance, createMissing: st.createMissing } : {}),
      });
      setProposal(r.data);
      if (mode === "commit") { notice.success(t("treasury.stDone", { created: r.data.created, reconciled: r.data.reconciled })); setStModal(false); setProposal(null); setStFile(null); list.reload(); balances.reload(); }
    } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); }
  }

  async function reconcile() {
    setBusy(true); setError(null);
    try {
      await post("/treasury/reconciliations", { bankAccountId: id, statementDate: stmt.date, statementBalance: stmt.balance, movementIds: [...selected] });
      notice.success(t("treasury.reconciled")); setModal(false); setSelected(new Set()); list.reload(); balances.reload();
    } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader title={acc ? `${acc.name} (${acc.currency})` : t("sidebar.items.accounts")} subtitle={acc ? `${t("treasury.bookBalance")}: ${fmtMoney(acc.balance)} · ${t("treasury.reconciledBalance")}: ${fmtMoney(acc.reconciledBalance)}` : undefined}
        actions={<Button variant="outline" size="sm" onClick={() => router.push("/treasury/accounts")}>{t("common.back")}</Button>} />
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400"><input type="checkbox" checked={onlyPending} onChange={(e) => (setOnlyPending(e.target.checked), setPage(1))} />{t("treasury.onlyPending")}</label>
          {canRec && <Button variant="outline" size="sm" onClick={() => { setError(null); setProposal(null); setStModal(true); }}>{t("treasury.importStatement")}</Button>}
          {canRec && <Button size="sm" disabled={selected.size === 0} onClick={() => { setError(null); setModal(true); }}>{t("treasury.reconcileSelected", { count: selected.size })}</Button>}
        </div>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} />
      </Card>
      {stModal && (
        <Modal isOpen onClose={() => setStModal(false)} className="m-4 max-w-3xl p-6">
          <h3 className="mb-2 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("treasury.statementTitle")}</h3>
          <p className="mb-4 text-sm text-gray-500">{t("treasury.statementHint")}</p>
          <ErrorBox error={error} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-sm sm:col-span-2"><span className="mb-1.5 block font-medium text-gray-700 dark:text-gray-400">{t("treasury.statementFile")}</span>
              <input id="statement-file" type="file" accept=".xlsx,.csv,.txt" onChange={(e) => (setStFile(e.target.files?.[0] ?? null), setProposal(null))} className="block w-full text-sm text-gray-600 file:me-4 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-600 dark:text-gray-400" /></label>
            <IntField label={t("treasury.tolerance")} value={st.tolerance} onChange={(v) => (setSt({ ...st, tolerance: v }), setProposal(null))} />
            <TextField label={t("treasury.statementDate")} type="date" value={st.date} onChange={(v) => setSt({ ...st, date: v })} />
            <DecimalField label={t("treasury.statementBalance")} value={st.balance} onChange={(v) => setSt({ ...st, balance: v })} align="end" />
            <CheckField className="self-end pb-3" label={t("treasury.createMissing")} checked={st.createMissing} onChange={(v) => setSt({ ...st, createMissing: v })} />
          </div>
          {proposal && (
            <div className="mt-4 rounded-lg border border-gray-100 p-3 text-sm dark:border-gray-800">
              <p className="mb-2 font-medium text-gray-800 dark:text-white/90">{t("treasury.stSummary", { matched: proposal.summary.matched, unmatched: proposal.summary.unmatchedLines, pending: proposal.summary.unmatchedMovements, errors: proposal.summary.errors })}</p>
              {(proposal.errors as Row[]).slice(0, 5).map((e) => <p key={e.row} className="text-error-600">#{e.row}: {e.error}</p>)}
              {(proposal.unmatchedLines as Row[]).length > 0 && (
                <>
                  <p className="mt-2 text-gray-500">{t("treasury.stUnmatched")}</p>
                  <ul className="max-h-40 overflow-y-auto">{(proposal.unmatchedLines as Row[]).slice(0, 50).map((l) => <li key={l.row} className="flex justify-between border-b border-gray-50 py-1 dark:border-gray-800"><span>{fmtDate(l.date)} · {l.description || l.reference}</span><span className="tabular-nums">{fmtMoney(l.amount)}</span></li>)}</ul>
                </>
              )}
            </div>
          )}
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="outline" size="sm" onClick={() => setStModal(false)}>{t("common.cancel")}</Button>
            <Button variant="outline" size="sm" disabled={busy || !stFile} onClick={() => runStatement("validate")}>{t("treasury.validate")}</Button>
            <Button size="sm" disabled={busy || !stFile || !proposal || !st.balance} onClick={() => runStatement("commit")}>{t("treasury.applyReconcile")}</Button>
          </div>
        </Modal>
      )}
      {modal && (
        <Modal isOpen onClose={() => setModal(false)} className="m-4 max-w-md p-6">
          <h3 className="mb-2 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("treasury.reconcile")}</h3>
          <p className="mb-4 text-sm text-gray-500">{t("treasury.reconcileHint", { count: selected.size })}</p>
          <ErrorBox error={error} />
          <div className="grid gap-4">
            <TextField label={t("treasury.statementDate")} type="date" value={stmt.date} onChange={(v) => setStmt({ ...stmt, date: v })} />
            <DecimalField label={t("treasury.statementBalance")} required value={stmt.balance} onChange={(v) => setStmt({ ...stmt, balance: v })} align="end" hint={sel.length === selected.size ? `${t("treasury.selectedSum")}: ${fmtMoney(selTotal)}` : undefined} />
          </div>
          <div className="mt-6 flex justify-end gap-3"><Button variant="outline" size="sm" onClick={() => setModal(false)}>{t("common.cancel")}</Button><Button size="sm" disabled={busy || !stmt.balance} onClick={reconcile}>{t("treasury.reconcile")}</Button></div>
        </Modal>
      )}
    </div>
  );
}
