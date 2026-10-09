"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { CheckField, SelectField, TextField } from "@/components/erp/FormFields";
import { Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { PlusIcon } from "@/icons";
import { ApiError, post } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

/** Empresas visibles para el usuario (nunca las de otros clientes) y alta de nuevas empresas. */
export default function CompaniesPage() {
  const t = useTranslations();
  const { me, reload } = useAuth();
  const notice = useNotice();
  const list = useFetch<Row[]>("/companies");
  const orgs = useFetch<Row[]>("/organizations");
  const [creating, setCreating] = useState(false);

  if (!me?.canCreateCompanies) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;
  const multiOrg = (orgs.data?.length ?? 0) > 1 || me.user.isSuperAdmin;

  const columns: Column<Row>[] = [
    { key: "rif", header: t("fields.rif") },
    { key: "legalName", header: t("fields.legalName") },
    ...(multiOrg ? [{ key: "organizationName", header: t("settings.client") }] : []),
  ];

  return (
    <div>
      <PageHeader
        title={t("sidebar.items.companies")}
        subtitle={me.user.isSuperAdmin ? t("settings.companiesSubtitleGlobal") : t("settings.companiesSubtitle")}
        actions={<Button size="sm" startIcon={<PlusIcon />} onClick={() => setCreating(true)}>{t("settings.newCompany")}</Button>}
      />
      <Card>
        <ErrorBox error={list.error} />
        {list.loading && !list.data ? <Loading /> : <DataTable columns={columns} rows={list.data} rowKey={(r) => r.id} />}
      </Card>
      {creating && (
        <CompanyForm
          orgs={orgs.data ?? []}
          isSuper={me.user.isSuperAdmin}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            notice.success(t("settings.companyCreated"));
            list.reload();
            await reload();
          }}
        />
      )}
    </div>
  );
}

function CompanyForm({ orgs, isSuper, onClose, onSaved }: { orgs: Row[]; isSuper: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const [f, setF] = useState({
    organizationId: orgs.length === 1 ? (orgs[0].id as string) : "", rif: "", legalName: "", tradeName: "", fiscalAddress: "",
    isSpecialTaxpayer: false, isVatWithholdingAgent: false, isIgtfCollector: false, adminEmail: "", adminName: "", adminPassword: "",
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const fe = (n: string) => error?.details.find((d) => d.field === n)?.message ?? null;
  const needsOrg = isSuper || orgs.length > 1;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/companies", {
        ...(f.organizationId ? { organizationId: f.organizationId } : {}),
        rif: f.rif.trim(), legalName: f.legalName.trim(), ...(f.tradeName.trim() ? { tradeName: f.tradeName.trim() } : {}),
        ...(f.fiscalAddress.trim() ? { fiscalAddress: f.fiscalAddress.trim() } : {}),
        isSpecialTaxpayer: f.isSpecialTaxpayer, isVatWithholdingAgent: f.isVatWithholdingAgent, isIgtfCollector: f.isIgtfCollector,
        ...(f.adminEmail.trim() ? { admin: { email: f.adminEmail.trim(), fullName: f.adminName.trim(), ...(f.adminPassword ? { password: f.adminPassword } : {}) } } : {}),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-3xl p-6 lg:p-8">
      <form onSubmit={submit} noValidate role="dialog" aria-modal="true" aria-label={t("settings.newCompany")}>
        <h3 className="mb-5 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("settings.newCompany")}</h3>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {needsOrg && (
            <SelectField className="sm:col-span-2" label={t("settings.client")} required value={f.organizationId} onChange={(v) => setF({ ...f, organizationId: v })}
              options={orgs.map((o) => ({ value: o.id as string, label: o.name as string }))} error={fe("organizationId")} />
          )}
          <TextField label={t("fields.rif")} required placeholder="J-12345678-9" value={f.rif} onChange={(v) => setF({ ...f, rif: v })} error={fe("rif")} />
          <TextField label={t("fields.legalName")} required value={f.legalName} onChange={(v) => setF({ ...f, legalName: v })} error={fe("legalName")} />
          <TextField label={t("fields.tradeName")} value={f.tradeName} onChange={(v) => setF({ ...f, tradeName: v })} />
          <TextField label={t("fields.fiscalAddress")} value={f.fiscalAddress} onChange={(v) => setF({ ...f, fiscalAddress: v })} />
          <CheckField label={t("fields.isSpecialTaxpayer")} checked={f.isSpecialTaxpayer} onChange={(v) => setF({ ...f, isSpecialTaxpayer: v })} />
          <CheckField label={t("fields.isVatWithholdingAgent")} checked={f.isVatWithholdingAgent} onChange={(v) => setF({ ...f, isVatWithholdingAgent: v })} />
          <CheckField label={t("fields.isIgtfCollector")} checked={f.isIgtfCollector} onChange={(v) => setF({ ...f, isIgtfCollector: v })} />
          <p className="sm:col-span-2 mt-2 text-sm font-medium text-gray-700 dark:text-gray-300">{t("settings.firstAdmin")}</p>
          <TextField label={t("fields.email")} type="email" value={f.adminEmail} onChange={(v) => setF({ ...f, adminEmail: v })} hint={t("settings.firstAdminHint")} />
          <TextField label={t("fields.fullName")} value={f.adminName} onChange={(v) => setF({ ...f, adminName: v })} />
          <TextField label={t("fields.password")} value={f.adminPassword} onChange={(v) => setF({ ...f, adminPassword: v })} hint={t("settings.passwordHint")} />
        </div>
        <p className="mt-4 text-xs text-gray-500">{t("settings.newCompanyNote")}</p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || !f.rif || !f.legalName || (needsOrg && !f.organizationId)}>{busy ? t("common.saving") : t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
