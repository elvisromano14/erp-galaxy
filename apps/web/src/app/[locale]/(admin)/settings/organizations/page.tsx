"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { TextField } from "@/components/erp/FormFields";
import { BoolBadge, Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { PlusIcon } from "@/icons";
import { ApiError, patch, post } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

/** Clientes (organizaciones): solo el administrador global. Cada cliente agrupa sus empresas y sus administradores. */
export default function OrganizationsPage() {
  const t = useTranslations();
  const { me } = useAuth();
  const notice = useNotice();
  const list = useFetch<Row[]>("/organizations");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!me?.user.isSuperAdmin) return <p className="py-10 text-center text-sm text-gray-500">{t("common.forbidden")}</p>;

  async function toggle(o: Row) {
    setBusyId(o.id);
    try {
      await patch(`/organizations/${o.id}`, { isActive: !o.isActive });
      list.reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const columns: Column<Row>[] = [
    { key: "name", header: t("fields.name") },
    { key: "companyCount", header: t("settings.companyCount"), align: "end" },
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
      {creating && <OrgForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); notice.success(t("common.saved")); list.reload(); }} />}
    </div>
  );
}

function OrgForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const [f, setF] = useState({ name: "", email: "", fullName: "", password: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/organizations", { name: f.name.trim(), ...(f.email.trim() ? { admin: { email: f.email.trim(), fullName: f.fullName.trim(), ...(f.password ? { password: f.password } : {}) } } : {}) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-xl p-6">
      <form onSubmit={submit} noValidate>
        <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("settings.newClient")}</h3>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4">
          <TextField label={t("settings.clientName")} required value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("settings.clientAdmin")}</p>
          <TextField label={t("fields.email")} type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} hint={t("settings.clientAdminHint")} />
          <TextField label={t("fields.fullName")} value={f.fullName} onChange={(v) => setF({ ...f, fullName: v })} />
          <TextField label={t("fields.password")} value={f.password} onChange={(v) => setF({ ...f, password: v })} hint={t("settings.passwordHint")} />
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || !f.name || (!!f.email && (!f.fullName || !f.password))}>{busy ? t("common.saving") : t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
