"use client";

import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { PencilIcon, PlusIcon, TrashBinIcon } from "@/icons";
import { ApiError, del, patch, post } from "@/lib/api";
import { fmtDate, fmtNumber } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";
import ConfirmDialog from "./ConfirmDialog";
import type { ColumnDef, CrudDef, FieldDef } from "./crud-types";
import DataTable, { type Column } from "./DataTable";
import { CheckField, DecimalField, IntField, SelectField, TextAreaField, TextField } from "./FormFields";
import { RefSelect } from "./RefSelect";
import { BoolBadge, Card, ErrorBox, PageHeader } from "./ui";
import { useFetch } from "./useFetch";

type Row = Record<string, any>;
type Values = Record<string, string | boolean>;

function initialValues(fields: FieldDef[], row?: Row): Values {
  const v: Values = {};
  for (const f of fields) {
    const raw = row?.[f.name];
    if (f.type === "boolean") v[f.name] = row ? !!raw : f.default ?? false;
    else if (f.type === "date") v[f.name] = raw ? String(raw).slice(0, 10) : "";
    else if (f.type === "int" || f.type === "decimal") v[f.name] = raw !== undefined && raw !== null ? String(raw) : f.default ?? "";
    else if (f.type === "select") v[f.name] = raw ?? f.default ?? "";
    else v[f.name] = raw ?? "";
  }
  return v;
}

/** Convierte los valores del formulario al cuerpo que espera la API (vacío → omitido o null según `nullable`). */
function toPayload(fields: FieldDef[], v: Values, isCreate: boolean, immutable: string[] = []) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!isCreate && immutable.includes(f.name)) continue;
    const val = v[f.name];
    if (f.type === "boolean") {
      out[f.name] = !!val;
      continue;
    }
    const s = String(val ?? "").trim();
    if (s === "") {
      if ("nullable" in f && f.nullable && !isCreate) out[f.name] = null;
      continue;
    }
    out[f.name] = f.type === "int" ? Number(s) : s;
  }
  return out;
}

