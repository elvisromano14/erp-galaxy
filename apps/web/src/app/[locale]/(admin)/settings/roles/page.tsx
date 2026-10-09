"use client";

import { CheckField } from "@/components/erp/FormFields";
import { RText } from "@/components/erp/rhf";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { PlusIcon } from "@/icons";
import { ApiError, patch, post } from "@/lib/api";
import { reqText } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type Row = Record<string, any>;

export default function RolesPage() {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const roles = useFetch<Row[]>("/roles");
  const perms = useFetch<Row[]>("/permissions");
  const [editing, setEditing] = useState<Row | "new" | null>(null);

  return (
    <div>
      <PageHeader title={t("sidebar.items.roles")} actions={can("security:roles:create") && <Button size="sm" startIcon={<PlusIcon />} onClick={() => setEditing("new")}>{t("common.new")}</Button>} />
      <ErrorBox error={roles.error} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(roles.data ?? []).map((r) => (
          <Card key={r.id} title={r.name} actions={can("security:roles:update") && r.code !== "ADMIN" && <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => setEditing(r)}>{t("common.edit")}</button>}>
            <p className="mb-2 text-xs uppercase text-gray-400">{r.code}{r.isSystem ? ` · ${t("settings.system")}` : ""}</p>
            <p className="text-sm text-gray-600 dark:text-gray-400">{t("settings.permissionCount", { count: (r.permissions as string[]).length })}</p>
          </Card>
        ))}
      </div>
      {editing && perms.data && (
        <RoleForm
          row={editing === "new" ? undefined : editing}
          all={perms.data.map((p) => p.code as string)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); roles.reload(); notice.success(t("common.saved")); }}
        />
      )}
    </div>
  );
}

const roleSchema = z.object({ code: z.string().trim().min(2, "Mínimo 2 caracteres").max(30), name: reqText() });

function RoleForm({ row, all, onClose, onSaved }: { row?: Row; all: string[]; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const form = useForm<z.infer<typeof roleSchema>>({ resolver: zodResolver(roleSchema) as never, defaultValues: { code: row?.code ?? "", name: row?.name ?? "" } });
  const [selected, setSelected] = useState<Set<string>>(new Set(row?.permissions ?? []));
  const [error, setError] = useState<ApiError | null>(null);
  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const p of all) {
      const key = p.split(":").slice(0, 2).join(":");
      g.set(key, [...(g.get(key) ?? []), p]);
    }
    return [...g.entries()];
  }, [all]);
  const toggle = (p: string) => setSelected((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const toggleGroup = (ps: string[], on: boolean) => setSelected((s) => { const n = new Set(s); ps.forEach((p) => (on ? n.add(p) : n.delete(p))); return n; });

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      if (row) await patch(`/roles/${row.id}`, { name: v.name, permissions: [...selected] });
      else await post("/roles", { code: v.code, name: v.name, permissions: [...selected] });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-4xl p-6">
      <form onSubmit={submit} noValidate>
        <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{row ? t("settings.editRole") : t("settings.newRole")}</h3>
        <ErrorBox error={error} />
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <RText control={form.control} name="code" label={t("fields.code")} required disabled={!!row} />
          <RText control={form.control} name="name" label={t("fields.name")} required />
        </div>
        <div className="max-h-[50vh] space-y-4 overflow-y-auto pe-2">
          {groups.map(([group, ps]) => (
            <fieldset key={group} className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
              <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <button type="button" className="hover:text-brand-500" onClick={() => toggleGroup(ps, !ps.every((p) => selected.has(p)))}>{group}</button>
              </legend>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {ps.map((p) => <CheckField key={p} label={p.split(":")[2]} checked={selected.has(p)} onChange={() => toggle(p)} />)}
              </div>
            </fieldset>
          ))}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? t("common.saving") : t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
