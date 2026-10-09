"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { Card, ErrorBox, PageHeader, StatusBadge } from "@/components/erp/ui";
import Button from "@/components/ui/button/Button";
import { useFetch } from "@/components/erp/useFetch";
import { useNotice } from "@/context/NoticeContext";
import { downloadFile } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Row = Record<string, any>;

export default function ReportJobsPage() {
  const t = useTranslations();
  const notice = useNotice();
  const [page, setPage] = useState(1);
  const list = useFetch<Row[]>("/reports/jobs", { page, limit: 20 });
  const active = (list.data ?? []).some((j) => j.status === "QUEUED" || j.status === "RUNNING");
  // Mientras haya trabajos en curso se consulta cada 2 s.
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => list.reload(), 2000);
    return () => clearInterval(h);
  }, [active, list]);

  const size = (n: number | null) => (n === null || n === undefined ? "—" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const columns: Column<Row>[] = [
    { key: "title", header: t("reports.report") },
    { key: "format", header: t("reports.format"), render: (r) => String(r.format).toUpperCase() },
    { key: "createdAt", header: t("fields.date"), render: (r) => fmtDateTime(r.createdAt) },
    { key: "status", header: t("fields.status"), render: (r) => <StatusBadge status={r.status} /> },
    { key: "rowCount", header: t("reports.rowsCol"), align: "end", render: (r) => (r.rowCount ?? "—") + (r.truncated ? "+" : "") },
    { key: "sizeBytes", header: t("reports.size"), align: "end", render: (r) => size(r.sizeBytes) },
    {
      key: "actions", header: "", render: (r) => r.status === "DONE"
        ? <Button size="sm" variant="outline" onClick={() => downloadFile(`/reports/jobs/${r.id}/download`).catch((e) => notice.error((e as Error).message))}>{t("reports.download")}</Button>
        : r.status === "FAILED" ? <span className="text-xs text-error-600">{r.error}</span> : r.status === "EXPIRED" ? <span className="text-xs text-gray-400">{t("reports.expired")}</span> : null,
    },
  ];
  return (
    <div>
      <PageHeader title={t("sidebar.items.report-jobs")} subtitle={t("reports.jobsSubtitle")} />
      <Card>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading && !list.data} rowKey={(r) => r.id} meta={list.meta} onPage={setPage} />
      </Card>
    </div>
  );
}
