"use client";

import { RCheck, RText } from "@/components/erp/rhf";
import { Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { ApiError, patch } from "@/lib/api";
import { optText, reqText } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type Row = Record<string, any>;

const schema = z.object({
  rif: z.string(), legalName: reqText(), tradeName: optText(), fiscalAddress: optText(),
  isSpecialTaxpayer: z.boolean(), isVatWithholdingAgent: z.boolean(), isIgtfCollector: z.boolean(),
  lots: z.boolean(), expiry: z.boolean(), serials: z.boolean(),
});
type Values = z.infer<typeof schema>;

export default function CompanySettings() {
  const t = useTranslations();
  const { can, reload } = useAuth();
  const notice = useNotice();
  const company = useFetch<Row>("/companies/current");
  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: { rif: "", legalName: "", tradeName: "", fiscalAddress: "", isSpecialTaxpayer: false, isVatWithholdingAgent: false, isIgtfCollector: false, lots: false, expiry: false, serials: false },
  });
  const [error, setError] = useState<ApiError | null>(null);
  const canEdit = can("security:companies:update");
  const lots = form.watch("lots");
  const c = form.control;

  useEffect(() => {
    const x = company.data;
    if (!x) return;
    form.reset({
      rif: x.rif, legalName: x.legalName, tradeName: x.tradeName ?? "", fiscalAddress: x.fiscalAddress ?? "", isSpecialTaxpayer: x.isSpecialTaxpayer,
      isVatWithholdingAgent: x.isVatWithholdingAgent, isIgtfCollector: x.isIgtfCollector, lots: !!x.features?.lots, expiry: !!x.features?.expiry, serials: !!x.features?.serials,
    });
  }, [company.data, form]);

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await patch("/companies/current", {
        legalName: v.legalName, tradeName: v.tradeName || null, fiscalAddress: v.fiscalAddress || null,
        isSpecialTaxpayer: v.isSpecialTaxpayer, isVatWithholdingAgent: v.isVatWithholdingAgent, isIgtfCollector: v.isIgtfCollector,
        features: { lots: v.lots, expiry: v.lots && v.expiry, serials: v.serials },
      });
      notice.success(t("common.saved"));
      company.reload();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });

  if (company.loading && !company.data) return <Loading />;

  return (
    <div>
      <PageHeader title={t("sidebar.items.company")} />
      <ErrorBox error={company.error ?? error} />
      <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title={t("settings.fiscalData")}>
          <div className="grid grid-cols-1 gap-4">
            <RText control={c} name="rif" label={t("fields.rif")} disabled />
            <RText control={c} name="legalName" label={t("fields.legalName")} required disabled={!canEdit} />
            <RText control={c} name="tradeName" label={t("fields.tradeName")} disabled={!canEdit} />
            <RText control={c} name="fiscalAddress" label={t("fields.fiscalAddress")} disabled={!canEdit} />
            <RCheck control={c} name="isSpecialTaxpayer" label={t("fields.isSpecialTaxpayer")} disabled={!canEdit} />
            <RCheck control={c} name="isVatWithholdingAgent" label={t("fields.isVatWithholdingAgent")} disabled={!canEdit} />
            <RCheck control={c} name="isIgtfCollector" label={t("fields.isIgtfCollector")} disabled={!canEdit} />
            <p className="text-xs text-gray-500">{t("settings.fiscalWarning")}</p>
          </div>
        </Card>
        <Card title={t("settings.features")}>
          <div className="grid grid-cols-1 gap-4">
            <RCheck control={c} name="lots" label={t("settings.lots")} hint={t("settings.lotsHint")} disabled={!canEdit} />
            <RCheck control={c} name="expiry" label={t("settings.expiry")} hint={t("settings.expiryHint")} disabled={!canEdit || !lots} />
            <RCheck control={c} name="serials" label={t("settings.serials")} hint={t("settings.serialsHint")} disabled={!canEdit} />
          </div>
        </Card>
        {canEdit && <div className="flex justify-end xl:col-span-2"><Button type="submit" size="sm" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? t("common.saving") : t("common.save")}</Button></div>}
      </form>
    </div>
  );
}
