"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { CheckField } from "@/components/erp/FormFields";
import { RCheck, RText } from "@/components/erp/rhf";
import { BoolBadge, Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { PlusIcon } from "@/icons";
import { ApiError, patch, post } from "@/lib/api";
import { optPassword, reqEmail, reqText } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

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

const userSchema = z.object({
  email: reqEmail, fullName: reqText(), password: optPassword, isActive: z.boolean(), isOrgAdmin: z.boolean(),
  roleCodes: z.array(z.string()).min(1, "Seleccione al menos un rol"),
});

function UserForm({ row, roles, canSetOrgAdmin, onClose, onSaved }: { row?: Row; canSetOrgAdmin: boolean; roles: { code: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const form = useForm<z.infer<typeof userSchema>>({
    resolver: zodResolver(userSchema) as never,
    defaultValues: { email: row?.email ?? "", fullName: row?.fullName ?? "", password: "", isActive: row?.isActive ?? true, isOrgAdmin: !!row?.isOrgAdmin, roleCodes: (row?.roles as string[]) ?? ["VENDEDOR"] },
  });
  const [error, setError] = useState<ApiError | null>(null);
  const roleCodes = form.watch("roleCodes");
  const toggle = (code: string) => form.setValue("roleCodes", roleCodes.includes(code) ? roleCodes.filter((c) => c !== code) : [...roleCodes, code], { shouldValidate: true });
  const c = form.control;

  const submit = form.handleSubmit(async (f) => {
    setError(null);
    try {
      if (row) await patch(`/users/${row.id}`, { fullName: f.fullName, isActive: f.isActive, roleCodes: f.roleCodes, ...(canSetOrgAdmin ? { isOrgAdmin: f.isOrgAdmin } : {}) });
      else await post("/users", { email: f.email, fullName: f.fullName, ...(f.password ? { password: f.password } : {}), roleCodes: f.roleCodes });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-xl p-6">
      <form onSubmit={submit} noValidate>
        <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{row ? t("settings.editUser") : t("settings.newUser")}</h3>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4">
          <RText control={c} name="email" type="email" label={t("fields.email")} required disabled={!!row} />
          <RText control={c} name="fullName" label={t("fields.fullName")} required />
          {!row && <RText control={c} name="password" label={t("fields.password")} hint={t("settings.passwordHint")} />}
          <div>
            <p className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-400">{t("settings.roles")}</p>
            <div className="grid grid-cols-2 gap-2">
              {roles.map((r) => <CheckField key={r.code} label={r.name} checked={roleCodes.includes(r.code)} onChange={() => toggle(r.code)} />)}
            </div>
            {form.formState.errors.roleCodes && <p role="alert" className="mt-1.5 text-xs text-error-500">{form.formState.errors.roleCodes.message}</p>}
          </div>
          {row && canSetOrgAdmin && <RCheck control={c} name="isOrgAdmin" label={t("settings.orgAdmin")} hint={t("settings.orgAdminHint")} />}
          {row && <RCheck control={c} name="isActive" label={t("fields.isActive")} />}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? t("common.saving") : t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
