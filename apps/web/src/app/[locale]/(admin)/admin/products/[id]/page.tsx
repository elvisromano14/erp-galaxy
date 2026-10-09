"use client";

import ConfirmDialog from "@/components/erp/ConfirmDialog";
import { DecimalField, SelectField, TextField } from "@/components/erp/FormFields";
import { RCheck, RDecimal, RRef, RSelect, RText, RTextArea } from "@/components/erp/rhf";
import { useOptions } from "@/components/erp/RefSelect";
import { Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { useRouter } from "@/i18n/navigation";
import { ApiError, del, patch, post } from "@/lib/api";
import { fmtDate, fmtNumber, fmtQty } from "@/lib/format";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { optDecimal, optText, reqSelect, reqText } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type Row = Record<string, any>;

const productSchema = z.object({
  sku: reqText(60), name: reqText(250), description: optText(2000), categoryId: z.string(), unitId: reqSelect, taxId: z.string(),
  trackingMode: z.string(), hasExpiry: z.boolean(), isService: z.boolean(), minStock: optDecimal, maxStock: optDecimal, isActive: z.boolean(),
  barcodes: z.array(z.string()), references: z.array(z.object({ refType: z.string(), code: z.string(), brand: z.string() })),
});
type Form = z.infer<typeof productSchema>;

const empty: Form = {
  sku: "", name: "", description: "", categoryId: "", unitId: "", taxId: "", trackingMode: "NONE", hasExpiry: false, isService: false,
  minStock: "0", maxStock: "0", isActive: true, barcodes: [], references: [],
};

export default function ProductEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";
  const t = useTranslations();
  const { can, feature } = useAuth();
  const router = useRouter();
  const notice = useNotice();
  const product = useFetch<Row>(isNew ? null : `/products/${id}`);
  const form = useForm<Form>({ resolver: zodResolver(productSchema), defaultValues: empty });
  const [version, setVersion] = useState<number | undefined>();
  const [error, setError] = useState<ApiError | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canEdit = isNew ? can("admin:products:create") : can("admin:products:update");
  const c = form.control;
  const v = form.watch();

  useEffect(() => {
    const p = product.data;
    if (!p) return;
    setVersion(p.version);
    form.reset({
      sku: p.sku, name: p.name, description: p.description ?? "", categoryId: p.categoryId ?? "", unitId: p.unitId, taxId: p.taxId ?? "",
      trackingMode: p.trackingMode, hasExpiry: p.hasExpiry, isService: p.isService, minStock: String(p.minStock), maxStock: String(p.maxStock), isActive: p.isActive,
      barcodes: p.barcodes ?? [], references: (p.references ?? []).map((r: Row) => ({ refType: r.refType, code: r.code, brand: r.brand ?? "" })),
    });
  }, [product.data, form]);

  const fe = (name: string) => error?.details.find((d) => d.field === name)?.message ?? (error?.details.some((d) => d.field === name) ? error.message : null);

  const save = form.handleSubmit(async (f) => {
    setError(null);
    const body: Record<string, unknown> = {
      sku: f.sku.trim(), name: f.name.trim(), description: f.description.trim() || null,
      categoryId: f.categoryId || null, unitId: f.unitId, taxId: f.taxId || null,
      trackingMode: f.trackingMode, hasExpiry: f.hasExpiry, isService: f.isService,
      minStock: f.minStock || "0", maxStock: f.maxStock || "0", isActive: f.isActive,
      barcodes: f.barcodes.map((b) => b.trim()).filter(Boolean),
      references: f.references.filter((r) => r.code.trim()).map((r) => ({ refType: r.refType, code: r.code.trim(), brand: r.brand.trim() || null })),
    };
    try {
      if (isNew) {
        const r = await post<Row>("/products", body);
        notice.success(t("common.saved"));
        router.replace(`/admin/products/${r.data.id}`);
      } else {
        await patch(`/products/${id}`, { ...body, version });
        notice.success(t("common.saved"));
        product.reload();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });
  const busy = form.formState.isSubmitting;

  async function remove() {
    try {
      await del(`/products/${id}`);
      notice.success(t("common.deleted"));
      router.replace("/admin/products");
    } catch (err) {
      notice.error((err as Error).message);
      setConfirmDelete(false);
    }
  }

  if (!isNew && product.loading && !product.data) return <Loading />;

  const trackingOptions = ["NONE", ...(feature("lots") ? ["LOT"] : []), ...(feature("serials") ? ["SERIAL"] : [])];

  return (
    <div>
      <PageHeader
        title={isNew ? t("products.new") : `${v.sku} — ${v.name}`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => router.push("/admin/products")}>{t("common.back")}</Button>
            {!isNew && can("admin:products:delete") && <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>{t("common.delete")}</Button>}
          </>
        }
      />
      <ErrorBox error={product.error ?? error} />
      <form onSubmit={save} noValidate className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title={t("products.general")} className="xl:col-span-2">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <RText control={c} name="sku" label={t("fields.sku")} required disabled={!canEdit} serverError={fe("sku")} />
            <RText control={c} name="name" label={t("fields.name")} required disabled={!canEdit} serverError={fe("name")} />
            <RTextArea control={c} name="description" label={t("fields.description")} className="sm:col-span-2" disabled={!canEdit} />
            <RRef control={c} name="categoryId" label={t("fields.categoryId")} resource="/categories" labelKey={(r) => `${r.code} — ${r.name}`} disabled={!canEdit} serverError={fe("categoryId")} />
            <RRef control={c} name="unitId" label={t("fields.unitId")} required resource="/units" labelKey={(r) => `${r.code} — ${r.name}`} disabled={!canEdit} serverError={fe("unitId")} />
            <RRef control={c} name="taxId" label={t("fields.taxId")} resource="/taxes" labelKey={(r) => `${r.name} (${fmtNumber(r.rate)}%)`} disabled={!canEdit} serverError={fe("taxId")} />
            <RDecimal control={c} name="minStock" label={t("fields.minStock")} disabled={!canEdit} />
            <RDecimal control={c} name="maxStock" label={t("fields.maxStock")} disabled={!canEdit} />
            {(feature("lots") || feature("serials")) && (
              <RSelect control={c} name="trackingMode" label={t("fields.trackingMode")} disabled={!canEdit || v.isService} serverError={fe("trackingMode")} hint={t("products.trackingHint")}
                options={trackingOptions.map((o) => ({ value: o, label: t(`enums.trackingMode.${o}`) }))} />
            )}
            {feature("expiry") && <RCheck control={c} name="hasExpiry" label={t("fields.hasExpiry")} disabled={!canEdit || v.trackingMode !== "LOT"} />}
            <RCheck control={c} name="isService" label={t("fields.isService")} disabled={!canEdit} />
            <RCheck control={c} name="isActive" label={t("fields.isActive")} disabled={!canEdit} />
          </div>
        </Card>

        <div className="flex flex-col gap-6">
          <Card title={t("products.barcodes")}>
            <StringList values={v.barcodes} onChange={(x) => form.setValue("barcodes", x, { shouldDirty: true })} disabled={!canEdit} placeholder={t("products.barcodePlaceholder")} addLabel={t("common.add")} />
          </Card>
          <Card title={t("products.references")}>
            <ReferenceList values={v.references} onChange={(x) => form.setValue("references", x, { shouldDirty: true })} disabled={!canEdit} />
          </Card>
        </div>

        {canEdit && (
          <div className="xl:col-span-3 flex justify-end">
            <Button type="submit" size="sm" disabled={busy}>{busy ? t("common.saving") : t("common.save")}</Button>
          </div>
        )}
      </form>

      {!isNew && product.data && (
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
          <PricesPanel productId={id} prices={product.data.prices ?? []} canEdit={can("admin:products:update")} onChanged={product.reload} />
          {can("inventory:stock:read") && <StockPanel productId={id} />}
        </div>
      )}

      <ConfirmDialog open={confirmDelete} danger title={t("common.deleteTitle")} message={t("common.deleteMessage")} confirmLabel={t("common.delete")} onCancel={() => setConfirmDelete(false)} onConfirm={remove} />
    </div>
  );
}

function StringList({ values, onChange, disabled, placeholder, addLabel }: { values: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder: string; addLabel: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-2">
        {values.map((v) => (
          <li key={v} className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700 dark:bg-white/5 dark:text-gray-300">
            {v}
            {!disabled && <button type="button" aria-label="×" className="text-gray-400 hover:text-error-500" onClick={() => onChange(values.filter((x) => x !== v))}>×</button>}
          </li>
        ))}
      </ul>
      {!disabled && (
        <div className="flex gap-2">
          <input
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
            className="h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90"
          />
          <Button variant="outline" size="sm" onClick={add}>{addLabel}</Button>
        </div>
      )}
    </div>
  );
}

function ReferenceList({ values, onChange, disabled }: { values: Form["references"]; onChange: (v: Form["references"]) => void; disabled?: boolean }) {
  const t = useTranslations();
  const upd = (i: number, patchObj: Partial<Form["references"][number]>) => onChange(values.map((r, idx) => (idx === i ? { ...r, ...patchObj } : r)));
  return (
    <div className="space-y-3">
      {values.map((r, i) => (
        <div key={i} className="grid grid-cols-[110px_1fr_1fr_auto] items-end gap-2">
          <SelectField label={t("products.refType")} value={r.refType} disabled={disabled} onChange={(v) => upd(i, { refType: v })} options={["OEM", "EQUIVALENT", "ALTERNATE"].map((o) => ({ value: o, label: t(`enums.refType.${o}`) }))} />
          <TextField label={t("products.refCode")} value={r.code} disabled={disabled} onChange={(v) => upd(i, { code: v })} />
          <TextField label={t("products.refBrand")} value={r.brand} disabled={disabled} onChange={(v) => upd(i, { brand: v })} />
          {!disabled && <button type="button" aria-label={t("common.delete")} className="mb-2 text-gray-400 hover:text-error-500" onClick={() => onChange(values.filter((_, idx) => idx !== i))}>×</button>}
        </div>
      ))}
      {!disabled && (
        <Button variant="outline" size="sm" onClick={() => onChange([...values, { refType: "OEM", code: "", brand: "" }])}>
          {t("common.add")}
        </Button>
      )}
    </div>
  );
}

function PricesPanel({ productId, prices, canEdit, onChanged }: { productId: string; prices: Row[]; canEdit: boolean; onChanged: () => void }) {
  const t = useTranslations();
  const notice = useNotice();
  const lists = useOptions("/price-lists", (r) => `${r.code} — ${r.name}`);
  const history = useFetch<Row[]>(`/products/${productId}/price-history`);
  const [listId, setListId] = useState("");
  const [price, setPrice] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const listName = (id: string) => lists.options.find((o) => o.value === id)?.label ?? id;

  async function add() {
    setBusy(true);
    try {
      await post(`/products/${productId}/prices`, { priceListId: listId, price, ...(from ? { validFrom: from } : {}) });
      notice.success(t("products.priceSaved"));
      setPrice("");
      setFrom("");
      onChanged();
      history.reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("products.prices")}>
      <ul className="mb-4 divide-y divide-gray-100 text-sm dark:divide-gray-800">
        {prices.map((p) => (
          <li key={p.id} className="flex justify-between py-2">
            <span className="text-gray-600 dark:text-gray-400">{listName(p.priceListId)}</span>
            <span className="font-medium text-gray-800 tabular-nums dark:text-white/90">{fmtNumber(p.price, 2, 4)}</span>
          </li>
        ))}
        {prices.length === 0 && <li className="py-2 text-gray-500">{t("products.noPrices")}</li>}
      </ul>
      {canEdit && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <SelectField className="sm:col-span-2" label={t("fields.priceListId")} value={listId} onChange={setListId} options={lists.options} />
          <DecimalField label={t("fields.price")} value={price} onChange={setPrice} align="end" />
          <TextField label={t("fields.validFrom")} type="date" value={from} onChange={setFrom} />
          <div className="sm:col-span-4 flex justify-end">
            <Button size="sm" variant="outline" disabled={busy || !listId || !price} onClick={add}>{t("products.addPrice")}</Button>
          </div>
        </div>
      )}
      {(history.data?.length ?? 0) > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-gray-500">{t("products.priceHistory")}</summary>
          <ul className="mt-2 space-y-1">
            {history.data!.map((h) => (
              <li key={h.id} className="flex justify-between text-gray-600 dark:text-gray-400">
                <span>{fmtDate(h.validFrom)} · {listName(h.priceListId)}</span>
                <span className="tabular-nums">{fmtNumber(h.price, 2, 4)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function StockPanel({ productId }: { productId: string }) {
  const t = useTranslations();
  const s = useFetch<Row>(`/products/${productId}/stock`);
  return (
    <Card title={t("products.stock")}>
      {s.data && (
        <>
          <dl className="mb-3 grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-gray-500">{t("products.totalQty")}</dt><dd className="text-lg font-semibold tabular-nums text-gray-800 dark:text-white/90">{fmtQty(s.data.totalQuantity)}</dd></div>
            <div><dt className="text-gray-500">{t("fields.avgCost")}</dt><dd className="text-lg font-semibold tabular-nums text-gray-800 dark:text-white/90">{fmtNumber(s.data.avgCost, 2, 6)}</dd></div>
          </dl>
          <ul className="divide-y divide-gray-100 text-sm dark:divide-gray-800">
            {(s.data.warehouses as Row[]).map((w) => (
              <li key={w.warehouseId} className="flex justify-between py-2">
                <span className="text-gray-600 dark:text-gray-400">{w.code}</span>
                <span className="tabular-nums text-gray-800 dark:text-white/90">{fmtQty(w.quantity)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
