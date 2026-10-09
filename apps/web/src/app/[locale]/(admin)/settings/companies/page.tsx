"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { RCheck, RSelect, RText } from "@/components/erp/rhf";
import { BoolBadge, Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { PlusIcon } from "@/icons";
import { ApiError, patch, post } from "@/lib/api";
import { optEmail, optPassword, optText, reqText, rif as rifValidator } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type Row = Record<string, any>;

/** Empresas que el usuario puede administrar (nunca las de otros clientes): alta, edición y baja lógica. */
export default function CompaniesPage() {
  const t = useTranslations();
  const { me, reload } = useAuth();
  const notice = useNotice();
  const list = useFetch<Row[]>("/companies", { includeInactive: true });
  const orgs = useFetch<Row[]>("/organizations");
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!me?.canCreateCompanies) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;
  const multiOrg = (orgs.data?.length ?? 0) > 1 || me.user.isSuperAdmin;

  async function toggle(c: Row) {
    setBusyId(c.id);
    try {
      await patch(`/companies/${c.id}`, { isActive: !c.isActive });
      notice.success(c.isActive ? t("settings.companyDeactivated") : t("settings.companyActivated"));
      list.reload();
      await reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<Row>[] = [
    { key: "rif", header: t("fields.rif") },
    { key: "legalName", header: t("fields.legalName") },
    ...(multiOrg ? [{ key: "organizationName", header: t("settings.client") }] : []),
    { key: "isActive", header: t("fields.isActive"), render: (r) => <BoolBadge value={r.isActive} /> },
    {
      key: "actions", header: "", align: "end",
      render: (r) => (
        <div className="flex items-center justify-end gap-4">
          <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => setEditing(r)}>{t("common.edit")}</button>
          <button type="button" disabled={busyId === r.id} className="text-sm text-gray-500 hover:underline" onClick={() => toggle(r)}>{r.isActive ? t("settings.deactivate") : t("settings.activate")}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("sidebar.items.companies")}
        subtitle={me.user.isSuperAdmin ? t("settings.companiesSubtitleGlobal") : t("settings.companiesSubtitle")}
        actions={<Button size="sm" startIcon={<PlusIcon />} onClick={() => setEditing("new")}>{t("settings.newCompany")}</Button>}
      />
      <Card>
        <ErrorBox error={list.error} />
        {list.loading && !list.data ? <Loading /> : <DataTable columns={columns} rows={list.data} rowKey={(r) => r.id} />}
      </Card>
      {editing && (
        <CompanyForm
          row={editing === "new" ? undefined : editing}
          orgs={orgs.data ?? []}
          isSuper={me.user.isSuperAdmin}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            notice.success(t("common.saved"));
            list.reload();
            await reload();
          }}
        />
      )}
    </div>
  );
}

const baseShape = {
  legalName: reqText(), tradeName: optText(), fiscalAddress: optText(),
  isSpecialTaxpayer: z.boolean(), isVatWithholdingAgent: z.boolean(), isIgtfCollector: z.boolean(),
};
const createSchema = z.object({
  ...baseShape, organizationId: z.string(), rif: rifValidator,
  adminEmail: optEmail, adminName: optText(), adminPassword: optPassword,
}).superRefine((v, ctx) => {
  if (v.adminEmail && !v.adminName) ctx.addIssue({ code: "custom", path: ["adminName"], message: "Obligatorio si indica un administrador" });
});
const editSchema = z.object(baseShape);

type CreateValues = z.infer<typeof createSchema>;

function CompanyForm({ row, orgs, isSuper, onClose, onSaved }: { row?: Row; orgs: Row[]; isSuper: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const isEdit = !!row;
  const needsOrg = !isEdit && (isSuper || orgs.length > 1);
  const form = useForm<CreateValues>({
    resolver: zodResolver((isEdit ? editSchema : createSchema)) as never,
    defaultValues: {
      organizationId: !isEdit && orgs.length === 1 ? (orgs[0].id as string) : "", rif: "", legalName: row?.legalName ?? "", tradeName: row?.tradeName ?? "", fiscalAddress: row?.fiscalAddress ?? "",
      isSpecialTaxpayer: !!row?.isSpecialTaxpayer, isVatWithholdingAgent: !!row?.isVatWithholdingAgent, isIgtfCollector: row ? !!row.isIgtfCollector : false,
      adminEmail: "", adminName: "", adminPassword: "",
    },
  });
  const [error, setError] = useState<ApiError | null>(null);
  const fe = (n: string) => error?.details.find((d) => d.field === n)?.message ?? null;
  const c = form.control;

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    if (!isEdit && isSuper && !v.organizationId) return form.setError("organizationId", { message: "Seleccione un cliente" });
    if (needsOrg && !v.organizationId) return form.setError("organizationId", { message: "Seleccione un cliente" });
    try {
      const common = {
        legalName: v.legalName, tradeName: v.tradeName || null, fiscalAddress: v.fiscalAddress || null,
        isSpecialTaxpayer: v.isSpecialTaxpayer, isVatWithholdingAgent: v.isVatWithholdingAgent, isIgtfCollector: v.isIgtfCollector,
      };
      if (isEdit) await patch(`/companies/${row!.id}`, common);
      else {
        await post("/companies", {
          ...(v.organizationId ? { organizationId: v.organizationId } : {}), rif: v.rif,
          ...common, tradeName: v.tradeName || undefined, fiscalAddress: v.fiscalAddress || undefined,
          ...(v.adminEmail ? { admin: { email: v.adminEmail, fullName: v.adminName, ...(v.adminPassword ? { password: v.adminPassword } : {}) } } : {}),
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-3xl p-6 lg:p-8">
      <form onSubmit={submit} noValidate role="dialog" aria-modal="true" aria-label={isEdit ? t("settings.editCompany") : t("settings.newCompany")}>
        <h3 className="mb-5 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{isEdit ? t("settings.editCompany") : t("settings.newCompany")}</h3>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {needsOrg && (
            <RSelect className="sm:col-span-2" control={c} name="organizationId" label={t("settings.client")} required serverError={fe("organizationId")}
              options={orgs.map((o) => ({ value: o.id as string, label: o.name as string }))} />
          )}
          {isEdit ? <RText control={c} name="rif" label={t("fields.rif")} disabled /> : <RText control={c} name="rif" label={t("fields.rif")} required placeholder="J-12345678-9" serverError={fe("rif")} />}
          <RText control={c} name="legalName" label={t("fields.legalName")} required serverError={fe("legalName")} />
          <RText control={c} name="tradeName" label={t("fields.tradeName")} />
          <RText control={c} name="fiscalAddress" label={t("fields.fiscalAddress")} />
          <RCheck control={c} name="isSpecialTaxpayer" label={t("fields.isSpecialTaxpayer")} />
          <RCheck control={c} name="isVatWithholdingAgent" label={t("fields.isVatWithholdingAgent")} />
          <RCheck control={c} name="isIgtfCollector" label={t("fields.isIgtfCollector")} />
          {!isEdit && (
            <>
              <p className="mt-2 text-sm font-medium text-gray-700 sm:col-span-2 dark:text-gray-300">{t("settings.firstAdmin")}</p>
              <RText control={c} name="adminEmail" type="email" label={t("fields.email")} hint={t("settings.firstAdminHint")} />
              <RText control={c} name="adminName" label={t("fields.fullName")} />
              <RText control={c} name="adminPassword" label={t("fields.password")} hint={t("settings.passwordHint")} />
            </>
          )}
        </div>
        {!isEdit && <p className="mt-4 text-xs text-gray-500">{t("settings.newCompanyNote")}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? t("common.saving") : t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
