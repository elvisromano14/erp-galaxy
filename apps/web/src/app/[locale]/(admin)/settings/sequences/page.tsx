"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { RInt, RText } from "@/components/erp/rhf";
import { Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import Badge from "@/components/ui/badge/Badge";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { ApiError, api } from "@/lib/api";
import { reqInt } from "@/lib/validators";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

type Row = Record<string, any>;

export default function SequencesPage() {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const list = useFetch<Row[]>("/document-sequences");
  const [editing, setEditing] = useState<Row | null>(null);

  const columns: Column<Row>[] = [
    { key: "docType", header: t("fields.document"), render: (r) => t(`sequences.${r.docType}`) },
    { key: "series", header: t("fields.series") },
    { key: "prefix", header: t("sequences.prefix") },
    { key: "padding", header: t("sequences.padding"), align: "end" },
    { key: "nextNumber", header: t("sequences.next"), align: "end" },
    { key: "example", header: t("sequences.example"), render: (r) => <span className="font-mono">{r.example}</span> },
    { key: "isDefault", header: "", render: (r) => r.isDefault && <Badge size="sm" color="light">{t("sequences.notUsed")}</Badge> },
    { key: "actions", header: "", align: "end", render: (r) => can("admin:sequences:update") && <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => setEditing(r)}>{t("common.edit")}</button> },
  ];

  return (
    <div>
      <PageHeader title={t("sidebar.items.sequences")} subtitle={t("sequences.subtitle")} />
      <Card>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => `${r.docType}-${r.series}`} />
      </Card>
      {editing && <SequenceForm row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); notice.success(t("common.saved")); list.reload(); }} />}
    </div>
  );
}

const schema = z.object({
  prefix: z.string().regex(/^[A-Za-z0-9\-_.]{0,12}$/, "Hasta 12 caracteres: letras, números, - _ ."),
  padding: reqInt.refine((v) => Number(v) >= 1 && Number(v) <= 12, "Entre 1 y 12"),
  nextNumber: reqInt.refine((v) => Number(v) >= 1, "Debe ser mayor que cero"),
});

function SequenceForm({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { prefix: row.prefix, padding: String(row.padding), nextNumber: String(row.nextNumber) } });
  const [error, setError] = useState<ApiError | null>(null);
  const prefix = form.watch("prefix"), padding = form.watch("padding"), next = form.watch("nextNumber");
  const example = `${prefix}${String(next || "1").padStart(Math.min(Number(padding) || 1, 12), "0")}`;

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api("/document-sequences", { method: "PUT", body: { docType: row.docType, series: row.series, prefix: v.prefix, padding: Number(v.padding), nextNumber: v.nextNumber } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "ERROR", String(err)));
    }
  });

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-lg p-6">
      <form onSubmit={submit} noValidate>
        <h3 className="mb-1 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t(`sequences.${row.docType}`)}</h3>
        <p className="mb-4 text-sm text-gray-500">{t("sequences.editHint")}</p>
        <ErrorBox error={error} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <RText control={form.control} name="prefix" label={t("sequences.prefix")} />
          <RInt control={form.control} name="padding" label={t("sequences.padding")} />
          <RInt control={form.control} name="nextNumber" label={t("sequences.next")} hint={t("sequences.nextHint", { min: row.nextNumber })} />
        </div>
        <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">{t("sequences.example")}: <span className="font-mono font-medium">{example}</span></p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? t("common.saving") : t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
