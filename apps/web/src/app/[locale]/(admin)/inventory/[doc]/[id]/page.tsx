"use client";

import ConfirmDialog from "@/components/erp/ConfirmDialog";
import { INV_DOCS, type InvDocMeta } from "@/components/erp/inventory-docs";
import { TextAreaField } from "@/components/erp/FormFields";
import LinesEditor, { isSerialLine, newKey, parseSerials, type Line, type LineCol } from "@/components/erp/LinesEditor";
import { RefSelect } from "@/components/erp/RefSelect";
import { Card, ErrorBox, Loading, PageHeader, StatusBadge } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import { Modal } from "@/components/ui/modal";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { useRouter } from "@/i18n/navigation";
import { ApiError, del, patch, post } from "@/lib/api";
import { fmtDate, fmtDateTime, fmtQty } from "@/lib/format";
import { notFound, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { inventoryDocSchema } from "@/components/erp/doc-schemas";
import { useDocForm } from "@/components/erp/useDocForm";

type Row = Record<string, any>;

export default function InventoryDocPage() {
  const { doc, id } = useParams<{ doc: string; id: string }>();
  const meta = INV_DOCS[doc];
  if (!meta) notFound();
  return <Editor key={`${doc}-${id}`} meta={meta} id={id} />;
}

function Editor({ meta, id }: { meta: InvDocMeta; id: string }) {
  const t = useTranslations();
  const { can, feature } = useAuth();
  const router = useRouter();
  const notice = useNotice();
  const isNew = id === "new";
  const P = (a: string) => `${meta.permission}:${a}`;
  const loaded = useFetch<Row>(isNew ? null : `${meta.api}/${id}`);
  const { h: header, setH: setHeader, lines, setLines, errorOf, lineIssues, check } = useDocForm<{ [k: string]: any }>({ warehouseId: "", toWarehouseId: "", reasonId: "", notes: "" }, inventoryDocSchema(meta.type));
  const [version, setVersion] = useState<number | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "cancel" | "delete" | "confirm">(null);
  const [sheet, setSheet] = useState<Row | null>(null);

  const doc = loaded.data;
  const status: string = doc?.status ?? "DRAFT";
  const readOnly = status !== "DRAFT" || (isNew ? !can(P("create")) : !can(P("update")));

  useEffect(() => {
    if (!doc) return;
    setVersion(doc.version);
    setHeader({ warehouseId: doc.warehouseId, toWarehouseId: doc.toWarehouseId ?? "", reasonId: doc.reasonId ?? "", notes: doc.notes ?? "" });
    setLines(
      (doc.lines as Row[]).map((l) => ({
        _key: l.id, productId: l.productId, productLabel: l.product ? `${l.product.sku} — ${l.product.name}` : l.productId,
        quantity: l.quantity === "0" ? "" : String(l.quantity), unitCost: l.unitCost ?? "", countedQty: l.countedQty ?? "", newAvgCost: l.newAvgCost ?? "",
        lotNo: l.lotNo ?? "", expiryDate: l.expiryDate ? String(l.expiryDate).slice(0, 10) : "", systemQty: l.systemQty, difference: l.difference,
        product: l.product, serialsText: ((l.serials as string[]) ?? []).join("\n"),
      })),
    );
  }, [doc]);

  const lotCols: LineCol[] = feature("lots")
    ? [
        { key: "lotNo", header: t("fields.lotNo"), kind: "text", className: "min-w-28" },
        ...(meta.type === "CHARGE" && feature("expiry") ? [{ key: "expiryDate", header: t("fields.expiryDate"), kind: "date" as const, className: "min-w-36" }] : []),
      ]
    : [];
  const product: LineCol = { key: "product", header: t("fields.product"), kind: "product", className: "min-w-72", placeholder: t("inventory.searchProduct") };
  const serialCol: LineCol[] = feature("serials") && meta.type !== "COST_ADJUSTMENT" ? [{ key: "serialsText", header: t("fields.serials"), kind: "serials", placeholder: t("inventory.serialsPlaceholder"), editable: (l) => isSerialLine(l) }] : [];
  const notSerial = (l: Line) => !isSerialLine(l);
  const columns: LineCol[] =
    meta.type === "TRANSFER" ? [product, ...lotCols.slice(0, 1), ...serialCol, { key: "quantity", header: t("fields.quantity"), kind: "decimal", align: "end", className: "w-32", editable: notSerial }]
    : meta.type === "CHARGE" ? [product, ...lotCols, ...serialCol, { key: "quantity", header: t("fields.quantity"), kind: "decimal", align: "end", className: "w-32", editable: notSerial }, { key: "unitCost", header: t("fields.unitCostVal"), kind: "decimal", align: "end", className: "w-36" }]
    : meta.type === "DISCHARGE" ? [product, ...lotCols.slice(0, 1), ...serialCol, { key: "quantity", header: t("fields.quantity"), kind: "decimal", align: "end", className: "w-32", editable: notSerial }]
    : meta.type === "ADJUSTMENT" ? [product, ...lotCols.slice(0, 1), ...serialCol,
        ...(status === "CONFIRMED" ? [{ key: "systemQty", header: t("inventory.systemQty"), kind: "readonly" as const, align: "end" as const, format: (l: Line) => fmtQty(l.systemQty) }] : []),
        { key: "countedQty", header: t("inventory.countedQty"), kind: "decimal", align: "end", className: "w-36", editable: notSerial },
        ...(status === "CONFIRMED" ? [{ key: "difference", header: t("inventory.difference"), kind: "readonly" as const, align: "end" as const, format: (l: Line) => fmtQty(l.difference) }] : [])]
    : [product, { key: "newAvgCost", header: t("inventory.newAvgCost"), kind: "decimal", align: "end", className: "w-40" }];

  const fe = (field: string) => errorOf(field) ?? error?.details.find((d) => d.field === field)?.message ?? null;

  function body() {
    const c = (s: string) => (s.trim() === "" ? undefined : s.trim());
    return {
      warehouseId: header.warehouseId,
      ...(meta.type === "TRANSFER" ? { toWarehouseId: header.toWarehouseId || null } : {}),
      reasonId: header.reasonId || null,
      notes: header.notes.trim() || null,
      ...(version !== undefined ? { version } : {}),
      lines: lines.filter((l) => l.productId).map((l) => ({
        productId: l.productId, quantity: isSerialLine(l) ? undefined : c(l.quantity ?? ""), unitCost: c(l.unitCost ?? ""), countedQty: isSerialLine(l) ? undefined : c(l.countedQty ?? ""),
        newAvgCost: c(l.newAvgCost ?? ""), lotNo: c(l.lotNo ?? "") ?? null, expiryDate: c(l.expiryDate ?? "") ?? null,
        ...(isSerialLine(l) ? { serials: parseSerials(l.serialsText) } : {}),
      })),
    };
  }

  async function save(): Promise<string | null> {
    if (!(await check())) return null;
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const r = await post<Row>(meta.api, body());
        notice.success(t("common.saved"));
        router.replace(`/inventory/${meta.slug}/${r.data.id}`);
        return r.data.id;
      }
      await patch(`${meta.api}/${id}`, body());
      notice.success(t("common.saved"));
      loaded.reload();
      return id;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function act(kind: "confirm" | "cancel" | "delete", reason?: string) {
    setBusy(true);
    setError(null);
    try {
      let target = id;
      if (kind === "confirm" && !readOnly) {
        if (!(await check())) { setBusy(false); setDialog(null); return; }
        const saved = await (async () => {
          try {
            if (isNew) return (await post<Row>(meta.api, body())).data.id as string;
            await patch(`${meta.api}/${id}`, body());
            return id;
          } catch (e) {
            throw e;
          }
        })();
        target = saved;
      }
      if (kind === "confirm") await post(`${meta.api}/${target}/confirm`);
      if (kind === "cancel") await post(`${meta.api}/${id}/cancel`, { reason });
      if (kind === "delete") {
        await del(`${meta.api}/${id}`);
        notice.success(t("common.deleted"));
        router.replace(`/inventory/${meta.slug}`);
        return;
      }
      notice.success(kind === "confirm" ? t("inventory.confirmed") : t("inventory.cancelled"));
      setDialog(null);
      if (isNew) router.replace(`/inventory/${meta.slug}/${target}`);
      else loaded.reload();
    } catch (e) {
      setDialog(null);
      setError(e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e)));
      if (isNew) loaded.reload();
    } finally {
      setBusy(false);
    }
  }

  async function openSheet() {
    try {
      const { api } = await import("@/lib/api");
      setSheet((await api<Row>(`${meta.api}/${id}/count-sheet`)).data);
    } catch (e) {
      notice.error((e as Error).message);
    }
  }

  if (!isNew && loaded.loading && !doc) return <Loading />;

  return (
    <div>
      <PageHeader
        title={isNew ? t("inventory.newDoc", { type: t(`docTypes.${meta.type}`) }) : `${t(`docTypes.${meta.type}`)} ${doc?.number ?? t("common.draft")}`}
        subtitle={doc ? `${fmtDate(doc.docDate)}${doc.confirmedAt ? ` · ${t("common.confirmedAt")} ${fmtDateTime(doc.confirmedAt)}` : ""}` : undefined}
        actions={
          <>
            {doc && <StatusBadge status={status} />}
            <Button variant="outline" size="sm" onClick={() => router.push(`/inventory/${meta.slug}`)}>{t("common.back")}</Button>
            {!isNew && meta.type === "ADJUSTMENT" && <Button variant="outline" size="sm" onClick={openSheet}>{t("inventory.countSheet")}</Button>}
          </>
        }
      />
      <ErrorBox error={loaded.error ?? error} />
      {doc?.status === "CANCELLED" && doc.cancelReason && (
        <p className="mb-4 rounded-lg bg-error-50 p-3 text-sm text-error-700 dark:bg-error-500/15 dark:text-error-500">{t("common.cancelReason")}: {doc.cancelReason}</p>
      )}

      <Card title={t("common.header")} className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <RefSelect label={meta.type === "TRANSFER" ? t("fields.fromWarehouse") : t("fields.warehouse")} required resource="/warehouses" labelKey={(r) => `${r.code} — ${r.name}`} value={header.warehouseId} onChange={(v) => setHeader({ ...header, warehouseId: v })} disabled={readOnly} error={fe("warehouseId")} />
          {meta.type === "TRANSFER" && (
            <RefSelect label={t("fields.toWarehouse")} required resource="/warehouses" labelKey={(r) => `${r.code} — ${r.name}`} value={header.toWarehouseId} onChange={(v) => setHeader({ ...header, toWarehouseId: v })} disabled={readOnly} error={fe("toWarehouseId")} />
          )}
          {meta.reasonKind && (
            <RefSelect label={t("fields.reason")} resource="/movement-reasons" filter={{ kind: meta.reasonKind }} labelKey={(r) => r.name} value={header.reasonId} onChange={(v) => setHeader({ ...header, reasonId: v })} disabled={readOnly} />
          )}
          <TextAreaField className="sm:col-span-3" label={t("fields.notes")} rows={2} value={header.notes} onChange={(v) => setHeader({ ...header, notes: v })} disabled={readOnly} />
        </div>
      </Card>

      {lineIssues().length > 0 && <p className="mb-3 rounded-lg bg-error-50 p-3 text-sm text-error-700 dark:bg-error-500/15 dark:text-error-500">{lineIssues().join(" · ")}</p>}
      <Card title={t("common.lines")}>
        <LinesEditor columns={columns} lines={lines} onChange={setLines} readOnly={readOnly} onProductPick={() => ({ serialsText: "", quantity: "" })} />
        {meta.type === "COST_ADJUSTMENT" && !readOnly && <p className="mt-3 text-xs text-gray-500">{t("inventory.costAdjHint")}</p>}
      </Card>

      <div className="mt-6 flex flex-wrap justify-end gap-3">
        {status === "DRAFT" && !isNew && can(P("update")) && <Button variant="danger" size="sm" disabled={busy} onClick={() => setDialog("delete")}>{t("common.delete")}</Button>}
        {status !== "CANCELLED" && !isNew && can(P("cancel")) && !(status === "CONFIRMED" && meta.type === "COST_ADJUSTMENT") && status !== "DRAFT" && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog("cancel")}>{t("common.cancelDocument")}</Button>
        )}
        {!readOnly && <Button variant="outline" size="sm" disabled={busy} onClick={save}>{t("common.saveDraft")}</Button>}
        {status === "DRAFT" && can(P("confirm")) && <Button size="sm" disabled={busy} onClick={() => setDialog("confirm")}>{t("common.confirmDocument")}</Button>}
      </div>

      <ConfirmDialog open={dialog === "confirm"} busy={busy} title={t("inventory.confirmTitle")} message={t("inventory.confirmMessage")} confirmLabel={t("common.confirmDocument")} onCancel={() => setDialog(null)} onConfirm={() => act("confirm")} />
      <ConfirmDialog open={dialog === "cancel"} busy={busy} danger requireReason title={t("common.cancelTitle")} message={t("inventory.cancelMessage")} confirmLabel={t("common.cancelDocument")} onCancel={() => setDialog(null)} onConfirm={(reason) => act("cancel", reason)} />
      <ConfirmDialog open={dialog === "delete"} busy={busy} danger title={t("common.deleteTitle")} message={t("common.deleteMessage")} confirmLabel={t("common.delete")} onCancel={() => setDialog(null)} onConfirm={() => act("delete")} />

      {sheet && (
        <Modal isOpen onClose={() => setSheet(null)} className="m-4 max-w-4xl p-6">
          <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("inventory.countSheet")}</h3>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-200 text-start text-gray-500 dark:border-gray-700"><th className="py-2 text-start">#</th><th className="text-start">{t("fields.sku")}</th><th className="text-start">{t("fields.name")}</th><th className="text-end">{t("inventory.systemQty")}</th><th className="text-end">{t("inventory.countedQty")}</th></tr></thead>
            <tbody>
              {(sheet.lines as Row[]).map((l) => (
                <tr key={l.lineNo} className="border-b border-gray-100 dark:border-gray-800"><td className="py-2">{l.lineNo}</td><td>{l.sku}</td><td>{l.name}</td><td className="text-end tabular-nums">{fmtQty(l.systemQty)}</td><td className="text-end">{l.countedQty ? fmtQty(l.countedQty) : "________"}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 flex justify-end"><Button size="sm" variant="outline" onClick={() => window.print()}>{t("common.print")}</Button></div>
        </Modal>
      )}
    </div>
  );
}
