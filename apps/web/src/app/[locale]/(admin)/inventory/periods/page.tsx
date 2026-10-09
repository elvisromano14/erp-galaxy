"use client";

import ConfirmDialog from "@/components/erp/ConfirmDialog";
import DataTable, { type Column } from "@/components/erp/DataTable";
import { Card, ErrorBox, PageHeader, StatusBadge } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { post } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

export default function PeriodsPage() {
  const t = useTranslations();
  const { can } = useAuth();
  const notice = useNotice();
  const list = useFetch<Row[]>("/inventory/periods");
  const [target, setTarget] = useState<{ year: number; month: number; action: "close" | "reopen" } | null>(null);
  const [busy, setBusy] = useState(false);

  // Mes siguiente al último cerrado (o el mes anterior al actual si no hay ninguno).
  const closed = (list.data ?? []).filter((p) => p.status === "CLOSED");
  const last = closed[0];
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const next = last ? new Date(last.year, last.month, 1) : prev;
  const canCloseNext = next < new Date(now.getFullYear(), now.getMonth(), 1);

  async function run() {
    if (!target) return;
    setBusy(true);
    try {
      await post(`/inventory/periods/${target.action}`, { year: target.year, month: target.month });
      notice.success(t("common.saved"));
      setTarget(null);
      list.reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Row>[] = [
    { key: "period", header: t("inventory.period"), render: (r) => `${String(r.month).padStart(2, "0")}/${r.year}` },
    { key: "status", header: t("fields.status"), render: (r) => <StatusBadge status={r.status === "CLOSED" ? "CLOSED" : "OPEN"} /> },
    { key: "closedAt", header: t("inventory.closedAt"), render: (r) => fmtDateTime(r.closedAt) },
    {
      key: "actions", header: "", align: "end",
      render: (r) => can("inventory:periods:close") && r.status === "CLOSED" && last?.id === r.id && (
        <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => setTarget({ year: r.year, month: r.month, action: "reopen" })}>{t("inventory.reopen")}</button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t("sidebar.items.periods")}
        subtitle={t("inventory.periodsSubtitle")}
        actions={can("inventory:periods:close") && canCloseNext && (
          <Button size="sm" onClick={() => setTarget({ year: next.getFullYear(), month: next.getMonth() + 1, action: "close" })}>
            {t("inventory.closePeriod", { period: `${String(next.getMonth() + 1).padStart(2, "0")}/${next.getFullYear()}` })}
          </Button>
        )}
      />
      <Card>
        <ErrorBox error={list.error} />
        <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} />
      </Card>
      <ConfirmDialog
        open={!!target}
        busy={busy}
        title={target?.action === "close" ? t("inventory.closeTitle") : t("inventory.reopenTitle")}
        message={target ? `${String(target.month).padStart(2, "0")}/${target.year}` : undefined}
        onCancel={() => setTarget(null)}
        onConfirm={run}
      />
    </div>
  );
}
