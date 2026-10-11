"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { RText } from "@/components/erp/rhf";
import { BoolBadge, Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { PlusIcon } from "@/icons";
import { ApiError, patch, post } from "@/lib/api";
import { reqEmail, reqText, strongPassword } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type Row = Record<string, any>;

/** Clientes = administradores de empresa. Solo el administrador global los crea y los asigna a una empresa. */
export default function ClientsPage() {
  const t = useTranslations();
  const { me } = useAuth();
  const notice = useNotice();
  const list = useFetch<Row[]>("/clients");
  const companies = useFetch<Row[]>("/companies");
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!me?.user.isSuperAdmin) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;

  async function toggle(o: Row) {
    setBusyId(o.id);
    try {
      await patch(`/clients/${o.id}`, { isActive: !o.isActive });
      list.reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<Row>[] = [
    { key: "fullName", header: t("fields.fullName") },
    { key: "email", header: t("fields.email") },
    { key: "companies", header: t("settings.clientCompanies"), render: (r) => (r.companies as Row[]).map((c) => c.name).join(", ") || "—" },
    { key: "isActive", header: t("fields.isActive"), render: (r) => <BoolBadge value={r.isActive} /> },
    { key: "actions", header: "", align: "end", render: (r) => (
      <div className="flex items-center justify-end gap-4">
        <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => setEditing(r)}>{t("common.edit")}</button>
        <button type="button" disabled={busyId === r.id} className="text-sm text-gray-500 hover:underline" onClick={() => toggle(r)}>{r.isActive ? t("settings.deactivate") : t("settings.activate")}</button>
      </div>
    ) },
  ];

  return (
    <div>
      <PageHeader title={t("sidebar.items.organizations")} subtitle={t("settings.organizationsSubtitle")} actions={<Button size="sm" startIcon={<PlusIcon />} onClick={() => setEditing("new")}>{t("settings.newClient")}</Button>} />
      <Card>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} />
      </Card>
      {editing && <ClientForm row={editing === "new" ? undefined : editing} companies={(companies.data ?? []).filter((c) => c.isActive)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); notice.success(t("common.saved")); list.reload(); companies.reload(); }} />}
    </div>
  );
}

const createSchema = z.object({ fullName: reqText(), email: reqEmail, password: strongPassword, companyIds: z.array(z.string()).min(1, "Seleccione al menos una empresa") });
const editSchema = z.object({ companyIds: z.array(z.string()).min(1, "Seleccione al menos una empresa") });
type Values = { fullName: string; email: string; password: string; companyIds: string[] };

function ClientForm({ row, companies, onClose, onSaved }: { row?: Row; companies: Row[]; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const isEdit = !!row;
  const form = useForm<Values>({
    resolver: zodResolver((isEdit ? editSchema : createSchema)) as never,
    defaultValues: { fullName: row?.fullName ?? "", email: row?.email ?? "", password: "", companyIds: ((row?.companies as Row[] | undefined) ?? []).map((c) => c.id as string) },
  });
  const [error, setError] = useState<ApiError | null>(null);
  const c = form.control;
  const selected = form.watch("companyIds");
  const toggleCompany = (id: string) => form.setValue("companyIds", selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id], { shouldValidate: true });

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      if (isEdit) await patch(`/clients/${row!.id}/companies`, { companyIds: v.companyIds });
      else await post("/clients", v);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-xl p-6">
      <form onSubmit={submit} noValidate>
        <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{isEdit ? t("settings.editClient") : t("settings.newClient")}</h3>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4">
          <RText control={c} name="fullName" label={t("fields.fullName")} required disabled={isEdit} />
          <RText control={c} name="email" type="email" label={t("fields.email")} required disabled={isEdit} />
          {!isEdit && <RText control={c} name="password" label={t("fields.password")} required hint={t("settings.passwordHint")} />}
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">{t("settings.clientCompanies")} <span className="text-error-500">*</span></legend>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-800">
              {companies.length === 0 && <p className="p-2 text-sm text-gray-500">{t("settings.noCompaniesYet")}</p>}
              {companies.map((x) => (
                <label key={x.id as string} className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-white/5">
                  <input type="checkbox" checked={selected.includes(x.id as string)} onChange={() => toggleCompany(x.id as string)} />
                  <span className="text-gray-800 dark:text-white/90">{(x.tradeName ?? x.legalName) as string}</span>
                  <span className="text-theme-xs text-gray-500">{x.rif as string}</span>
                </label>
              ))}
            </div>
            {form.formState.errors.companyIds && <p className="mt-1 text-xs text-error-500">{form.formState.errors.companyIds.message}</p>}
            <p className="mt-2 text-xs text-gray-500">{t("settings.clientCompaniesHint")}</p>
          </fieldset>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? t("common.saving") : t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
