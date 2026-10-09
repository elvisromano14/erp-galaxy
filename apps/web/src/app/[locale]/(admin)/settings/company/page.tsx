"use client";

import { CheckField, TextField } from "@/components/erp/FormFields";
import { Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { ApiError, patch } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Row = Record<string, any>;

export default function CompanySettings() {
  const t = useTranslations();
  const { can, reload } = useAuth();
  const notice = useNotice();
  const company = useFetch<Row>("/companies/current");
  const [f, setF] = useState({ legalName: "", tradeName: "", fiscalAddress: "", isSpecialTaxpayer: false, isVatWithholdingAgent: false, isIgtfCollector: false, lots: false, expiry: false });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("security:companies:update");

  useEffect(() => {
    const c = company.data;
    if (!c) return;
    setF({
      legalName: c.legalName, tradeName: c.tradeName ?? "", fiscalAddress: c.fiscalAddress ?? "", isSpecialTaxpayer: c.isSpecialTaxpayer,
      isVatWithholdingAgent: c.isVatWithholdingAgent, isIgtfCollector: c.isIgtfCollector, lots: !!c.features?.lots, expiry: !!c.features?.expiry,
    });
  }, [company.data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await patch("/companies/current", {
        legalName: f.legalName, tradeName: f.tradeName || null, fiscalAddress: f.fiscalAddress || null,
        isSpecialTaxpayer: f.isSpecialTaxpayer, isVatWithholdingAgent: f.isVatWithholdingAgent, isIgtfCollector: f.isIgtfCollector,
        features: { lots: f.lots, expiry: f.lots && f.expiry },
      });
      notice.success(t("common.saved"));
      company.reload();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    } finally {
      setBusy(false);
    }
  }

  if (company.loading && !company.data) return <Loading />;

  return (
    <div>
      <PageHeader title={t("sidebar.items.company")} />
      <ErrorBox error={company.error ?? error} />
      <form onSubmit={save} noValidate className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title={t("settings.fiscalData")}>
          <div className="grid grid-cols-1 gap-4">
            <TextField label={t("fields.rif")} value={company.data?.rif ?? ""} onChange={() => undefined} disabled />
            <TextField label={t("fields.legalName")} required value={f.legalName} onChange={(v) => setF({ ...f, legalName: v })} disabled={!canEdit} />
            <TextField label={t("fields.tradeName")} value={f.tradeName} onChange={(v) => setF({ ...f, tradeName: v })} disabled={!canEdit} />
            <TextField label={t("fields.fiscalAddress")} value={f.fiscalAddress} onChange={(v) => setF({ ...f, fiscalAddress: v })} disabled={!canEdit} />
            <CheckField label={t("fields.isSpecialTaxpayer")} checked={f.isSpecialTaxpayer} onChange={(v) => setF({ ...f, isSpecialTaxpayer: v })} disabled={!canEdit} />
            <CheckField label={t("fields.isVatWithholdingAgent")} checked={f.isVatWithholdingAgent} onChange={(v) => setF({ ...f, isVatWithholdingAgent: v })} disabled={!canEdit} />
            <CheckField label={t("fields.isIgtfCollector")} checked={f.isIgtfCollector} onChange={(v) => setF({ ...f, isIgtfCollector: v })} disabled={!canEdit} />
            <p className="text-xs text-gray-500">{t("settings.fiscalWarning")}</p>
          </div>
        </Card>
        <Card title={t("settings.features")}>
          <div className="grid grid-cols-1 gap-4">
            <CheckField label={t("settings.lots")} hint={t("settings.lotsHint")} checked={f.lots} onChange={(v) => setF({ ...f, lots: v, expiry: v ? f.expiry : false })} disabled={!canEdit} />
            <CheckField label={t("settings.expiry")} hint={t("settings.expiryHint")} checked={f.expiry} onChange={(v) => setF({ ...f, expiry: v })} disabled={!canEdit || !f.lots} />
            <CheckField label={t("settings.serials")} hint={t("settings.serialsHint")} checked={false} onChange={() => undefined} disabled />
          </div>
        </Card>
        {canEdit && <div className="xl:col-span-2 flex justify-end"><Button type="submit" size="sm" disabled={busy}>{busy ? t("common.saving") : t("common.save")}</Button></div>}
      </form>
    </div>
  );
}
