"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { SelectField } from "@/components/erp/FormFields";
import { Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Badge from "@/components/ui/badge/Badge";
import Button from "@/components/ui/button/Button";
import { useNotice } from "@/context/NoticeContext";
import { ApiError, downloadFile, uploadFile } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

type Row = Record<string, any>;
interface ImportType { key: string; title: string; description: string; supportsExisting: boolean; maxRows: number; columns: { key: string; header: string; required?: boolean; help: string; example: string }[] }
interface Outcome {
  committed: boolean; filename: string; unknownColumns: string[]; truncated: boolean;
  summary: { total: number; create: number; update: number; skip: number; errors: number; warnings: number };
  rows: { row: number; label: string; action: string; errors: string[]; warnings: string[] }[];
  result?: { created: number; updated: number; note?: string };
}

const COLOR = { create: "success", update: "info", skip: "light", error: "error" } as const;

export default function ImportPage() {
  const t = useTranslations();
  const notice = useNotice();
  const types = useFetch<ImportType[]>("/imports/types");
  const [type, setType] = useState("");
  const [onExisting, setOnExisting] = useState<"skip" | "update">("skip");
  const [file, setFile] = useState<File | null>(null);
  const [validatedFor, setValidatedFor] = useState<File | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<"validate" | "commit" | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const def = types.data?.find((x) => x.key === type);
  const reset = () => { setOutcome(null); setError(null); setValidatedFor(null); };

  async function send(mode: "validate" | "commit") {
    if (!file || !def) return;
    setBusy(mode);
    setError(null);
    try {
      const r = await uploadFile<Outcome>(`/imports/${def.key}`, file, { mode, onExisting });
      setOutcome(r.data);
      if (mode === "validate") setValidatedFor(file);
      else {
        notice.success(t("import.done"));
        setValidatedFor(null);
      }
    } catch (e) {
      setOutcome(null);
      const err = e instanceof ApiError ? e : new ApiError(0, "ERROR", String(e));
      setError(err);
      if (mode === "commit") setValidatedFor(null);
    } finally {
      setBusy(null);
    }
  }

  async function template(format: "xlsx" | "csv") {
    try { await downloadFile(`/imports/${type}/template`, { format }); } catch (e) { notice.error((e as Error).message); }
  }

  const readyToCommit = !!outcome && !outcome.committed && outcome.summary.errors === 0 && validatedFor === file && outcome.summary.create + outcome.summary.update > 0;
  const columns: Column<Outcome["rows"][number]>[] = [
    { key: "row", header: t("import.row"), align: "end" },
    { key: "label", header: t("import.detail") },
    { key: "action", header: t("import.action"), render: (r) => <Badge size="sm" color={COLOR[r.action as keyof typeof COLOR] ?? "light"}>{t(`import.actions.${r.action}`)}</Badge> },
    { key: "notes", header: "", render: (r) => (<div className="space-y-0.5 text-theme-xs">{r.errors.map((e, i) => <p key={`e${i}`} className="text-error-600">{e}</p>)}{r.warnings.map((w, i) => <p key={`w${i}`} className="text-warning-600">{w}</p>)}</div>) },
  ];

  if (types.loading && !types.data) return <Loading />;

  return (
    <div>
      <PageHeader title={t("import.title")} subtitle={t("import.subtitle")} />
      <ErrorBox error={types.error} />
      <Card className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SelectField label={t("import.type")} value={type} onChange={(v) => { setType(v); setFile(null); reset(); if (input.current) input.current.value = ""; }} options={(types.data ?? []).map((x) => ({ value: x.key, label: x.title }))} />
          {def?.supportsExisting && (
            <SelectField label={t("import.onExisting")} value={onExisting} onChange={(v) => { setOnExisting(v as "skip" | "update"); reset(); }} options={[{ value: "skip", label: t("import.skip") }, { value: "update", label: t("import.update") }]} />
          )}
        </div>
        {def && (
          <>
            <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">{def.description} {t("import.maxRows", { count: def.maxRows })}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => template("xlsx")}>{t("import.downloadXlsx")}</Button>
              <Button variant="outline" size="sm" onClick={() => template("csv")}>{t("import.downloadCsv")}</Button>
            </div>
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-brand-500">{t("import.columns")}</summary>
              <table className="mt-2 w-full text-sm">
                <thead><tr className="border-b border-gray-100 text-start text-gray-500 dark:border-gray-800"><th className="py-1 text-start">{t("import.column")}</th><th className="text-start">{t("import.required")}</th><th className="text-start">{t("import.help")}</th><th className="text-start">{t("import.example")}</th></tr></thead>
                <tbody>
                  {def.columns.map((c) => (
                    <tr key={c.key} className="border-b border-gray-50 dark:border-gray-800">
                      <td className="py-1 font-mono text-xs">{c.header}</td><td>{c.required ? t("common.yes") : t("common.no")}</td><td className="pe-3 text-gray-600 dark:text-gray-400">{c.help}</td><td className="font-mono text-xs">{c.example}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            <div className="mt-5">
              <label htmlFor="import-file" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-400">{t("import.file")}</label>
              <input
                id="import-file" ref={input} type="file" accept=".xlsx,.csv"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }}
                className="block w-full max-w-lg text-sm text-gray-700 file:me-4 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-600 hover:file:bg-brand-100 dark:text-gray-300"
              />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button size="sm" variant="outline" disabled={!file || busy !== null} onClick={() => send("validate")}>{busy === "validate" ? t("import.validating") : t("import.validate")}</Button>
              <Button size="sm" disabled={!readyToCommit || busy !== null} onClick={() => send("commit")}>{busy === "commit" ? t("import.committing") : t("import.commit")}</Button>
              {!file && <span className="text-sm text-gray-500">{t("import.chooseFile")}</span>}
              {file && outcome && !outcome.committed && validatedFor !== file && <span className="text-sm text-warning-600">{t("import.fileChanged")}</span>}
            </div>
          </>
        )}
      </Card>

      <ErrorBox error={error} />
      {outcome && (
        <Card title={outcome.committed ? t("import.done") : t("import.summary")}>
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge color="light">{t("import.total")}: {outcome.summary.total}</Badge>
            <Badge color="success">{t("import.create")}: {outcome.summary.create}</Badge>
            <Badge color="info">{t("import.updateN")}: {outcome.summary.update}</Badge>
            <Badge color="light">{t("import.skipN")}: {outcome.summary.skip}</Badge>
            <Badge color={outcome.summary.errors ? "error" : "light"}>{t("import.errorsN")}: {outcome.summary.errors}</Badge>
            <Badge color={outcome.summary.warnings ? "warning" : "light"}>{t("import.warningsN")}: {outcome.summary.warnings}</Badge>
          </div>
          {outcome.committed && outcome.result ? (
            <p className="mb-3 rounded-lg bg-success-50 p-3 text-sm text-success-700 dark:bg-success-500/15 dark:text-success-500">
              {t("import.create")}: {outcome.result.created} · {t("import.updateN")}: {outcome.result.updated}{outcome.result.note ? ` · ${outcome.result.note}` : ""}
            </p>
          ) : outcome.summary.errors ? (
            <p className="mb-3 text-sm text-error-600">{t("import.hasErrors")}</p>
          ) : (
            <p className="mb-3 text-sm text-success-600">{t("import.okReady")}</p>
          )}
          {outcome.unknownColumns.length > 0 && <p className="mb-3 text-xs text-gray-500">{t("import.unknownColumns", { cols: outcome.unknownColumns.join(", ") })}</p>}
          {outcome.truncated && <p className="mb-3 text-xs text-gray-500">{t("import.truncated")}</p>}
          <DataTable columns={columns} rows={outcome.rows} rowKey={(r) => String(r.row)} />
        </Card>
      )}
    </div>
  );
}
