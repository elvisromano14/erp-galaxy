"use client";

import ConfirmDialog from "@/components/erp/ConfirmDialog";
import DataTable, { type Column } from "@/components/erp/DataTable";
import { TextField } from "@/components/erp/FormFields";
import { BoolBadge, Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Badge from "@/components/ui/badge/Badge";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { fmtDateTime } from "@/lib/format";
import { post } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useState } from "react";
import ConnectionsTab from "./ConnectionsTab";
import MonitorTab from "./MonitorTab";

type Row = Record<string, any>;
interface Status {
  enabled: boolean;
  refs: Array<{ entity: string; system: string; count: number }>;
  pending: { customers: number; suppliers: number };
  lastEvent: { seq: number; createdAt: string } | null;
}

/**
 * Integración con otros sistemas (Saint): cuentas de servicio del integrador y estado de la sincronización.
 * El secreto de una cuenta se muestra UNA sola vez, al crearla o rotarla.
 */
export default function IntegrationPage() {
  const t = useTranslations("integration");
  const { can } = useAuth();
  const notice = useNotice();
  const accounts = useFetch<Row[]>("/integration/service-accounts");
  // El estado exige el permiso de uso de la API de integración; quien solo administra cuentas no lo ve.
  const status = useFetch<Status>(can("integration:sync:use") ? "/integration/status" : null);
  const canCreate = can("security:service-accounts:create");
  const canUpdate = can("security:service-accounts:update");
  const activeAccount = (accounts.data ?? []).find((a) => a.active);

  const canConnections = can("integration:connections:read");
  const canMonitor = can("integration:monitor:read");
  const [tab, setTab] = useState<"general" | "connections" | "monitor">("general");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [rotating, setRotating] = useState<Row | null>(null);
  const [revoking, setRevoking] = useState<Row | null>(null);
  const [pausing, setPausing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const createAccount = () =>
    run(async () => {
      const r = await post<Row>("/integration/service-accounts", { name: name.trim() });
      setCreating(false);
      setName("");
      setSecret({ clientId: r.data.clientId, clientSecret: r.data.clientSecret });
      notice.success(t("created"));
      accounts.reload();
    });

  const rotate = (a: Row) =>
    run(async () => {
      const r = await post<Row>(`/integration/service-accounts/${a.id}/rotate`, {});
      setRotating(null);
      setSecret({ clientId: r.data.clientId, clientSecret: r.data.clientSecret });
      notice.success(t("rotated"));
      accounts.reload();
    });

  const revoke = (a: Row) =>
    run(async () => {
      await post(`/integration/service-accounts/${a.id}/revoke`, {});
      setRevoking(null);
      notice.success(t("revokedOk"));
      accounts.reload();
      status.reload();
    });

  const setEnabled = (enabled: boolean) =>
    run(async () => {
      await post("/integration/enabled", { enabled });
      setPausing(false);
      status.reload();
    });

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notice.success(t("copied"));
    } catch {
      notice.error(text);
    }
  }

  const columns: Column<Row>[] = [
    { key: "name", header: t("accountName") },
    { key: "clientId", header: t("clientId"), render: (r) => <code className="text-xs">{r.clientId}</code> },
    { key: "createdAt", header: t("createdAt"), render: (r) => fmtDateTime(r.createdAt) },
    { key: "lastUsedAt", header: t("lastUsed"), render: (r) => (r.lastUsedAt ? fmtDateTime(r.lastUsedAt) : t("never")) },
    { key: "active", header: t("active"), render: (r) => <BoolBadge value={r.active} /> },
    {
      key: "actions", header: "", align: "end",
      render: (r) => canUpdate && r.active && (
        <span className="inline-flex gap-4">
          <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => setRotating(r)}>{t("rotate")}</button>
          <button type="button" className="text-sm text-error-500 hover:underline" onClick={() => setRevoking(r)}>{t("revoke")}</button>
        </span>
      ),
    },
  ];

  const s = status.data;
  const stat = (label: string, value: React.ReactNode) => (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-gray-800 dark:text-white/90">{value}</div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {(canConnections || canMonitor) && (
        <div role="tablist" className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
          {([["general", t("tabGeneral"), true], ["connections", t("tabConnections"), canConnections], ["monitor", t("tabMonitor"), canMonitor]] as const)
            .filter(([, , visible]) => visible)
            .map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === key ? "border-brand-500 text-brand-500" : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400"}`}>
                {label}
              </button>
            ))}
        </div>
      )}

      {tab === "connections" && canConnections && <ConnectionsTab />}
      {tab === "monitor" && canMonitor && <MonitorTab />}

      {tab === "general" && can("integration:sync:use") && (
        <Card
          title={t("statusTitle")}
          actions={canUpdate && s && (
            s.enabled
              ? <Button variant="outline" size="sm" onClick={() => setPausing(true)}>{t("pause")}</Button>
              : <Button size="sm" disabled={busy} onClick={() => setEnabled(true)}>{t("resume")}</Button>
          )}
        >
          <ErrorBox error={status.error} />
          {s && (
            <div className="space-y-4">
              <Badge color={s.enabled ? "success" : "warning"}>{s.enabled ? t("enabled") : t("paused")}</Badge>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {stat(t("pendingCustomers"), s.pending.customers)}
                {stat(t("pendingSuppliers"), s.pending.suppliers)}
                {stat(t("lastEvent"), s.lastEvent ? fmtDateTime(s.lastEvent.createdAt) : t("noEvents"))}
              </div>
              {s.refs.length > 0 && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t("linkedRecords")}: {s.refs.map((r) => `${r.entity} ${r.count}`).join(" · ")}
                </p>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === "general" && <Card
        title={t("accountsTitle")}
        actions={canCreate && !activeAccount && <Button size="sm" onClick={() => setCreating(true)}>{t("create")}</Button>}
      >
        <ErrorBox error={accounts.error} />
        {!accounts.loading && (accounts.data ?? []).length === 0 && <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t("noAccounts")}</p>}
        <DataTable columns={columns} rows={accounts.data} loading={accounts.loading} rowKey={(r) => r.id} />
      </Card>}

      <Modal isOpen={creating} onClose={() => setCreating(false)} className="m-4 max-w-md p-6">
        <div role="dialog" aria-modal="true" aria-label={t("createTitle")}>
          <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("createTitle")}</h3>
          <TextField label={t("accountName")} required value={name} onChange={setName} hint={t("accountNameHint")} />
          <div className="mt-6 flex justify-end gap-3">
            <Button variant="outline" size="sm" onClick={() => setCreating(false)}>{t("close")}</Button>
            <Button size="sm" disabled={busy || name.trim().length < 2} onClick={createAccount}>{t("create")}</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!secret} onClose={() => setSecret(null)} className="m-4 max-w-lg p-6">
        {secret && (
          <div role="dialog" aria-modal="true" aria-label={t("secretTitle")}>
            <h3 className="mb-2 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{t("secretTitle")}</h3>
            <p className="mb-4 text-sm text-warning-600 dark:text-warning-500">{t("secretWarning")}</p>
            {([["clientId", secret.clientId], ["clientSecret", secret.clientSecret]] as const).map(([k, v]) => (
              <div key={k} className="mb-3">
                <div className="mb-1 text-xs text-gray-500 dark:text-gray-400">{t(k)}</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-lg bg-gray-100 p-2 text-xs text-gray-800 dark:bg-white/[0.05] dark:text-white/90">{v}</code>
                  <Button variant="outline" size="sm" onClick={() => copy(v)}>{t("copy")}</Button>
                </div>
              </div>
            ))}
            <div className="mt-6 flex justify-end">
              <Button size="sm" onClick={() => setSecret(null)}>{t("close")}</Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={!!rotating} busy={busy} danger title={t("rotateTitle")} message={t("rotateMessage")} confirmLabel={t("rotate")}
        onCancel={() => setRotating(null)} onConfirm={() => rotating && rotate(rotating)} />
      <ConfirmDialog open={!!revoking} busy={busy} danger title={t("revokeTitle")} message={t("revokeMessage", { name: revoking?.name ?? "" })} confirmLabel={t("revoke")}
        onCancel={() => setRevoking(null)} onConfirm={() => revoking && revoke(revoking)} />
      <ConfirmDialog open={pausing} busy={busy} danger title={t("pauseTitle")} message={t("pauseMessage")} confirmLabel={t("pause")}
        onCancel={() => setPausing(false)} onConfirm={() => setEnabled(false)} />
    </div>
  );
}
