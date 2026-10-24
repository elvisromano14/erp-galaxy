"use client";

import ConfirmDialog from "@/components/erp/ConfirmDialog";
import DataTable, { type Column } from "@/components/erp/DataTable";
import { CheckField, IntField, TextField } from "@/components/erp/FormFields";
import { Card, ErrorBox } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Badge from "@/components/ui/badge/Badge";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/context/AuthContext";
import { useNotice } from "@/context/NoticeContext";
import { ApiError, del, get, patch, post } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;
export const STREAMS = ["zones", "sellers", "warehouses", "categories", "customers", "products"] as const;

interface Form {
  connectorId: string; name: string; host: string; port: string; databaseName: string; username: string; password: string;
  encrypt: boolean; trustServerCertificate: boolean; pollIntervalSec: string; streams: string[]; priceCurrency: string; enabled: boolean;
  writeEnabled: boolean; allowedWriteDatabases: string; outboundCustomers: boolean;
}

const EMPTY: Form = {
  connectorId: "", name: "", host: "", port: "1433", databaseName: "", username: "", password: "", encrypt: false, trustServerCertificate: true,
  pollIntervalSec: "30", streams: ["customers"], priceCurrency: "USD", enabled: true, writeEnabled: false, allowedWriteDatabases: "", outboundCustomers: false,
};

const fromRow = (r: Row): Form => ({
  connectorId: r.connectorId, name: r.name, host: r.host, port: String(r.port), databaseName: r.databaseName, username: r.username, password: "",
  encrypt: r.encrypt, trustServerCertificate: r.trustServerCertificate, pollIntervalSec: String(r.pollIntervalSec), streams: r.streams, priceCurrency: r.priceCurrency,
  enabled: r.enabled, writeEnabled: r.mode === "READ_WRITE", allowedWriteDatabases: (r.allowedWriteDatabases ?? []).join(", "), outboundCustomers: (r.outbound ?? []).includes("customers"),
});

