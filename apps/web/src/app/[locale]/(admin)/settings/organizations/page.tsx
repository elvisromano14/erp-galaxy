"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { RSelect, RText } from "@/components/erp/rhf";
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
  const [creating, setCreating] = useState(false);
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
    { key: "companies", header: t("settings.company"), render: (r) => (r.companies as Row[]).map((c) => c.name).join(", ") || "—" },
    { key: "isActive", header: t("fields.isActive"), render: (r) => <BoolBadge value={r.isActive} /> },
    { key: "actions", header: "", align: "end", render: (r) => <button type="button" disabled={busyId === r.id} className="text-sm text-brand-500 hover:underline" onClick={() => toggle(r)}>{r.isActive ? t("settings.deactivate") : t("settings.activate")}</button> },
  ];

  return (
    <div>
      <PageHeader title={t("sidebar.items.organizations")} subtitle={t("settings.organizationsSubtitle")} actions={<Button size="sm" startIcon={<PlusIcon />} onClick={() => setCreating(true)}>{t("settings.newClient")}</Button>} />
      <Card>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} />
      </Card>
      {creating && <ClientForm companies={(companies.data ?? []).filter((c) => c.isActive)} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); notice.success(t("common.saved")); list.reload(); }} />}
    </div>
  );
}

const schema = z.object({ fullName: reqText(), email: reqEmail, password: strongPassword, companyId: z.string().min(1, "Seleccione una empresa") });

function ClientForm({ companies, onClose, onSaved }: { companies: Row[]; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) as never, defaultValues: { fullName: "", email: "", password: "", companyId: "" } });
  const [error, setError] = useState<ApiError | null>(null);
  const c = form.control;

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await post("/clients", v);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-xl p-6">
      <form onSubmit={submit} noValidate>
        <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("settings.newClient")}</h3>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4">
          <RText control={c} name="fullName" label={t("fields.fullName")} required />
          <RText control={c} name="email" type="email" label={t("fields.email")} required />
          <RText control={c} name="password" label={t("fields.password")} required hint={t("settings.passwordHint")} />
          <RSelect control={c} name="companyId" label={t("settings.company")} required placeholder={t("settings.selectCompany")}
            options={companies.map((x) => ({ value: x.id as string, label: `${x.tradeName ?? x.legalName} (${x.rif})` }))} />
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? t("common.saving") : t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
