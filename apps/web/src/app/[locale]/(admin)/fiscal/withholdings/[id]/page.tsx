"use client";

import ConfirmDialog from "@/components/erp/ConfirmDialog";
import { DecimalField, SelectField, TextField } from "@/components/erp/FormFields";
import { AsyncRefField } from "@/components/erp/RefSelect";
import { Card, ErrorBox, Loading, PageHeader, StatusBadge } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { useRouter } from "@/i18n/navigation";
import { ApiError, openPdf, post } from "@/lib/api";
import { fmtDate, fmtMoney, todayCaracas } from "@/lib/format";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;
const partyLabel = (r: Row) => `${r.rif} — ${r.legalName}`;

export default function WithholdingPage() {
  const { id } = useParams<{ id: string }>();
  return id === "new" ? <NewWithholding /> : <Detail id={id} />;
}

function NewWithholding() {
  const t = useTranslations();
  const router = useRouter();
  const notice = useNotice();
  const { can } = useAuth();
  const params = useSearchParams();
  const [h, setH] = useState({
    direction: params.get("direction") ?? "ISSUED", partyId: params.get("partyId") ?? "", partyDisplay: params.get("label") ?? "", documentId: params.get("doc") ?? "", kind: "IVA",
    percentage: "", baseBs: "", concept: "", externalNumber: "", voucherDate: todayCaracas(), notes: "",
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof h>) => setH((s) => ({ ...s, ...p }));
  const received = h.direction === "RECEIVED";
  const docs = useFetch<Row[]>(h.partyId ? "/fiscal/withholdings/eligible" : null, { direction: h.direction, partyId: h.partyId });
  const doc = docs.data?.find((d) => d.documentId === h.documentId);
  const fe = (f: string) => error?.details.find((d) => d.field === f)?.message ?? null;
  const base = h.baseBs !== "" ? Number(h.baseBs) : h.kind === "IVA" ? Number(doc?.taxBs ?? 0) : null;
  const estimate = base !== null && Number(h.percentage) > 0 ? (base * Number(h.percentage)) / 100 : null;

  if (!can("fiscal:withholdings:create")) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;
  async function submit() {
    setBusy(true); setError(null);
    try {
      const common = { kind: h.kind, percentage: h.percentage.trim() || undefined, baseBs: h.baseBs.trim() || undefined, concept: h.concept.trim() || null, voucherDate: h.voucherDate, notes: h.notes.trim() || null };
      const r = await post<Row>(received ? "/fiscal/withholdings/receive" : "/fiscal/withholdings/issue", received ? { ...common, salesDocumentId: h.documentId, externalNumber: h.externalNumber.trim() } : { ...common, purchaseDocumentId: h.documentId });
      notice.success(t("fiscal.created")); router.replace(`/fiscal/withholdings/${r.data.id}`);
    } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader title={t("fiscal.newTitle")} subtitle={t("fiscal.referenceNote")} actions={<Button variant="outline" size="sm" onClick={() => router.push("/fiscal/withholdings")}>{t("common.back")}</Button>} />
      <ErrorBox error={error} />
      <Card className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SelectField label={t("fiscal.direction")} value={h.direction} onChange={(v) => set({ direction: v, partyId: "", partyDisplay: "", documentId: "" })} options={["ISSUED", "RECEIVED"].map((d) => ({ value: d, label: t(`fiscal.directions.${d}`) }))} />
          <AsyncRefField className="sm:col-span-2" label={received ? t("fields.customer") : t("fields.supplier")} required resource={received ? "/customers" : "/suppliers"} labelFn={partyLabel} value={h.partyId} display={h.partyDisplay}
            onPick={(r) => set({ partyId: r.id, partyDisplay: partyLabel(r), documentId: "", percentage: h.kind === "IVA" && Number(r.retentionIvaPct) > 0 ? String(Number(r.retentionIvaPct)) : h.percentage })} />
          <SelectField label={t("fiscal.kind")} value={h.kind} onChange={(v) => set({ kind: v })} options={[{ value: "IVA", label: "IVA" }, { value: "ISLR", label: "ISLR" }]} />
          <DecimalField label={t("fiscal.percentage")} required={h.kind === "ISLR"} value={h.percentage} onChange={(v) => set({ percentage: v })} align="end" hint={h.kind === "IVA" ? t("fiscal.pctHint") : t("fiscal.islrHint")} error={fe("percentage")} />
          <DecimalField label={t("fiscal.baseOverride")} value={h.baseBs} onChange={(v) => set({ baseBs: v })} align="end" hint={t("fiscal.baseHint")} error={fe("baseBs")} />
          <TextField label={t("fiscal.voucherDate")} type="date" value={h.voucherDate} onChange={(v) => set({ voucherDate: v })} />
          {received && <TextField label={t("fiscal.externalNumber")} required value={h.externalNumber} onChange={(v) => set({ externalNumber: v })} error={fe("externalNumber")} />}
          <TextField className="sm:col-span-2" label={t("fiscal.concept")} value={h.concept} onChange={(v) => set({ concept: v })} />
        </div>
      </Card>
      <Card title={t("fiscal.documents")}>
        {!h.partyId ? <p className="text-sm text-gray-500">{t("fiscal.pickParty")}</p> : docs.loading ? <Loading /> : (docs.data?.length ?? 0) === 0 ? <p className="text-sm text-gray-500">{t("fiscal.noDocs")}</p> : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 text-gray-500 dark:border-gray-800"><th className="w-10" /><th className="py-2 text-start">{t("fields.number")}</th><th className="text-start">{t("fiscal.ref")}</th><th className="text-start">{t("fields.date")}</th><th className="text-end">{t("fiscal.vatBs")}</th><th className="text-end">{t("fields.balance")}</th><th className="text-start ps-4">{t("fiscal.already")}</th></tr></thead>
            <tbody>
              {docs.data!.map((d) => (
                <tr key={d.documentId} className="cursor-pointer border-b border-gray-50 dark:border-gray-800" onClick={() => set({ documentId: d.documentId })}>
                  <td><input type="radio" name="doc" aria-label={d.number} checked={h.documentId === d.documentId} onChange={() => set({ documentId: d.documentId })} /></td>
                  <td className="py-2">{d.number}</td><td>{d.ref ?? "—"}</td><td>{fmtDate(d.date)}</td><td className="text-end tabular-nums">{fmtMoney(d.taxBs)}</td><td className="text-end tabular-nums">{fmtMoney(d.balance)}</td>
                  <td className="ps-4 text-xs text-gray-500">{(d.withheld as string[]).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-gray-600 dark:text-gray-400">{estimate !== null && `${t("fiscal.estimate")}: Bs ${fmtMoney(estimate)}`}</p>
          <Button size="sm" disabled={busy || !h.partyId || !h.documentId || (received && !h.externalNumber.trim())} onClick={submit}>{t("fiscal.register")}</Button>
        </div>
      </Card>
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const router = useRouter();
  const w = useFetch<Row>(`/fiscal/withholdings/${id}`);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const d = w.data;
  if (w.loading && !d) return <Loading />;

  async function cancel(reason: string) {
    setBusy(true); setError(null);
    try { await post(`/fiscal/withholdings/${id}/cancel`, { reason }); notice.success(t("fiscal.cancelled")); setDialog(false); w.reload(); }
    catch (e) { setDialog(false); setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))); } finally { setBusy(false); }
  }
  const party = d?.supplier ?? d?.customer;
  return (
    <div>
      <PageHeader title={`${t("fiscal.voucher")} ${d?.number ?? ""}`} subtitle={d ? `${d.kind} · ${t(`fiscal.directions.${d.direction}`)}` : undefined}
        actions={<>{d && <StatusBadge status={d.status} />}<Button variant="outline" size="sm" onClick={() => router.push("/fiscal/withholdings")}>{t("common.back")}</Button></>} />
      <ErrorBox error={w.error ?? error} />
      {d?.status === "CANCELLED" && <p className="mb-4 rounded-lg bg-error-50 p-3 text-sm text-error-700 dark:bg-error-500/15 dark:text-error-500">{t("common.cancelReason")}: {d.cancelReason}</p>}
      {d && (
        <Card>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <Item label={t("fiscal.party")} value={party ? `${party.rif} — ${party.legalName}` : ""} />
            <Item label={t("fiscal.document")} value={d.purchase?.number ?? d.sale?.number ?? ""} />
            <Item label={t("fiscal.voucherDate")} value={fmtDate(d.voucherDate)} />
            <Item label={t("fiscal.period")} value={d.period} />
            {d.externalNumber && <Item label={t("fiscal.externalNumber")} value={d.externalNumber} />}
            <Item label={t("fiscal.base")} value={fmtMoney(d.baseBs)} />
            <Item label="%" value={fmtMoney(d.percentage)} />
            <Item label={t("fiscal.withheld")} value={fmtMoney(d.amountBs)} />
            {d.concept && <Item label={t("fiscal.concept")} value={d.concept} />}
          </dl>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <Button variant="outline" size="sm" onClick={() => openPdf(`/fiscal/withholdings/${id}/pdf`).catch((e) => setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e))))}>{t("sales.pdf")}</Button>
            {d.status === "CONFIRMED" && can("fiscal:withholdings:cancel") && <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog(true)}>{t("common.cancelDocument")}</Button>}
          </div>
        </Card>
      )}
      <ConfirmDialog open={dialog} busy={busy} danger requireReason title={t("common.cancelTitle")} message={t("fiscal.cancelMessage")} confirmLabel={t("common.cancelDocument")} onCancel={() => setDialog(false)} onConfirm={cancel} />
    </div>
  );
}

function Item({ label, value }: { label: string; value?: string }) {
  return <div><dt className="text-gray-500">{label}</dt><dd className="font-medium text-gray-800 dark:text-white/90">{value}</dd></div>;
}