/** Conexiones del integrador a las bases de Saint. La clave se guarda cifrada en el servidor y nunca vuelve a mostrarse. */
export default function ConnectionsTab() {
  const t = useTranslations("integration");
  const { can } = useAuth();
  const notice = useNotice();
  const list = useFetch<Row[]>("/integration/connections");
  const canCreate = can("integration:connections:create");
  const canUpdate = can("integration:connections:update");
  const canDelete = can("integration:connections:delete");

  const [editing, setEditing] = useState<{ id: string | null; version?: number } | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [formError, setFormError] = useState<ApiError | Error | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<string[]>([]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const open = (r?: Row) => {
    setFormError(null);
    setSuggested(r?.testDatabases ?? []);
    setForm(r ? fromRow(r) : EMPTY);
    setEditing({ id: r?.id ?? null, version: r?.version });
  };

  const fieldError = (field: string) => (formError instanceof ApiError ? formError.details.find((d) => d.field === field || d.field?.startsWith(`${field}.`))?.message : undefined);

  async function save() {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    const allowed = form.allowedWriteDatabases.split(",").map((s) => s.trim()).filter(Boolean);
    const common = {
      name: form.name.trim(), host: form.host.trim(), port: Number(form.port), databaseName: form.databaseName.trim(), username: form.username.trim(),
      encrypt: form.encrypt, trustServerCertificate: form.trustServerCertificate, pollIntervalSec: Number(form.pollIntervalSec),
      streams: form.streams, priceCurrency: form.priceCurrency.trim().toUpperCase(), enabled: form.enabled,
      mode: form.writeEnabled ? "READ_WRITE" : "READ_ONLY",
      allowedWriteDatabases: form.writeEnabled ? allowed : [],
      outbound: form.writeEnabled && form.outboundCustomers ? ["customers"] : [],
    };
    try {
      if (editing.id) {
        await patch(`/integration/connections/${editing.id}`, { ...common, ...(form.password ? { password: form.password } : {}), version: editing.version });
        notice.success(t("connSaved"));
      } else {
        await post("/integration/connections", { ...common, connectorId: form.connectorId.trim(), password: form.password });
        notice.success(t("connCreated"));
      }
      setEditing(null);
      list.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && editing.id) { setFormError(new Error(t("connVersionConflict"))); list.reload(); }
      else setFormError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  async function test(r: Row) {
    setTesting(r.id);
    try {
      await post(`/integration/connections/${r.id}/test`, {});
      const until = Date.now() + 60_000;
      let last: Row | null = null;
      while (Date.now() < until) {
        await new Promise((res) => setTimeout(res, 2000));
        last = (await get<Row>(`/integration/connections/${r.id}`)).data;
        if (!last.testPending) break;
      }
      list.reload();
      if (!last || last.testPending) notice.error(t("testTimeout"));
      else if (last.testOk) notice.success(t("testOk", { ms: last.testLatencyMs ?? 0 }));
      else notice.error(last.testMessage ?? t("testFailed"));
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setTesting(null);
    }
  }

  async function remove(r: Row) {
    setBusy(true);
    try {
      await del(`/integration/connections/${r.id}`);
      setDeleting(null);
      notice.success(t("connDeleted"));
      list.reload();
    } catch (e) {
      notice.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const streamLabel = (s: string) => t(`stream_${s}`);
  const toggleStream = (s: string, on: boolean) => set("streams", on ? [...form.streams, s] : form.streams.filter((x) => x !== s));

  const columns: Column<Row>[] = [
    { key: "connectorId", header: t("connId"), render: (r) => <code className="text-xs">{r.connectorId}</code> },
    { key: "name", header: t("accountName") },
    { key: "target", header: t("connTarget"), render: (r) => <span className="text-xs">{r.host}:{r.port} / {r.databaseName}</span> },
    { key: "mode", header: t("connMode"), render: (r) => <Badge color={r.mode === "READ_WRITE" ? "warning" : "light"}>{r.mode === "READ_WRITE" ? t("modeWrite") : t("modeRead")}</Badge> },
    { key: "streams", header: t("connStreams"), render: (r) => <span className="text-xs">{r.streams.map(streamLabel).join(", ") || "—"}</span> },
    {
      key: "state", header: t("connState"),
      render: (r) => (
        <div className="space-y-1">
          {!r.enabled ? <Badge color="light">{t("connDisabled")}</Badge> : <Badge color={r.online ? "success" : "warning"}>{r.online ? t("online") : t("offline")}</Badge>}
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {r.testPending ? t("testPending")
              : r.testAt ? `${r.testOk ? t("testOkShort") : t("testFailed")} · ${fmtDateTime(r.testAt)}${r.testOk && r.testLatencyMs != null ? ` · ${r.testLatencyMs} ms` : ""}`
              : t("notTested")}
          </div>
          {r.testAt && !r.testOk && r.testMessage && <div className="max-w-xs text-xs text-error-500">{r.testMessage}</div>}
        </div>
      ),
    },
    {
      key: "actions", header: "", align: "end",
      render: (r) => (
        <span className="inline-flex gap-4">
          {canUpdate && <button type="button" disabled={testing === r.id} className="text-sm text-brand-500 hover:underline disabled:opacity-50" onClick={() => test(r)}>{testing === r.id ? t("testing") : t("test")}</button>}
          {canUpdate && <button type="button" className="text-sm text-brand-500 hover:underline" onClick={() => open(r)}>{t("edit")}</button>}
          {canDelete && <button type="button" className="text-sm text-error-500 hover:underline" onClick={() => setDeleting(r)}>{t("delete")}</button>}
        </span>
      ),
    },
  ];

  return (
    <Card title={t("connTitle")} actions={canCreate && <Button size="sm" onClick={() => open()}>{t("connCreate")}</Button>}>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t("connHelp")}</p>
      <ErrorBox error={list.error} />
      {!list.loading && (list.data ?? []).length === 0 && <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">{t("noConnections")}</p>}
      <DataTable columns={columns} rows={list.data} loading={list.loading} rowKey={(r) => r.id} />

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} className="m-4 max-w-2xl p-6">
        {editing && (
          <div role="dialog" aria-modal="true" aria-label={editing.id ? t("connEdit") : t("connCreate")} className="max-h-[80vh] overflow-y-auto pe-1">
            <h3 className="mb-4 pe-10 text-lg font-semibold text-gray-800 dark:text-white/90">{editing.id ? t("connEdit") : t("connCreate")}</h3>
            <ErrorBox error={formError} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField label={t("connId")} required disabled={!!editing.id} value={form.connectorId} onChange={(v) => set("connectorId", v.toLowerCase())} hint={t("connIdHint")} error={fieldError("connectorId")} maxLength={40} />
              <TextField label={t("accountName")} required value={form.name} onChange={(v) => set("name", v)} error={fieldError("name")} maxLength={80} />
              <TextField label={t("connHost")} required value={form.host} onChange={(v) => set("host", v)} error={fieldError("host")} hint={t("connHostHint")} />
              <IntField label={t("connPort")} required value={form.port} onChange={(v) => set("port", v)} error={fieldError("port")} />
              <div>
                <TextField label={t("connDatabase")} required value={form.databaseName} onChange={(v) => set("databaseName", v)} error={fieldError("databaseName")} />
                {suggested.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    {t("suggestedDatabases")}:
                    {suggested.map((d) => (
                      <button key={d} type="button" className="rounded bg-gray-100 px-2 py-0.5 text-brand-500 hover:underline dark:bg-white/[0.05]" onClick={() => set("databaseName", d)}>{d}</button>
                    ))}
                  </div>
                )}
              </div>
              <TextField label={t("connUser")} required value={form.username} onChange={(v) => set("username", v)} error={fieldError("username")} hint={t("connUserHint")} />
              <TextField label={t("connPassword")} type="password" required={!editing.id} value={form.password} onChange={(v) => set("password", v)} error={fieldError("password")} hint={editing.id ? t("connPasswordKeep") : t("connPasswordHint")} />
              <IntField label={t("connInterval")} required value={form.pollIntervalSec} onChange={(v) => set("pollIntervalSec", v)} error={fieldError("pollIntervalSec")} hint={t("connIntervalHint")} />
              <TextField label={t("connCurrency")} value={form.priceCurrency} onChange={(v) => set("priceCurrency", v.toUpperCase())} maxLength={3} error={fieldError("priceCurrency")} hint={t("connCurrencyHint")} />
              <div className="flex flex-col justify-end gap-2 pb-1">
                <CheckField label={t("connEncrypt")} checked={form.encrypt} onChange={(v) => set("encrypt", v)} />
                <CheckField label={t("connTrust")} checked={form.trustServerCertificate} onChange={(v) => set("trustServerCertificate", v)} />
                <CheckField label={t("connEnabled")} checked={form.enabled} onChange={(v) => set("enabled", v)} />
              </div>
            </div>

            <fieldset className="mt-5">
              <legend className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">{t("connStreamsLegend")}</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {STREAMS.map((s) => <CheckField key={s} label={streamLabel(s)} checked={form.streams.includes(s)} onChange={(v) => toggleStream(s, v)} />)}
              </div>
              {fieldError("streams") && <p className="mt-1 text-xs text-error-500">{fieldError("streams")}</p>}
            </fieldset>

            <fieldset className="mt-5 rounded-lg border border-warning-300 p-4 dark:border-warning-500/40">
              <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">{t("writeLegend")}</legend>
              <CheckField label={t("writeEnable")} checked={form.writeEnabled} onChange={(v) => setForm((f) => ({ ...f, writeEnabled: v, allowedWriteDatabases: v && !f.allowedWriteDatabases ? f.databaseName : f.allowedWriteDatabases, outboundCustomers: v ? f.outboundCustomers : false }))} />
              {form.writeEnabled && (
                <div className="mt-3 space-y-3">
                  <p className="text-sm text-warning-600 dark:text-warning-500">{t("writeWarning")}</p>
                  <TextField label={t("writeDatabases")} required value={form.allowedWriteDatabases} onChange={(v) => set("allowedWriteDatabases", v)} hint={t("writeDatabasesHint")} error={fieldError("allowedWriteDatabases")} />
                  <CheckField label={t("writeCustomers")} checked={form.outboundCustomers} onChange={(v) => set("outboundCustomers", v)} hint={t("writeCustomersHint")} />
                  {fieldError("outbound") && <p className="text-xs text-error-500">{fieldError("outbound")}</p>}
                </div>
              )}
            </fieldset>

            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" size="sm" onClick={() => setEditing(null)}>{t("cancel")}</Button>
              <Button size="sm" disabled={busy || !form.name.trim() || !form.host.trim() || !form.databaseName.trim() || !form.username.trim() || (!editing.id && (!form.connectorId.trim() || !form.password))} onClick={save}>{t("save")}</Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={!!deleting} busy={busy} danger title={t("connDeleteTitle")} message={t("connDeleteMessage", { name: deleting?.name ?? "" })} confirmLabel={t("delete")}
        onCancel={() => setDeleting(null)} onConfirm={() => deleting && remove(deleting)} />
    </Card>
  );
}
