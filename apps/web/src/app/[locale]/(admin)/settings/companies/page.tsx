"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { RText } from "@/components/erp/rhf";
import { BoolBadge, Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { PlusIcon } from "@/icons";
import { ApiError, patch, post } from "@/lib/api";
import { optEmail, optText, reqText, rif as rifValidator } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type Row = Record<string, any>;

/** Empresas: solo el administrador global. Cada empresa lleva nombre, RIF, razón social, teléfono y correo. */
export default function CompaniesPage() {
  const t = useTranslations();
  const { me, reload } = useAuth();
  const notice = useNotice();
  const list = useFetch<Row[]>("/companies", { includeInactive: true });
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!me?.user.isSuperAdmin) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;

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
    { key: "fiscalAddress", header: t("fields.fiscalAddress"), render: (r) => r.fiscalAddress ?? "—" },
    { key: "phone", header: t("fields.phone"), render: (r) => r.phone ?? "—" },
    { key: "email", header: t("fields.email"), render: (r) => r.email ?? "—" },
    { key: "adminName", header: t("settings.companyAdmin"), render: (r) => r.adminName ?? "—" },
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
        subtitle={t("settings.companiesSubtitleGlobal")}
        actions={<Button size="sm" startIcon={<PlusIcon />} onClick={() => setEditing("new")}>{t("settings.newCompany")}</Button>}
      />
      <Card>
        <ErrorBox error={list.error} />
        {list.loading && !list.data ? <Loading /> : <DataTable columns={columns} rows={list.data} rowKey={(r) => r.id} />}
      </Card>
      {editing && (
        <CompanyForm
          row={editing === "new" ? undefined : editing}
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

const createSchema = z.object({ legalName: reqText(), rif: rifValidator, fiscalAddress: reqText(), phone: optText(40), email: optEmail, adminName: optText(200) });
const editSchema = createSchema.omit({ rif: true });
type Values = z.infer<typeof createSchema>;

function CompanyForm({ row, onClose, onSaved }: { row?: Row; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const isEdit = !!row;
  const form = useForm<Values>({
    resolver: zodResolver(isEdit ? editSchema : createSchema) as never,
    defaultValues: { legalName: row?.legalName ?? "", rif: row?.rif ?? "", fiscalAddress: row?.fiscalAddress ?? "", phone: row?.phone ?? "", email: row?.email ?? "", adminName: row?.adminName ?? "" },
  });
  const [error, setError] = useState<ApiError | null>(null);
  const fe = (n: string) => error?.details.find((d) => d.field === n)?.message ?? null;
  const c = form.control;

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      if (isEdit) await patch(`/companies/${row!.id}`, { legalName: v.legalName, fiscalAddress: v.fiscalAddress, phone: v.phone || null, email: v.email || null, adminName: v.adminName || null });
      else await post("/companies", { rif: v.rif, legalName: v.legalName, fiscalAddress: v.fiscalAddress, ...(v.phone ? { phone: v.phone } : {}), ...(v.email ? { email: v.email } : {}), ...(v.adminName ? { adminName: v.adminName } : {}) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-2xl p-6 lg:p-8">
      <form onSubmit={submit} noValidate role="dialog" aria-modal="true" aria-label={isEdit ? t("settings.editCompany") : t("settings.newCompany")}>
        <h3 className="mb-5 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{isEdit ? t("settings.editCompany") : t("settings.newCompany")}</h3>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <RText className="sm:col-span-2" control={c} name="legalName" label={t("fields.legalName")} required serverError={fe("legalName")} />
          {isEdit ? <RText control={c} name="rif" label={t("fields.rif")} disabled /> : <RText control={c} name="rif" label={t("fields.rif")} required placeholder="J-12345678-9" serverError={fe("rif")} />}
          <RText control={c} name="fiscalAddress" label={t("fields.fiscalAddress")} required serverError={fe("fiscalAddress")} />
          <RText control={c} name="phone" label={t("fields.phone")} serverError={fe("phone")} />
          <RText control={c} name="email" type="email" label={t("fields.email")} serverError={fe("email")} />
          <RText className="sm:col-span-2" control={c} name="adminName" label={t("settings.companyAdmin")} hint={t("settings.companyAdminHint")} />
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