export default function CrudPage({ def }: { def: CrudDef }) {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(def.defaultSort ?? "");
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [toDelete, setToDelete] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useFetch<Row[]>(`/${def.resource}`, { page, limit: 20, search: search || undefined, sort: sort || undefined, includeDeleted: showDeleted || undefined });
  const P = (a: string) => `${def.permission}:${a}`;

  const columns: Column<Row>[] = [
    ...def.columns.map((c): Column<Row> => ({
      key: c.key,
      header: t(`fields.${c.key}`),
      sort: c.sort ? c.key : undefined,
      align: c.align ?? (c.type === "decimal" || c.type === "int" ? "end" : undefined),
      render: (r) => renderCell(c, r, t),
    })),
    {
      key: "actions",
      header: "",
      align: "end",
      render: (r) =>
        r.deletedAt ? (
          can(P("update")) && (
            <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => restore(r)}>
              {t("common.restore")}
            </button>
          )
        ) : (
          <div className="flex items-center justify-end gap-3">
            {can(P("update")) && (
              <button type="button" aria-label={t("common.edit")} title={t("common.edit")} className="text-gray-500 hover:text-brand-500" onClick={() => setEditing(r)}>
                <PencilIcon />
              </button>
            )}
            {can(P("delete")) && (
              <button type="button" aria-label={t("common.delete")} title={t("common.delete")} className="text-gray-500 hover:text-error-500" onClick={() => setToDelete(r)}>
                <TrashBinIcon />
              </button>
            )}
          </div>
        ),
    },
  ];

  async function restore(r: Row) {
    try {
      await post(`/${def.resource}/${r.id}/restore`);
      notice.success(t("common.restored"));
      list.reload();
    } catch (e) {
      notice.error((e as Error).message);
    }
  }

  async function remove() {
    if (!toDelete) return;
    setBusy(true);
    try {
      await del(`/${def.resource}/${toDelete.id}`);
      notice.success(t("common.deleted"));
      setToDelete(null);
      list.reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t(`sidebar.items.${def.resource}`)}
        actions={
          can(P("create")) && (
            <Button size="sm" startIcon={<PlusIcon />} onClick={() => setEditing("new")}>
              {t("common.new")}
            </Button>
          )
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => (setSearch(e.target.value), setPage(1))}
            placeholder={t("common.search")}
            aria-label={t("common.search")}
            className="h-11 w-full max-w-sm rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90"
          />
          {def.softDelete && (
            <CheckField label={t("common.showDeleted")} checked={showDeleted} onChange={(v) => (setShowDeleted(v), setPage(1))} />
          )}
        </div>
        <ErrorBox error={list.error} />
        <DataTable
          columns={columns}
          rows={list.data}
          loading={list.loading}
          rowKey={(r) => r.id}
          meta={list.meta}
          onPage={setPage}
          sort={sort}
          onSort={setSort}
        />
      </Card>

      {editing && (
        <CrudForm
          def={def}
          row={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={!!toDelete}
        danger
        busy={busy}
        title={t("common.deleteTitle")}
        message={t("common.deleteMessage")}
        confirmLabel={t("common.delete")}
        onCancel={() => setToDelete(null)}
        onConfirm={remove}
      />
    </div>
  );
}

function renderCell(c: ColumnDef, r: Row, t: ReturnType<typeof useTranslations>): React.ReactNode {
  const v = r[c.key];
  switch (c.type) {
    case "bool": return <BoolBadge value={v} />;
    case "enum": return v ? t(`enums.${c.key}.${v}`) : "—";
    case "decimal": return fmtNumber(v, 0, 4);
    case "int": return v ?? "—";
    case "date": return fmtDate(v);
    default: return v === null || v === undefined || v === "" ? "—" : String(v);
  }
}

function CrudForm({ def, row, onClose, onSaved }: { def: CrudDef; row?: Row; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const notice = useNotice();
  const isCreate = !row;
  const [values, setValues] = useState<Values>(() => initialValues(def.fields, row));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = (name: string, v: string | boolean) => setValues((s) => ({ ...s, [name]: v }));

  const fieldError = (name: string) => error?.details.find((d) => d.field === name || d.field?.startsWith(`${name}.`))?.message
    ?? (error?.details.find((d) => d.field === name) ? error.message : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = toPayload(def.fields, values, isCreate, def.immutableOnEdit);
      if (isCreate) await post(`/${def.resource}`, body);
      else await patch(`/${def.resource}/${row!.id}`, body);
      notice.success(t("common.saved"));
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-3xl p-6 lg:p-8">
      <form onSubmit={submit} noValidate role="dialog" aria-modal="true" aria-label={t(`sidebar.items.${def.resource}`)}>
        <h3 className="mb-5 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">
          {isCreate ? t("common.newRecord") : t("common.editRecord")}
        </h3>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {def.fields.map((f) => {
            const label = t(`fields.${f.name}`);
            const err = fieldError(f.name);
            const disabled = !isCreate && !!def.immutableOnEdit?.includes(f.name);
            const wide = "wide" in f && f.wide ? "sm:col-span-2" : undefined;
            switch (f.type) {
              case "boolean":
                return <CheckField key={f.name} label={label} checked={!!values[f.name]} onChange={(v) => set(f.name, v)} disabled={disabled} className={wide} />;
              case "decimal":
                return <DecimalField key={f.name} label={label} required={f.required} hint={f.hint} error={err} disabled={disabled} value={String(values[f.name])} onChange={(v) => set(f.name, v)} />;
              case "int":
                return <IntField key={f.name} label={label} required={f.required} error={err} disabled={disabled} value={String(values[f.name])} onChange={(v) => set(f.name, v)} />;
              case "textarea":
                return <TextAreaField key={f.name} label={label} required={f.required} error={err} disabled={disabled} className="sm:col-span-2" value={String(values[f.name])} onChange={(v) => set(f.name, v)} />;
              case "select":
                return (
                  <SelectField
                    key={f.name}
                    label={label}
                    required={f.required}
                    error={err}
                    disabled={disabled}
                    value={String(values[f.name])}
                    onChange={(v) => set(f.name, v)}
                    options={f.options.map((o) => ({ value: o, label: t(`enums.${f.name}.${o}`) }))}
                  />
                );
              case "ref":
                return (
                  <RefSelect
                    key={f.name}
                    label={label}
                    required={f.required}
                    error={err}
                    disabled={disabled}
                    value={String(values[f.name])}
                    onChange={(v) => set(f.name, v)}
                    resource={`/${f.resource}`}
                    labelKey={f.labelKey}
                    filter={f.filter}
                  />
                );
              default:
                return <TextField key={f.name} label={label} type={f.type} required={f.required} error={err} disabled={disabled} maxLength={f.maxLength} placeholder={f.placeholder} className={wide} value={String(values[f.name])} onChange={(v) => set(f.name, v)} />;
            }
          })}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
