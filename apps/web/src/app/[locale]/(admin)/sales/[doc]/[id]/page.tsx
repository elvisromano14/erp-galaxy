"use client";

import { calcDocument } from "@erp/domain";
import ConfirmDialog from "@/components/erp/ConfirmDialog";
import { CheckField, DecimalField, IntField, SelectField, TextAreaField, TextField } from "@/components/erp/FormFields";
import LinesEditor, { newKey, type Line, type LineCol } from "@/components/erp/LinesEditor";
import { AsyncRefField, RefSelect, useOptions } from "@/components/erp/RefSelect";
import { SALES_DOCS, SALES_SLUG_BY_TYPE, type SalesDocMeta } from "@/components/erp/sales-docs";
import { Card, ErrorBox, Loading, PageHeader, StatusBadge } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError, api, del, patch, post } from "@/lib/api";
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, todayCaracas } from "@/lib/format";
import { notFound, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

type Row = Record<string, any>;

export default function SalesDocPage() {
  const { doc, id } = useParams<{ doc: string; id: string }>();
  const meta = SALES_DOCS[doc];
  if (!meta) notFound();
  return <Editor key={`${doc}-${id}`} meta={meta} id={id} />;
}

const customerLabel = (r: Row) => `${r.rif} — ${r.legalName}`;

function Editor({ meta, id }: { meta: SalesDocMeta; id: string }) {
  const t = useTranslations();
  const { can } = useAuth();
  const router = useRouter();
  const notice = useNotice();
  const isNew = id === "new";
  const P = (a: string) => `${meta.permission}:${a}`;

  const loaded = useFetch<Row>(isNew ? null : `${meta.api}/${id}`);
  const taxes = useOptions("/taxes", (r) => `${r.name} (${fmtNumber(r.rate)}%)`);
  const currencies = useOptions("/currencies", (r) => r.code);
  const priceLists = useFetch<Row[]>("/price-lists", { limit: 100 });

  const [h, setH] = useState({
    customerId: "", customerDisplay: "", customerPriceListId: "", sellerId: "", warehouseId: "", priceListId: "", currencyId: "", exchangeRate: "",
    docDate: todayCaracas(), validUntil: "", paymentCondition: "CASH", creditDays: "0", reservesStock: false, notes: "", parentId: "",
  });
  const [lines, setLines] = useState<Line[]>([{ _key: newKey() }]);
  const [version, setVersion] = useState<number | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "cancel" | "delete" | "confirm" | "send" | "reject">(null);

  const doc = loaded.data;
  const status: string = doc?.status ?? "DRAFT";
  const readOnly = status !== "DRAFT" || (isNew ? !can(P("create")) : !can(P("update")));
  const set = (p: Partial<typeof h>) => setH((s) => ({ ...s, ...p }));
  const hasParent = !!doc?.links?.parents?.length;

  useEffect(() => {
    if (!doc) return;
    setVersion(doc.version);
    setH({
      customerId: doc.customerId, customerDisplay: doc.customer ? customerLabel(doc.customer) : "", customerPriceListId: "", sellerId: doc.sellerId ?? "",
      warehouseId: doc.warehouseId ?? "", priceListId: doc.priceListId ?? "", currencyId: doc.currencyId, exchangeRate: String(doc.exchangeRate),
      docDate: String(doc.docDate).slice(0, 10), validUntil: doc.validUntil ? String(doc.validUntil).slice(0, 10) : "", paymentCondition: doc.paymentCondition,
      creditDays: String(doc.creditDays), reservesStock: doc.reservesStock, notes: doc.notes ?? "", parentId: doc.links?.parents?.[0]?.id ?? "",
    });
    setLines(
      (doc.lines as Row[]).map((l) => ({
        _key: l.id, productId: l.productId, productLabel: l.product ? `${l.product.sku} — ${l.product.name}` : l.productId,
        quantity: String(l.quantity), unitPrice: String(l.unitPrice), discountPct: String(l.discountPct), taxId: l.taxId ?? "",
        parentLineId: l.parentLineId ?? null, product: l.product,
      })),
    );
  }, [doc]);

  // Tasa del día al elegir moneda (solo en borrador)
  useEffect(() => {
    if (readOnly || !h.currencyId) return;
    const code = currencies.rows.find((c) => c.id === h.currencyId)?.code;
    if (code === "VES") { setH((s) => (s.exchangeRate === "1" ? s : { ...s, exchangeRate: "1" })); return; }
    if (!isNew && doc && doc.currencyId === h.currencyId) return;
    api<{ rate: string }>("/exchange-rates/latest", { query: { currencyId: h.currencyId, date: h.docDate } })
      .then((r) => setH((s) => (s.currencyId === h.currencyId ? { ...s, exchangeRate: r.data.rate } : s)))
      .catch(() => setH((s) => ({ ...s, exchangeRate: "" })));
  }, [h.currencyId, h.docDate, currencies.rows, readOnly, isNew, doc]);

  const taxById = useMemo(() => new Map(taxes.rows.map((r) => [r.id as string, r])), [taxes.rows]);

  // Lista de precios efectiva: la elegida, la del cliente o la predeterminada.
  const effectiveList = useMemo(() => {
    const rows = priceLists.data ?? [];
    return rows.find((p) => p.id === (h.priceListId || h.customerPriceListId)) ?? (h.priceListId || h.customerPriceListId ? undefined : rows.find((p) => p.isDefault));
  }, [priceLists.data, h.priceListId, h.customerPriceListId]);

  // Totales en vivo (misma lógica del servidor); las líneas sin precio se completan al guardar desde la lista.
  const live = useMemo(() => {
    try {
      const valid = lines.filter((l) => l.productId && Number(l.quantity) > 0);
      const calc = calcDocument(valid.map((l) => {
        const tax = taxById.get(l.taxId || l.product?.taxId);
        return { quantity: l.quantity, unitPrice: l.unitPrice || "0", discountPct: l.discountPct || "0", taxRate: tax?.rate ?? "0", taxExempt: !tax || tax.kind === "EXEMPT" || tax.kind === "EXONERATED" };
      }));
      return { calc, byKey: new Map(valid.map((l, i) => [l._key, calc.lines[i]])), unpriced: valid.some((l) => !l.unitPrice) };
    } catch { return null; }
  }, [lines, taxById]);

  /** Al elegir producto se propone su precio vigente si la lista efectiva está en la moneda del documento; si no, lo resuelve el servidor. */
  function suggestPrice(key: string, productId: string) {
    if (!effectiveList || effectiveList.currencyId !== h.currencyId) return;
    api<Row>(`/products/${productId}`).then((r) => {
      const price = (r.data.prices as Row[] | undefined)?.find((p) => p.priceListId === effectiveList.id)?.price;
      if (price !== undefined) setLines((ls) => ls.map((l) => (l._key === key && !l.unitPrice ? { ...l, unitPrice: String(price) } : l)));
    }).catch(() => undefined);
  }

  const columns: LineCol[] = [
    { key: "product", header: t("fields.product"), kind: "product", className: "min-w-72", placeholder: t("inventory.searchProduct"), editable: () => !hasParent },
    { key: "quantity", header: t("fields.quantity"), kind: "decimal", align: "end", className: "w-28" },
    { key: "unitPrice", header: t("fields.unitPrice"), kind: "decimal", align: "end", className: "w-32", placeholder: t("sales.priceFromList"), editable: () => !hasParent },
    { key: "discountPct", header: t("fields.discountPct"), kind: "decimal", align: "end", className: "w-24", editable: () => !hasParent },
    { key: "taxId", header: t("fields.tax"), kind: "select", options: taxes.options, className: "min-w-40", editable: () => !hasParent },
    { key: "total", header: t("fields.total"), kind: "readonly", align: "end", format: (l) => { const c = live?.byKey.get(l._key); return c && l.unitPrice ? fmtMoney(c.total.toString()) : "—"; } },
  ];

  const fe = (field: string) => error?.details.find((d) => d.field === field)?.message ?? null;

  function body() {
    const v = (s?: string) => (s && s.trim() !== "" ? s.trim() : undefined);
    return {
      customerId: h.customerId, sellerId: h.sellerId || null, warehouseId: h.warehouseId || null, priceListId: h.priceListId || null, currencyId: h.currencyId,
      exchangeRate: v(h.exchangeRate), docDate: h.docDate, validUntil: h.validUntil || null, paymentCondition: h.paymentCondition, creditDays: Number(h.creditDays || 0),
      reservesStock: meta.type === "QUOTE" ? false : h.reservesStock, notes: h.notes.trim() || null, parentId: h.parentId || null, ...(version !== undefined ? { version } : {}),
      lines: lines.filter((l) => l.productId).map((l) => ({
        productId: l.productId, quantity: l.quantity, ...(v(l.unitPrice) ? { unitPrice: l.unitPrice } : {}), discountPct: v(l.discountPct) ?? "0", taxId: l.taxId || null, parentLineId: l.parentLineId ?? null,
      })),
    };
  }

  const fail = (e: unknown) => setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
  const go = (slug: string, docId: string) => router.push(`/sales/${slug}/${docId}`);

  async function saveDraft() {
    setBusy(true); setError(null);
    try {
      if (isNew) { const r = await post<Row>(meta.api, body()); notice.success(t("common.saved")); router.replace(`/sales/${meta.slug}/${r.data.id}`); }
      else { await patch(`${meta.api}/${id}`, body()); notice.success(t("common.saved")); loaded.reload(); }
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function action(path: string, okMessage: string, opts: { body?: unknown; save?: boolean; navigateTo?: (r: Row) => [string, string] } = {}) {
    setBusy(true); setError(null);
    try {
      let target = id;
      if (opts.save && !readOnly) {
        if (isNew) target = (await post<Row>(meta.api, body())).data.id;
        else await patch(`${meta.api}/${id}`, body());
      }
      const r = await post<Row>(path.replace(":id", target), opts.body);
      notice.success(okMessage); setDialog(null);
      if (opts.navigateTo) { const [slug, nid] = opts.navigateTo(r.data); go(slug, nid); }
      else if (isNew) router.replace(`/sales/${meta.slug}/${target}`);
      else loaded.reload();
    } catch (e) { setDialog(null); fail(e); if (isNew) loaded.reload(); } finally { setBusy(false); }
  }

  async function removeDraft() {
    setBusy(true);
    try { await del(`${meta.api}/${id}`); notice.success(t("common.deleted")); router.replace(`/sales/${meta.slug}`); }
    catch (e) { setDialog(null); fail(e); } finally { setBusy(false); }
  }

  if (!isNew && loaded.loading && !doc) return <Loading />;

  const typeName = t(`sales.docTypes.${meta.type}`);
  const title = isNew ? t("purchases.newDoc", { type: typeName }) : `${typeName} ${doc?.number ?? t("common.draft")}`;
  const isBs = currencies.rows.find((c) => c.id === h.currencyId)?.code === "VES";
  const totals = live?.calc;
  const reservable = meta.type !== "QUOTE";

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={doc ? `${fmtDate(doc.docDate)}${doc.confirmedAt ? ` · ${t("common.confirmedAt")} ${fmtDateTime(doc.confirmedAt)}` : ""}` : undefined}
        actions={<>{doc && <StatusBadge status={status} />}<Button variant="outline" size="sm" onClick={() => router.push(`/sales/${meta.slug}`)}>{t("common.back")}</Button></>}
      />
      <ErrorBox error={loaded.error ?? error} />
      {doc?.status === "CANCELLED" && doc.cancelReason && (
        <p className="mb-4 rounded-lg bg-error-50 p-3 text-sm text-error-700 dark:bg-error-500/15 dark:text-error-500">{t("common.cancelReason")}: {doc.cancelReason}</p>
      )}
      {doc?.stockReserved && <p className="mb-4 rounded-lg bg-brand-50 p-3 text-sm text-brand-700 dark:bg-brand-500/15 dark:text-brand-400">{t("sales.reservedNotice")}</p>}

      {doc && (doc.links?.parents?.length > 0 || doc.links?.children?.length > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          {doc.links.parents.map((p: Row) => (
            <span key={p.id} className="text-gray-500">{t("purchases.origin")}: <Link className="text-brand-500 hover:underline" href={`/sales/${SALES_SLUG_BY_TYPE[p.type]}/${p.id}`}>{t(`sales.docTypes.${p.type}`)}</Link></span>
          ))}
          {doc.links.children.map((c: Row) => (
            <span key={c.id} className="text-gray-500">{t("purchases.derived")}: <Link className="text-brand-500 hover:underline" href={`/sales/${SALES_SLUG_BY_TYPE[c.type]}/${c.id}`}>{t(`sales.docTypes.${c.type}`)}</Link></span>
          ))}
        </div>
      )}

      <Card title={t("common.header")} className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <AsyncRefField className="sm:col-span-2" label={t("fields.customer")} required resource="/customers" labelFn={customerLabel} value={h.customerId} display={h.customerDisplay}
            onPick={(r) => set({ customerId: r.id, customerDisplay: customerLabel(r), customerPriceListId: r.priceListId ?? "", ...(r.sellerId && !h.sellerId ? { sellerId: r.sellerId } : {}), ...(h.paymentCondition === "CREDIT" ? { creditDays: String(r.creditDays ?? 0) } : {}) })}
            disabled={readOnly || hasParent} error={fe("customerId")} placeholder={t("sales.searchCustomer")} />
          <TextField label={t("fields.date")} type="date" value={h.docDate} onChange={(v) => set({ docDate: v })} disabled={readOnly} error={fe("docDate")} />
          {meta.type !== "ORDER" && <TextField label={t("fields.validUntil")} type="date" value={h.validUntil} onChange={(v) => set({ validUntil: v })} disabled={readOnly} />}
          <RefSelect label={t("fields.seller")} resource="/sellers" labelKey={(r) => `${r.code} — ${r.name}`} value={h.sellerId} onChange={(v) => set({ sellerId: v })} disabled={readOnly} error={fe("sellerId")} />
          <RefSelect label={t("fields.warehouse")} resource="/warehouses" labelKey={(r) => `${r.code} — ${r.name}`} value={h.warehouseId} onChange={(v) => set({ warehouseId: v })} disabled={readOnly} error={fe("warehouseId")} />
          <RefSelect label={t("fields.priceList")} resource="/price-lists" labelKey={(r) => `${r.code} — ${r.name}`} value={h.priceListId} onChange={(v) => set({ priceListId: v })} disabled={readOnly || hasParent} hint={readOnly ? undefined : t("sales.priceListHint")} />
          <RefSelect label={t("fields.currency")} required resource="/currencies" labelKey={(r) => `${r.code} — ${r.name}`} value={h.currencyId} onChange={(v) => set({ currencyId: v })} disabled={readOnly || hasParent} error={fe("currencyId")} />
          <DecimalField label={t("fields.exchangeRate")} value={h.exchangeRate} onChange={(v) => set({ exchangeRate: v })} disabled={readOnly || isBs || hasParent} hint={readOnly ? undefined : isBs ? t("purchases.baseCurrency") : t("purchases.rateHint")} error={fe("exchangeRate")} align="end" />
          <SelectField label={t("fields.paymentCondition")} value={h.paymentCondition} onChange={(v) => set({ paymentCondition: v })} disabled={readOnly} options={["CASH", "CREDIT"].map((o) => ({ value: o, label: t(`enums.paymentCondition.${o}`) }))} />
          {h.paymentCondition === "CREDIT" && <IntField label={t("fields.creditDays")} value={h.creditDays} onChange={(v) => set({ creditDays: v })} disabled={readOnly} />}
          {reservable && <CheckField className="self-end pb-3" label={t("sales.reservesStock")} hint={t("sales.reservesHint")} checked={h.reservesStock} onChange={(v) => set({ reservesStock: v })} disabled={readOnly} />}
          <TextAreaField className="sm:col-span-2 xl:col-span-4" label={t("fields.notes")} rows={2} value={h.notes} onChange={(v) => set({ notes: v })} disabled={readOnly} />
        </div>
      </Card>

      <Card title={t("common.lines")}>
        <LinesEditor
          columns={columns} lines={lines} onChange={setLines} readOnly={readOnly}
          onProductPick={(i, p) => { suggestPrice(lines[i]._key, p.id); return { taxId: p.taxId ?? "", quantity: "1", discountPct: "0", unitPrice: "" }; }}
          footer={
            <div className="mt-4 flex justify-end">
              <dl className="w-full max-w-sm space-y-1 text-sm">
                {!readOnly && totals ? (
                  <>
                    {live?.unpriced && <p className="text-xs text-warning-600">{t("sales.unpricedNotice")}</p>}
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

      <Actions />

      <ConfirmDialog open={dialog === "confirm"} busy={busy} title={t("purchases.confirmTitle")} message={t(`sales.confirmMessage.${meta.type}`)} confirmLabel={t("common.confirmDocument")} onCancel={() => setDialog(null)} onConfirm={() => action(`${meta.api}/:id/confirm`, t("purchases.confirmedOk"), { save: true })} />
      <ConfirmDialog open={dialog === "send"} busy={busy} title={t("purchases.sendTitle")} message={t("purchases.sendMessage")} confirmLabel={t("purchases.send")} onCancel={() => setDialog(null)} onConfirm={() => action(`${meta.api}/:id/send`, t("purchases.sentOk"), { save: true })} />
      <ConfirmDialog open={dialog === "reject"} busy={busy} danger title={t("purchases.rejectTitle")} confirmLabel={t("purchases.reject")} onCancel={() => setDialog(null)} onConfirm={() => action(`${meta.api}/:id/reject`, t("purchases.rejectedOk"))} />
      <ConfirmDialog open={dialog === "cancel"} busy={busy} danger requireReason title={t("common.cancelTitle")} message={t(`sales.cancelMessage.${meta.type}`)} confirmLabel={t("common.cancelDocument")} onCancel={() => setDialog(null)} onConfirm={(reason) => action(`${meta.api}/:id/cancel`, t("purchases.cancelledOk"), { body: { reason } })} />
      <ConfirmDialog open={dialog === "delete"} busy={busy} danger title={t("common.deleteTitle")} message={t("common.deleteMessage")} confirmLabel={t("common.delete")} onCancel={() => setDialog(null)} onConfirm={removeDraft} />
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
      if (status === "ACCEPTED") {
        if (can("sales:budgets:create")) add("tobud", <Button size="sm" disabled={busy} onClick={() => action(`${meta.api}/:id/convert-to-budget`, t("purchases.convertedOk"), { navigateTo: (d) => ["budgets", d.id] })}>{t("sales.convertToBudget")}</Button>);
        if (can("sales:orders:create")) add("toord", <Button variant="outline" size="sm" disabled={busy} onClick={() => action(`${meta.api}/:id/convert-to-order`, t("purchases.convertedOk"), { navigateTo: (d) => ["orders", d.id] })}>{t("sales.convertToOrder")}</Button>);
      }
      if (["SENT", "ACCEPTED"].includes(status) && can(P("cancel"))) add("cx", <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog("cancel")}>{t("common.cancelDocument")}</Button>);
    } else {
      if (status === "DRAFT" && error?.code === "CREDIT_LIMIT_EXCEEDED" && can("sales:orders:credit-override")) add("ovr", <Button variant="danger" size="sm" disabled={busy} onClick={() => action(`${meta.api}/:id/confirm`, t("purchases.confirmedOk"), { save: true, body: { overrideCredit: true } })}>{t("sales.confirmOverCredit")}</Button>);
      if (status === "DRAFT" && can(P("confirm"))) add("conf", <Button size="sm" disabled={busy} onClick={() => setDialog("confirm")}>{t("common.confirmDocument")}</Button>);
      if (T === "BUDGET" && status === "CONFIRMED" && can("sales:orders:create")) add("toord", <Button size="sm" disabled={busy} onClick={() => action(`${meta.api}/:id/convert-to-order`, t("purchases.convertedOk"), { navigateTo: (d) => ["orders", d.id] })}>{t("sales.convertToOrder")}</Button>);
      if (status === "CONFIRMED" && can(P("cancel"))) add("cx", <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog("cancel")}>{t("common.cancelDocument")}</Button>);
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
