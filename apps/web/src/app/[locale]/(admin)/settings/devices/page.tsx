"use client";

import ConfirmDialog from "@/components/erp/ConfirmDialog";
import DataTable, { type Column } from "@/components/erp/DataTable";
import { BoolBadge, Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { fmtDateTime } from "@/lib/format";
import { post } from "@/lib/api";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

/** Dispositivos móviles registrados por los vendedores: ver actividad y revocar (teléfono perdido o cambiado) o restaurar. */
export default function DevicesPage() {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const list = useFetch<Row[]>("/devices");
  const [target, setTarget] = useState<Row | null>(null);
  const [releasing, setReleasing] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = can("mobile:devices:update");

  async function setRevoked(d: Row, revoke: boolean) {
    setBusy(true);
    try {
      await post(`/devices/${d.id}/${revoke ? "revoke" : "restore"}`, {});
      notice.success(t(revoke ? "settings.deviceRevoked" : "settings.deviceRestored"));
      setTarget(null);
      list.reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function release(d: Row) {
    setBusy(true);
    try {
      await post(`/devices/${d.id}/release`, {});
      notice.success(t("settings.deviceReleased"));
      setReleasing(null);
      list.reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Row>[] = [
    { key: "deviceCode", header: t("settings.deviceCode") },
    { key: "name", header: t("fields.name") },
    { key: "user", header: t("settings.deviceUser"), render: (r) => (r.user ? `${r.user.fullName} (${r.user.email})` : "—") },
    { key: "appVersion", header: t("settings.appVersion"), render: (r) => r.appVersion ?? "—" },
    { key: "queueSize", header: t("settings.queueSize"), align: "end", render: (r) => (r.queueSize === null || r.queueSize === undefined ? "—" : <span className={r.queueSize > 20 ? "font-semibold text-error-500" : ""}>{r.queueSize}</span>) },
    { key: "lastSeenAt", header: t("settings.lastSeen"), render: (r) => (r.lastSeenAt ? fmtDateTime(r.lastSeenAt) : "—") },
    { key: "revokedAt", header: t("fields.isActive"), render: (r) => <BoolBadge value={!r.revokedAt} /> },
    {
      key: "actions", header: "", align: "end",
      render: (r) => canEdit && (
        <span className="inline-flex gap-4">
          {r.revokedAt
            ? <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => setRevoked(r, false)}>{t("settings.restore")}</button>
            : <button type="button" className="text-sm text-error-500 hover:underline" onClick={() => setTarget(r)}>{t("settings.revoke")}</button>}
          <button type="button" className="text-sm text-gray-600 hover:underline dark:text-gray-400" onClick={() => setReleasing(r)}>{t("settings.release")}</button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title={t("sidebar.items.devices")} subtitle={t("settings.devicesSubtitle")} />
      <Card>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} />
      </Card>
      <ConfirmDialog open={!!target} busy={busy} danger title={t("settings.revokeTitle")} message={t("settings.revokeMessage", { name: target?.name ?? "", user: target?.user?.fullName ?? "" })}
        confirmLabel={t("settings.revoke")} onCancel={() => setTarget(null)} onConfirm={() => target && setRevoked(target, true)} />
      <ConfirmDialog open={!!releasing} busy={busy} danger title={t("settings.releaseTitle")} message={t("settings.releaseMessage", { name: releasing?.name ?? "", user: releasing?.user?.fullName ?? "" })}
        confirmLabel={t("settings.release")} onCancel={() => setReleasing(null)} onConfirm={() => releasing && release(releasing)} />
    </div>
  );
}
