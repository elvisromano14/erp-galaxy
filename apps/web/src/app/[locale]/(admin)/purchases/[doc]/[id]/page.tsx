"use client";

import { calcDocument } from "@erp/domain";
import ConfirmDialog from "@/components/erp/ConfirmDialog";
import { DecimalField, IntField, SelectField, TextAreaField, TextField } from "@/components/erp/FormFields";
import LinesEditor, { isSerialLine, newKey, parseSerials, type Line, type LineCol } from "@/components/erp/LinesEditor";
import { PURCHASE_DOCS, SLUG_BY_TYPE, type PurchaseDocMeta } from "@/components/erp/purchase-docs";
import { AsyncRefField, RefSelect, useOptions } from "@/components/erp/RefSelect";
import { Card, ErrorBox, Loading, PageHeader, StatusBadge } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError, api, del, patch, post } from "@/lib/api";
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtQty, todayCaracas } from "@/lib/format";
import { notFound, useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

type Row = Record<string, any>;

export default function PurchaseDocPage() {
  const { doc, id } = useParams<{ doc: string; id: string }>();
  const meta = PURCHASE_DOCS[doc];
  if (!meta) notFound();
  return <Editor key={`${doc}-${id}`} meta={meta} id={id} />;
}

const supplierLabel = (r: Row) => `${r.rif} — ${r.legalName}`;

function Editor({ meta, id }: { meta: PurchaseDocMeta; id: string }) {
  const t = useTranslations();
  const { can, feature, me } = useAuth();
  const router = useRouter();
  const notice = useNotice();
  const params = useSearchParams();
  const isNew = id === "new";
  const parentParam = params.get("parent");
  const P = (a: string) => `${meta.permission}:${a}`;
  const isReturn = !!meta.parentSlug;

  const loaded = useFetch<Row>(isNew ? null : `${meta.api}/${id}`);
  const parentApi = meta.parentSlug ? PURCHASE_DOCS[meta.parentSlug].api : null;
  const parentDoc = useFetch<Row>(isNew && parentParam && parentApi ? `${parentApi}/${parentParam}` : null);
  const taxes = useOptions("/taxes", (r) => `${r.name} (${fmtNumber(r.rate)}%)`);
  const currencies = useOptions("/currencies", (r) => r.code);

  const [h, setH] = useState({
    supplierId: "", supplierDisplay: "", warehouseId: "", currencyId: "", exchangeRate: "", docDate: todayCaracas(), expiresAt: "",
    paymentCondition: "CASH", creditDays: "0", supplierDocNo: "", supplierControlNo: "", notes: "", parentId: "",
  });
  const [lines, setLines] = useState<Line[]>([{ _key: newKey() }]);
  const [version, setVersion] = useState<number | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "cancel" | "delete" | "confirm" | "send" | "reject">(null);
  const [receive, setReceive] = useState<Row[] | null>(null);
  const [receiveWh, setReceiveWh] = useState("");

  const doc = loaded.data;
  const status: string = doc?.status ?? "DRAFT";
  const readOnly = status !== "DRAFT" || (isNew ? !can(P("create")) : !can(P("update")));
  const set = (patchObj: Partial<typeof h>) => setH((s) => ({ ...s, ...patchObj }));

  // Carga de un documento existente
  useEffect(() => {
    if (!doc) return;
    setVersion(doc.version);
    setH({
      supplierId: doc.supplierId, supplierDisplay: doc.supplier ? supplierLabel(doc.supplier) : "", warehouseId: doc.warehouseId ?? "", currencyId: doc.currencyId,
      exchangeRate: String(doc.exchangeRate), docDate: String(doc.docDate).slice(0, 10), expiresAt: doc.expiresAt ? String(doc.expiresAt).slice(0, 10) : "",
      paymentCondition: doc.paymentCondition, creditDays: String(doc.creditDays), supplierDocNo: doc.supplierDocNo ?? "", supplierControlNo: doc.supplierControlNo ?? "",
      notes: doc.notes ?? "", parentId: doc.links?.parents?.[0]?.id ?? "",
    });
    setLines(
      (doc.lines as Row[]).map((l) => ({
        _key: l.id, productId: l.productId, productLabel: l.product ? `${l.product.sku} — ${l.product.name}` : l.productId,
        quantity: String(l.quantity), unitCost: String(l.unitCost), discountPct: String(l.discountPct), taxId: l.taxId ?? "",
        lotNo: l.lotNo ?? "", expiryDate: l.expiryDate ? String(l.expiryDate).slice(0, 10) : "", parentLineId: l.parentLineId ?? null,
        product: l.product, serialsText: ((l.serials as string[]) ?? []).join("\n"),
      })),
    );
  }, [doc]);

  // Devolución nueva: prellenar desde el documento origen
  useEffect(() => {
    const p = parentDoc.data;
    if (!p || !isNew) return;
    setH((s) => ({
      ...s, supplierId: p.supplierId, supplierDisplay: p.supplier ? supplierLabel(p.supplier) : "", warehouseId: p.warehouseId ?? "", currencyId: p.currencyId,
      exchangeRate: String(p.exchangeRate), paymentCondition: p.paymentCondition, creditDays: String(p.creditDays), parentId: p.id,
    }));
    const avail = new Map<string, string>((p.lineStatus ?? []).map((x: Row) => [x.lineId, String(x.available)]));
    setLines(
      (p.lines as Row[])
        .filter((l) => Number(avail.get(l.id) ?? l.quantity) > 0)
        .map((l) => ({
          _key: newKey(), productId: l.productId, productLabel: l.product ? `${l.product.sku} — ${l.product.name}` : l.productId,
          quantity: avail.get(l.id) ?? String(l.quantity), unitCost: String(l.unitCost), discountPct: String(l.discountPct), taxId: l.taxId ?? "",
          lotNo: l.lotNo ?? "", parentLineId: l.id, _maxQty: avail.get(l.id) ?? String(l.quantity),
          product: l.product, serialsText: "", // en devoluciones de productos por serial se indican los seriales que se devuelven
        })),
    );
  }, [parentDoc.data, isNew]);

  // Tasa del día: se sugiere al elegir moneda (solo en borrador)
  useEffect(() => {
    if (readOnly || !h.currencyId) return;
    const code = currencies.rows.find((c) => c.id === h.currencyId)?.code;
    if (code === "VES") {
      setH((s) => (s.exchangeRate === "1" ? s : { ...s, exchangeRate: "1" }));
      return;
    }
    if (!isNew && doc && doc.currencyId === h.currencyId) return;
    api<{ rate: string }>("/exchange-rates/latest", { query: { currencyId: h.currencyId, date: h.docDate } })
      .then((r) => setH((s) => (s.currencyId === h.currencyId ? { ...s, exchangeRate: r.data.rate } : s)))
      .catch(() => setH((s) => ({ ...s, exchangeRate: "" })));
  }, [h.currencyId, h.docDate, currencies.rows, readOnly, isNew, doc]);

  const taxById = useMemo(() => new Map(taxes.rows.map((r) => [r.id as string, r])), [taxes.rows]);

  // Totales en vivo con la MISMA lógica que el servidor (packages/domain); el servidor recalcula al guardar.
  const live = useMemo(() => {
    try {
      const valid = lines.filter((l) => l.productId && Number(l.quantity) > 0);
      const calc = calcDocument(valid.map((l) => {
        const tax = taxById.get(l.taxId || l.product?.taxId);
        return {
          quantity: l.quantity, unitPrice: l.unitCost || "0", discountPct: l.discountPct || "0",
          taxRate: tax?.rate ?? "0", taxExempt: !tax || tax.kind === "EXEMPT" || tax.kind === "EXONERATED",
        };
      }));
      return { calc, byKey: new Map(valid.map((l, i) => [l._key, calc.lines[i]])) };
    } catch {
      return null;
    }
  }, [lines, taxById]);

  const lotCols: LineCol[] = feature("lots") && ["DELIVERY_NOTE", "PURCHASE", "ORDER"].includes(meta.type)
    ? [{ key: "lotNo", header: t("fields.lotNo"), kind: "text", className: "min-w-28" }, ...(feature("expiry") ? [{ key: "expiryDate", header: t("fields.expiryDate"), kind: "date" as const, className: "min-w-36" }] : [])]
    : [];
  const fixedLines = isReturn; // en devoluciones solo se edita la cantidad
  const movesStock = ["DELIVERY_NOTE", "PURCHASE", "DELIVERY_NOTE_RETURN", "PURCHASE_RETURN"].includes(meta.type);
  const serialCol: LineCol[] = feature("serials") && movesStock ? [{ key: "serialsText", header: t("fields.serials"), kind: "serials", placeholder: t("inventory.serialsPlaceholder"), editable: (l) => isSerialLine(l) && !(meta.type === "PURCHASE" && l.parentLineId) }] : [];
  const notSerial = (l: Line) => !isSerialLine(l) || (meta.type === "PURCHASE" && !!l.parentLineId);
  const columns: LineCol[] = [
    { key: "product", header: t("fields.product"), kind: "product", className: "min-w-72", placeholder: t("inventory.searchProduct"), editable: () => !fixedLines },
    { key: "quantity", header: t("fields.quantity"), kind: "decimal", align: "end", className: "w-28", editable: notSerial },
    { key: "unitCost", header: t("fields.unitCost"), kind: "decimal", align: "end", className: "w-32", editable: () => !fixedLines },
    { key: "discountPct", header: t("fields.discountPct"), kind: "decimal", align: "end", className: "w-24", editable: () => !fixedLines },
    { key: "taxId", header: t("fields.tax"), kind: "select", options: taxes.options, className: "min-w-40", editable: () => !fixedLines },
    ...lotCols,
    ...serialCol,
    { key: "total", header: t("fields.total"), kind: "readonly", align: "end", format: (l) => { const c = live?.byKey.get(l._key); return c ? fmtMoney(c.total.toString()) : "—"; } },
  ];

  const fe = (field: string) => error?.details.find((d) => d.field === field)?.message ?? null;

  function body() {
    const v = (s?: string) => (s && s.trim() !== "" ? s.trim() : undefined);
    return {
      supplierId: h.supplierId, warehouseId: h.warehouseId || null, currencyId: h.currencyId, exchangeRate: v(h.exchangeRate),
      docDate: h.docDate, expiresAt: h.expiresAt || null, paymentCondition: h.paymentCondition, creditDays: Number(h.creditDays || 0),
      supplierDocNo: h.supplierDocNo.trim() || null, supplierControlNo: h.supplierControlNo.trim() || null, notes: h.notes.trim() || null,
      parentId: h.parentId || null, ...(version !== undefined ? { version } : {}),
      lines: lines.filter((l) => l.productId).map((l) => ({
        productId: l.productId, quantity: l.quantity, unitCost: l.unitCost || "0", discountPct: v(l.discountPct) ?? "0",
        taxId: l.taxId || null, lotNo: v(l.lotNo) ?? null, expiryDate: v(l.expiryDate) ?? null, parentLineId: l.parentLineId ?? null,
        ...(isSerialLine(l) && parseSerials(l.serialsText).length ? { serials: parseSerials(l.serialsText) } : {}),
      })),
    };
  }

  const fail = (e: unknown) => setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
  const slugOf = (type: string) => SLUG_BY_TYPE[type];
  const go = (slug: string, docId: string) => router.push(`/purchases/${slug}/${docId}`);

  async function saveDraft(): Promise<string | null> {
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const r = await post<Row>(meta.api, body());
        notice.success(t("common.saved"));
        router.replace(`/purchases/${meta.slug}/${r.data.id}`);
        return r.data.id;
      }
      await patch(`${meta.api}/${id}`, body());
      notice.success(t("common.saved"));
      loaded.reload();
      return id;
    } catch (e) {
      fail(e);
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** Ejecuta una acción de dominio (guardando antes el borrador si es necesario) y refresca. */
  async function action(path: string, okMessage: string, opts: { body?: unknown; save?: boolean; navigateTo?: (r: Row) => [string, string] } = {}) {
    setBusy(true);
    setError(null);
    try {
      let target = id;
      if (opts.save && !readOnly) {
        if (isNew) target = (await post<Row>(meta.api, body())).data.id;
        else await patch(`${meta.api}/${id}`, body());
      }
      const r = await post<Row>(path.replace(":id", target), opts.body);
      notice.success(okMessage);
      setDialog(null);
      if (opts.navigateTo) {
        const [slug, nid] = opts.navigateTo(r.data);
        go(slug, nid);
      } else if (isNew) router.replace(`/purchases/${meta.slug}/${target}`);
      else loaded.reload();
    } catch (e) {
      setDialog(null);
      fail(e);
      if (isNew) loaded.reload();
    } finally {
      setBusy(false);
    }
  }

  async function removeDraft() {
    setBusy(true);
    try {
      await del(`${meta.api}/${id}`);
      notice.success(t("common.deleted"));
      router.replace(`/purchases/${meta.slug}`);
    } catch (e) {
      setDialog(null);
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function openReceive() {
    const st: Row[] = doc?.lineStatus ?? [];
    setReceiveWh(doc?.warehouseId ?? "");
    setReceive((doc!.lines as Row[]).map((l) => ({ lineId: l.id, label: l.product ? `${l.product.sku} — ${l.product.name}` : l.productId, pending: st.find((s) => s.lineId === l.id)?.pending ?? "0", qty: "", lotNo: "", expiryDate: "", serial: l.product?.trackingMode === "SERIAL", serialsText: "" })).filter((x) => Number(x.pending) > 0));
  }

  async function doReceive() {
    if (!receive) return;
    const rows = receive.filter((r) => (r.serial ? parseSerials(r.serialsText).length > 0 : Number(r.qty) > 0));
    await action(`${meta.api}/:id/receive`, t("purchases.received"), {
      body: { warehouseId: receiveWh || undefined, lines: rows.map((r) => (r.serial ? { orderLineId: r.lineId, quantity: String(parseSerials(r.serialsText).length), serials: parseSerials(r.serialsText) } : { orderLineId: r.lineId, quantity: r.qty, lotNo: r.lotNo || undefined, expiryDate: r.expiryDate || undefined })) },
      navigateTo: (d) => ["delivery-notes", d.id],
    });
    setReceive(null);
  }

  if (!isNew && loaded.loading && !doc) return <Loading />;

  const typeName = t(`docTypes.${meta.type}`);
  const title = isNew ? t("purchases.newDoc", { type: typeName }) : `${typeName} ${doc?.number ?? t("common.draft")}`;
  const isBs = currencies.rows.find((c) => c.id === h.currencyId)?.code === "VES";
  const totals = live?.calc;
  const showFiscal = meta.type === "PURCHASE" || meta.type === "DELIVERY_NOTE";

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={doc ? `${fmtDate(doc.docDate)}${doc.confirmedAt ? ` · ${t("common.confirmedAt")} ${fmtDateTime(doc.confirmedAt)}` : ""}` : undefined}
        actions={
          <>
            {doc && <StatusBadge status={status} />}
            <Button variant="outline" size="sm" onClick={() => router.push(`/purchases/${meta.slug}`)}>{t("common.back")}</Button>
          </>
        }
      />
      <ErrorBox error={loaded.error ?? parentDoc.error ?? error} />
      {doc?.status === "CANCELLED" && doc.cancelReason && (
        <p className="mb-4 rounded-lg bg-error-50 p-3 text-sm text-error-700 dark:bg-error-500/15 dark:text-error-500">{t("common.cancelReason")}: {doc.cancelReason}</p>
      )}
      {isReturn && isNew && !parentParam && <p className="mb-4 rounded-lg bg-warning-50 p-3 text-sm text-warning-700 dark:bg-warning-500/15 dark:text-orange-400">{t("purchases.returnNeedsParent")}</p>}

      {doc && (doc.links?.parents?.length > 0 || doc.links?.children?.length > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {doc.links.parents.map((p: Row) => (
            <span key={p.id} className="text-gray-500">{t("purchases.origin")}: <Link className="text-brand-500 hover:underline" href={`/purchases/${slugOf(p.type)}/${p.id}`}>{t(`docTypes.${p.type}`)}</Link></span>
          ))}
          {doc.links.children.map((c: Row) => (
            <span key={c.id} className="text-gray-500">{t("purchases.derived")}: <Link className="text-brand-500 hover:underline" href={`/purchases/${slugOf(c.type)}/${c.id}`}>{t(`docTypes.${c.type}`)}</Link></span>
          ))}
        </div>
      )}

      <Card title={t("common.header")} className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <AsyncRefField className="sm:col-span-2" label={t("fields.supplier")} required resource="/suppliers" labelFn={supplierLabel} value={h.supplierId} display={h.supplierDisplay}
            onPick={(r) => set({ supplierId: r.id, supplierDisplay: supplierLabel(r), ...(h.paymentCondition === "CREDIT" ? { creditDays: String(r.creditDays ?? 0) } : {}) })} disabled={readOnly || isReturn || !!doc?.links?.parents?.length} error={fe("supplierId")} placeholder={t("purchases.searchSupplier")} />
          <TextField label={t("fields.date")} type="date" value={h.docDate} onChange={(v) => set({ docDate: v })} disabled={readOnly} error={fe("docDate")} />
          {meta.type === "QUOTE" && <TextField label={t("fields.expiresAt")} type="date" value={h.expiresAt} onChange={(v) => set({ expiresAt: v })} disabled={readOnly} />}
          <RefSelect label={t("fields.warehouse")} resource="/warehouses" labelKey={(r) => `${r.code} — ${r.name}`} value={h.warehouseId} onChange={(v) => set({ warehouseId: v })} disabled={readOnly || isReturn} error={fe("warehouseId")} />
          <RefSelect label={t("fields.currency")} required resource="/currencies" labelKey={(r) => `${r.code} — ${r.name}`} value={h.currencyId} onChange={(v) => set({ currencyId: v })} disabled={readOnly || isReturn} error={fe("currencyId")} />
          <DecimalField label={t("fields.exchangeRate")} value={h.exchangeRate} onChange={(v) => set({ exchangeRate: v })} disabled={readOnly || isBs || isReturn} hint={readOnly ? undefined : isBs ? t("purchases.baseCurrency") : t("purchases.rateHint")} error={fe("exchangeRate")} align="end" />
          <SelectField label={t("fields.paymentCondition")} value={h.paymentCondition} onChange={(v) => set({ paymentCondition: v })} disabled={readOnly || isReturn} options={["CASH", "CREDIT"].map((o) => ({ value: o, label: t(`enums.paymentCondition.${o}`) }))} />
          {h.paymentCondition === "CREDIT" && <IntField label={t("fields.creditDays")} value={h.creditDays} onChange={(v) => set({ creditDays: v })} disabled={readOnly || isReturn} />}
          {showFiscal && <TextField label={t("fields.supplierDocNo")} value={h.supplierDocNo} onChange={(v) => set({ supplierDocNo: v })} disabled={readOnly} error={fe("supplierDocNo")} required={meta.type === "PURCHASE"} />}
          {meta.type === "PURCHASE" && <TextField label={t("fields.supplierControlNo")} value={h.supplierControlNo} onChange={(v) => set({ supplierControlNo: v })} disabled={readOnly} />}
          <TextAreaField className="sm:col-span-2 xl:col-span-4" label={t("fields.notes")} rows={2} value={h.notes} onChange={(v) => set({ notes: v })} disabled={readOnly} />
        </div>
      </Card>

      <Card title={t("common.lines")}>
        <LinesEditor
          columns={columns}
          lines={lines}
          onChange={setLines}
          readOnly={readOnly}
          onProductPick={(_, p) => ({ taxId: p.taxId ?? "", quantity: p.trackingMode === "SERIAL" ? "" : "1", discountPct: "0", unitCost: "", serialsText: "" })}
          footer={
            <div className="mt-4 flex justify-end">
              <dl className="w-full max-w-sm space-y-1 text-sm">
                {!readOnly && totals ? (
                  <>
                    <Row label={t("fields.subtotal")} value={fmtMoney(totals.subtotal.toString())} />
                    {Number(totals.exemptBase) > 0 && <Row label={t("fields.exemptBase")} value={fmtMoney(totals.exemptBase.toString())} />}
                    <Row label={t("fields.taxTotal")} value={fmtMoney(totals.taxTotal.toString())} />
                    <Row label={t("fields.total")} value={fmtMoney(totals.total.toString())} bold />
                    {h.exchangeRate && !isBs && <Row label={t("fields.totalBase")} value={fmtMoney(totals.total.mul(h.exchangeRate).toDecimalPlaces(4).toString())} />}
                  </>
                ) : doc ? (
                  <>
                    <Row label={t("fields.subtotal")} value={fmtMoney(doc.subtotal)} />
                    {Number(doc.exemptBase) > 0 && <Row label={t("fields.exemptBase")} value={fmtMoney(doc.exemptBase)} />}
                    <Row label={t("fields.taxTotal")} value={fmtMoney(doc.taxTotal)} />
                    <Row label={t("fields.total")} value={fmtMoney(doc.total)} bold />
                    <Row label={t("fields.totalBase")} value={fmtMoney(doc.totalBase)} />
                  </>
                ) : null}
              </dl>
            </div>
          }
        />
      </Card>

      {(doc?.payable?.length ?? 0) > 0 && doc && (
        <Card title={t("purchases.payable")} className="mt-6">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 text-gray-500 dark:border-gray-800"><th className="py-2 text-start">{t("fields.type")}</th><th className="text-start">{t("fields.dueDate")}</th><th className="text-end">{t("fields.amount")}</th><th className="text-end">{t("fields.balance")}</th><th className="text-end">{t("fields.status")}</th></tr></thead>
            <tbody>
              {(doc.payable as Row[]).map((p) => (
                <tr key={p.id} className="border-b border-gray-50 dark:border-gray-800">
                  <td className="py-2">{t(`enums.entryType.${p.entryType}`)}</td><td>{fmtDate(p.dueDate)}</td>
                  <td className="text-end tabular-nums">{fmtMoney(p.amount)}</td><td className="text-end tabular-nums">{fmtMoney(p.balance)}</td>
                  <td className="text-end"><StatusBadge status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Actions />

      <ConfirmDialog open={dialog === "confirm"} busy={busy} title={t("purchases.confirmTitle")} message={t(`purchases.confirmMessage.${meta.type}`)} confirmLabel={t("common.confirmDocument")} onCancel={() => setDialog(null)} onConfirm={() => action(`${meta.api}/:id/confirm`, t("purchases.confirmedOk"), { save: true })} />
      <ConfirmDialog open={dialog === "send"} busy={busy} title={t("purchases.sendTitle")} message={t("purchases.sendMessage")} confirmLabel={t("purchases.send")} onCancel={() => setDialog(null)} onConfirm={() => action(`${meta.api}/:id/send`, t("purchases.sentOk"), { save: true })} />
      <ConfirmDialog open={dialog === "reject"} busy={busy} danger title={t("purchases.rejectTitle")} confirmLabel={t("purchases.reject")} onCancel={() => setDialog(null)} onConfirm={() => action(`${meta.api}/:id/reject`, t("purchases.rejectedOk"))} />
      <ConfirmDialog open={dialog === "cancel"} busy={busy} danger requireReason title={t("common.cancelTitle")} message={t(`purchases.cancelMessage.${meta.type}`)} confirmLabel={t("common.cancelDocument")} onCancel={() => setDialog(null)} onConfirm={(reason) => action(`${meta.api}/:id/cancel`, t("purchases.cancelledOk"), { body: { reason } })} />
      <ConfirmDialog open={dialog === "delete"} busy={busy} danger title={t("common.deleteTitle")} message={t("common.deleteMessage")} confirmLabel={t("common.delete")} onCancel={() => setDialog(null)} onConfirm={removeDraft} />

      {receive && (
        <Modal isOpen onClose={() => setReceive(null)} className="m-4 max-w-3xl p-6">
          <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("purchases.receiveTitle")}</h3>
          <RefSelect label={t("fields.warehouse")} required resource="/warehouses" labelKey={(r) => `${r.code} — ${r.name}`} value={receiveWh} onChange={setReceiveWh} className="mb-4 max-w-sm" />
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 text-gray-500 dark:border-gray-800"><th className="py-2 text-start">{t("fields.product")}</th><th className="text-end">{t("purchases.pending")}</th><th className="text-end">{t("purchases.receiveQty")}</th>{feature("lots") && <th className="text-start ps-3">{t("fields.lotNo")}</th>}</tr></thead>
            <tbody>
              {receive.map((r, i) => (
                <tr key={r.lineId} className="border-b border-gray-50 dark:border-gray-800">
                  <td className="py-2">{r.label}</td><td className="text-end tabular-nums">{fmtQty(r.pending)}</td>
                  <td className="w-32 py-1">{r.serial ? <textarea rows={2} aria-label={t("fields.serials")} placeholder={t("inventory.serialsPlaceholder")} value={r.serialsText} onChange={(e) => setReceive(receive.map((x, j) => (j === i ? { ...x, serialsText: e.target.value } : x)))} className="w-full min-w-48 rounded-lg border border-gray-300 bg-transparent px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" /> : <input inputMode="decimal" aria-label={t("purchases.receiveQty")} value={r.qty} onChange={(e) => setReceive(receive.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(",", ".").replace(/[^0-9.]/g, "") } : x)))} className="h-10 w-full rounded-lg border border-gray-300 bg-transparent px-3 text-end text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" />}</td>
                  {feature("lots") && <td className="ps-3"><input aria-label={t("fields.lotNo")} value={r.lotNo} onChange={(e) => setReceive(receive.map((x, j) => (j === i ? { ...x, lotNo: e.target.value } : x)))} className="h-10 w-full rounded-lg border border-gray-300 bg-transparent px-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white/90" /></td>}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="outline" size="sm" onClick={() => setReceive(null)}>{t("common.cancel")}</Button>
            <Button size="sm" disabled={busy || !receiveWh || !receive.some((r) => (r.serial ? parseSerials(r.serialsText).length > 0 : Number(r.qty) > 0))} onClick={doReceive}>{t("purchases.receive")}</Button>
          </div>
        </Modal>
      )}
    </div>
  );

  function Actions() {
    const btns: React.ReactNode[] = [];
    const add = (key: string, node: React.ReactNode) => btns.push(<span key={key}>{node}</span>);
    const T = meta.type;
    if (status === "DRAFT" && !isNew && can(P("update"))) add("del", <Button variant="danger" size="sm" disabled={busy} onClick={() => setDialog("delete")}>{t("common.delete")}</Button>);
    if (!readOnly) add("save", <Button variant="outline" size="sm" disabled={busy} onClick={saveDraft}>{t("common.saveDraft")}</Button>);

    if (T === "QUOTE") {
      if (status === "DRAFT" && can(P("confirm"))) add("send", <Button size="sm" disabled={busy} onClick={() => setDialog("send")}>{t("purchases.send")}</Button>);
      if (status === "SENT" && can(P("confirm"))) {
        add("rej", <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog("reject")}>{t("purchases.reject")}</Button>);
        add("acc", <Button size="sm" disabled={busy} onClick={() => action(`${meta.api}/:id/accept`, t("purchases.acceptedOk"))}>{t("purchases.accept")}</Button>);
      }
      if (status === "ACCEPTED" && can("purchases:orders:create")) add("conv", <Button size="sm" disabled={busy} onClick={() => action(`${meta.api}/:id/convert-to-order`, t("purchases.convertedOk"), { navigateTo: (d) => ["orders", d.id] })}>{t("purchases.convertToOrder")}</Button>);
      if (["SENT", "ACCEPTED"].includes(status) && can(P("cancel"))) add("cx", <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog("cancel")}>{t("common.cancelDocument")}</Button>);
    } else {
      if (status === "DRAFT" && can(P("confirm"))) add("conf", <Button size="sm" disabled={busy || (isReturn && !h.parentId)} onClick={() => setDialog("confirm")}>{t("common.confirmDocument")}</Button>);
      if (T === "ORDER" && ["CONFIRMED", "PARTIALLY_FULFILLED"].includes(status) && can("purchases:delivery-notes:create", "purchases:delivery-notes:confirm")) add("rcv", <Button size="sm" disabled={busy} onClick={openReceive}>{t("purchases.receive")}</Button>);
      if (T === "DELIVERY_NOTE" && status === "CONFIRMED") {
        if (can("purchases:invoices:create")) add("topur", <Button size="sm" disabled={busy} onClick={() => action(`${meta.api}/:id/convert-to-purchase`, t("purchases.convertedOk"), { navigateTo: (d) => ["invoices", d.id] })}>{t("purchases.convertToPurchase")}</Button>);
        if (can("purchases:delivery-note-returns:create")) add("ret", <Button variant="outline" size="sm" onClick={() => router.push(`/purchases/delivery-note-returns/new?parent=${id}`)}>{t("purchases.createReturn")}</Button>);
      }
      if (T === "PURCHASE" && status === "CONFIRMED" && doc?.paymentCondition === "CREDIT" && can("fiscal:withholdings:create")) add("wh", <Button variant="outline" size="sm" onClick={() => router.push(`/fiscal/withholdings/new?direction=ISSUED&partyId=${doc.supplierId}&label=${encodeURIComponent(h.supplierDisplay)}&doc=${id}`)}>{t("sales.withhold")}</Button>);
      if (T === "PURCHASE" && status === "CONFIRMED" && can("purchases:returns:create")) add("ret", <Button variant="outline" size="sm" onClick={() => router.push(`/purchases/returns/new?parent=${id}`)}>{t("purchases.createReturn")}</Button>);
      const cancellable = status !== "DRAFT" && !["CANCELLED", "REJECTED", "EXPIRED"].includes(status);
      if (cancellable && !isNew && can(P("cancel"))) add("cx", <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog("cancel")}>{t("common.cancelDocument")}</Button>);
    }
    return <div className="mt-6 flex flex-wrap justify-end gap-3">{btns}</div>;
  }
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "border-t border-gray-200 pt-2 text-base font-semibold text-gray-800 dark:border-gray-700 dark:text-white/90" : "text-gray-600 dark:text-gray-400"}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
