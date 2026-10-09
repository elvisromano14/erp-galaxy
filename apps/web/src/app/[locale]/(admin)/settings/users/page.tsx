"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { CheckField, TextField } from "@/components/erp/FormFields";
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

export default function UsersPage() {
  const t = useTranslations();
  const { can, me } = useAuth();
  const notice = useNotice();
  const users = useFetch<Row[]>("/users");
  const roles = useFetch<Row[]>(can("security:roles:read") ? "/roles" : null);
  const [editing, setEditing] = useState<Row | "new" | null>(null);

  const columns: Column<Row>[] = [
    { key: "fullName", header: t("fields.fullName") },
    { key: "email", header: t("fields.email") },
    { key: "roles", header: t("settings.roles"), render: (r) => (r.roles as string[]).join(", ") || "—" },
    ...(me?.canCreateCompanies ? [{ key: "isOrgAdmin", header: t("settings.orgAdmin"), render: (r: Row) => <BoolBadge value={r.isOrgAdmin} /> }] : []),
    { key: "isActive", header: t("fields.isActive"), render: (r) => <BoolBadge value={r.isActive} /> },
    { key: "actions", header: "", align: "end", render: (r) => can("security:users:update") && <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => setEditing(r)}>{t("common.edit")}</button> },
  ];

  return (
    <div>
      <PageHeader title={t("sidebar.items.users")} actions={can("security:users:create") && <Button size="sm" startIcon={<PlusIcon />} onClick={() => setEditing("new")}>{t("common.new")}</Button>} />
      <Card>
        <ErrorBox error={users.error} />
        <DataTable columns={columns} rows={users.data} loading={users.loading} rowKey={(r) => r.id} />
      </Card>
      {editing && (
        <UserForm
          canSetOrgAdmin={!!me?.canCreateCompanies}
          row={editing === "new" ? undefined : editing}
          roles={(roles.data ?? []).map((r) => ({ code: r.code as string, name: r.name as string }))}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); users.reload(); notice.success(t("common.saved")); }}
        />
      )}
    </div>
  );
}

function UserForm({ row, roles, canSetOrgAdmin, onClose, onSaved }: { row?: Row; canSetOrgAdmin: boolean; roles: { code: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const [f, setF] = useState({ email: row?.email ?? "", fullName: row?.fullName ?? "", password: "", isActive: row?.isActive ?? true, isOrgAdmin: !!row?.isOrgAdmin, roleCodes: (row?.roles as string[]) ?? ["VENDEDOR"] });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (code: string) => setF((s) => ({ ...s, roleCodes: s.roleCodes.includes(code) ? s.roleCodes.filter((c) => c !== code) : [...s.roleCodes, code] }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (row) await patch(`/users/${row.id}`, { fullName: f.fullName, isActive: f.isActive, roleCodes: f.roleCodes, ...(canSetOrgAdmin ? { isOrgAdmin: f.isOrgAdmin } : {}) });
      else await post("/users", { email: f.email, fullName: f.fullName, ...(f.password ? { password: f.password } : {}), roleCodes: f.roleCodes });
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
        <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{row ? t("settings.editUser") : t("settings.newUser")}</h3>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4">
          <TextField label={t("fields.email")} type="email" required value={f.email} onChange={(v) => setF({ ...f, email: v })} disabled={!!row} />
          <TextField label={t("fields.fullName")} required value={f.fullName} onChange={(v) => setF({ ...f, fullName: v })} />
          {!row && <TextField label={t("fields.password")} required value={f.password} onChange={(v) => setF({ ...f, password: v })} hint={t("settings.passwordHint")} />}
          <div>
            <p className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-400">{t("settings.roles")}</p>
            <div className="grid grid-cols-2 gap-2">
              {roles.map((r) => <CheckField key={r.code} label={r.name} checked={f.roleCodes.includes(r.code)} onChange={() => toggle(r.code)} />)}
            </div>
          </div>
          {row && canSetOrgAdmin && <CheckField label={t("settings.orgAdmin")} hint={t("settings.orgAdminHint")} checked={f.isOrgAdmin} onChange={(v) => setF({ ...f, isOrgAdmin: v })} />}
          {row && <CheckField label={t("fields.isActive")} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || f.roleCodes.length === 0}>{busy ? t("common.saving") : t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
