"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { NativeSelect, TextField } from "@/components/erp/FormFields";
import { Card, ErrorBox } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Badge from "@/components/ui/badge/Badge";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { post } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Row = Record<string, any>;
const REFRESH_MS = 15_000;

/** Monitoreo del integrador: estado por conexión y flujo, últimas pasadas y conflictos por resolver. Se refresca solo. */
export default function MonitorTab() {
  const t = useTranslations("integration");
  const { can } = useAuth();
  const notice = useNotice();
  const [status, setStatus] = useState("OPEN");
  const summary = useFetch<Row[]>("/integration/monitor");
  const conflicts = useFetch<Row[]>("/integration/monitor/conflicts", { status: status || undefined, limit: 100 });
  const runs = useFetch<Row[]>("/integration/monitor/runs", { limit: 20 });
  const canUpdate = can("integration:monitor:update");
  const [open, setOpen] = useState<string | null>(null);
  const [ack, setAck] = useState<Row | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const { reload: r1 } = summary; const { reload: r2 } = conflicts; const { reload: r3 } = runs;
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") { r1(); r2(); r3(); } }, REFRESH_MS);
    return () => clearInterval(id);
  }, [r1, r2, r3]);

  async function setConflict(c: Row, next: "ACKNOWLEDGED" | "OPEN", text?: string) {
    setBusy(true);
    try {
      await post(`/integration/monitor/conflicts/${c.id}/status`, { status: next, ...(text ? { note: text } : {}) });
      setAck(null); setNote("");
      conflicts.reload(); summary.reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const statusColor = (s: string) => (s === "OPEN" ? "error" : s === "ACKNOWLEDGED" ? "warning" : "success");
  const streamLabel = (s: string) => { try { return t(`stream_${s}`); } catch { return s; } };

  const streamCols: Column<Row>[] = [
    { key: "stream", header: t("monStream"), render: (r) => streamLabel(r.stream) },
    { key: "startedAt", header: t("monLastRun"), render: (r) => fmtDateTime(r.startedAt) },
    { key: "rowsRead", header: t("monRead"), align: "end" },
    { key: "rowsApplied", header: t("monApplied"), align: "end" },
    { key: "rowsFailed", header: t("monFailed"), align: "end", render: (r) => (r.rowsFailed ? <span className="text-error-500">{r.rowsFailed}</span> : 0) },
    { key: "error", header: t("monError"), render: (r) => (r.error ? <span className="text-xs text-error-500">{r.error}</span> : "—") },
  ];

  const conflictCols: Column<Row>[] = [
    { key: "status", header: t("monState"), render: (r) => <Badge color={statusColor(r.status)}>{t(`conflict_${r.status}`)}</Badge> },
    { key: "connectorId", header: t("connId"), render: (r) => <code className="text-xs">{r.connectorId}</code> },
    { key: "entity", header: t("monEntity") },
    { key: "saintKey", header: t("monSaintKey"), render: (r) => (r.saintKey ? <code className="text-xs">{r.saintKey}</code> : "—") },
    { key: "kind", header: t("monKind"), render: (r) => <code className="text-xs">{r.kind}</code> },
    { key: "updatedAt", header: t("monUpdated"), render: (r) => fmtDateTime(r.updatedAt) },
    {
      key: "detail", header: t("monDetail"),
      render: (r) => (
        <div className="max-w-xs">
          <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? t("monHide") : t("monShow")}</button>
          {open === r.id && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-100 p-2 text-xs dark:bg-white/[0.05]">{JSON.stringify(r.detail ?? {}, null, 2)}</pre>}
          {r.note && <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t("monNote")}: {r.note}</div>}
        </div>
      ),
    },
    {
      key: "actions", header: "", align: "end",
      render: (r) => canUpdate && (r.status === "OPEN"
        ? <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => { setNote(""); setAck(r); }}>{t("monAck")}</button>
        : r.status === "ACKNOWLEDGED" ? <button type="button" disabled={busy} className="text-sm text-brand-500 hover:underline" onClick={() => setConflict(r, "OPEN")}>{t("monReopen")}</button> : null),
    },
  ];

  const runCols: Column<Row>[] = [
    { key: "startedAt", header: t("monLastRun"), render: (r) => fmtDateTime(r.startedAt) },
    { key: "connectorId", header: t("connId"), render: (r) => <code className="text-xs">{r.connectorId}</code> },
    { key: "stream", header: t("monStream"), render: (r) => streamLabel(r.stream) },
    { key: "rowsRead", header: t("monRead"), align: "end" },
    { key: "rowsApplied", header: t("monApplied"), align: "end" },
    { key: "rowsFailed", header: t("monFailed"), align: "end" },
    { key: "error", header: t("monError"), render: (r) => (r.error ? <span className="text-xs text-error-500">{r.error}</span> : "—") },
  ];

  return (
    <div className="space-y-6">
      <ErrorBox error={summary.error} />
      {!summary.loading && (summary.data ?? []).length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">{t("noConnections")}</p>}
      {(summary.data ?? []).map((c) => (
        <Card key={c.id} title={`${c.name} (${c.connectorId})`}
          actions={<span className="inline-flex items-center gap-2">
            {!c.enabled ? <Badge color="light">{t("connDisabled")}</Badge> : <Badge color={c.online ? "success" : "warning"}>{c.online ? t("online") : t("offline")}</Badge>}
            <Badge color={c.openConflicts ? "error" : "success"}>{t("monOpenConflicts", { n: c.openConflicts })}</Badge>
          </span>}>
          <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{t("monLastSeen")}: {c.lastSeenAt ? fmtDateTime(c.lastSeenAt) : t("never")} · {c.host}:{c.port}/{c.databaseName}</p>
          <DataTable columns={streamCols} rows={c.streamsStatus} rowKey={(r) => r.stream} emptyText={t("monNoRuns")} />
        </Card>
      ))}

      <Card title={t("monConflicts")}
        actions={<div className="w-44"><NativeSelect value={status} onChange={setStatus} placeholder={t("monAll")} options={["OPEN", "ACKNOWLEDGED", "RESOLVED"].map((v) => ({ value: v, label: t(`conflict_${v}`) }))} /></div>}>
        <ErrorBox error={conflicts.error} />
        <DataTable columns={conflictCols} rows={conflicts.data} loading={conflicts.loading} rowKey={(r) => r.id} emptyText={t("monNoConflicts")} />
      </Card>

      <Card title={t("monRuns")}>
        <ErrorBox error={runs.error} />
        <DataTable columns={runCols} rows={runs.data} loading={runs.loading} rowKey={(r) => String(r.id)} emptyText={t("monNoRuns")} />
      </Card>

      <Modal isOpen={!!ack} onClose={() => setAck(null)} className="m-4 max-w-md p-6">
        {ack && (
          <div role="dialog" aria-modal="true" aria-label={t("monAck")}>
            <h3 className="mb-2 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("monAck")}</h3>
            <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">{t("monAckHelp")}</p>
            <TextField label={t("monNote")} value={note} onChange={setNote} maxLength={500} />
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" size="sm" onClick={() => setAck(null)}>{t("cancel")}</Button>
              <Button size="sm" disabled={busy} onClick={() => setConflict(ack, "ACKNOWLEDGED", note.trim() || undefined)}>{t("monAck")}</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
