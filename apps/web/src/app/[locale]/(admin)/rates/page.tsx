"use client";

import DataTable, { type Column } from "@/components/erp/DataTable";
import { Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import Badge from "@/components/ui/badge/Badge";
import { useAuth } from "@/context/AuthContext";
import { Link } from "@/i18n/navigation";
import { fmtDate, fmtDateTime, fmtNumber } from "@/lib/format";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;
interface CurrencySummary {
  currencyId: string; code: string; name: string; symbol: string;
  rate: string | null; date: string | null; source: string | null;
  previousRate: string | null; previousDate: string | null; changePct: number | null;
  lastBcv: { rate: string; date: string; loadedAt: string } | null;
  series: { date: string; rate: string; source: string }[];
}
interface Summary { today: string; autoSync: boolean; intervalMinutes: number; currencies: CurrencySummary[] }

/** Línea de evolución de los últimos días (SVG, sin dependencias). */
function Spark({ points, label }: { points: { date: string; rate: string }[]; label: string }) {
  if (points.length < 2) return <p className="text-theme-xs text-gray-400">—</p>;
  const w = 320, h = 72, pad = 6;
  const v = points.map((p) => Number(p.rate));
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const xy = v.map((y, i) => [pad + (i * (w - pad * 2)) / (v.length - 1), h - pad - ((y - min) / span) * (h - pad * 2)] as const);
  const last = xy[xy.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="h-20 w-full">
      <polyline points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="text-brand-500" />
      <circle cx={last[0]} cy={last[1]} r="3.5" className="fill-brand-500" />
    </svg>
  );
}

export default function RatesPage() {
  const t = useTranslations();
  const { can } = useAuth();
  const summary = useFetch<Summary>("/exchange-rates/summary");
  const [page, setPage] = useState(1);
  const [currencyId, setCurrencyId] = useState("");
  const history = useFetch<Row[]>("/exchange-rates", { page, limit: 15, currencyId: currencyId || undefined });
  const s = summary.data;
  const code = (id: string) => s?.currencies.find((c) => c.currencyId === id)?.code ?? "";

  if (summary.loading && !s) return <Loading />;

  const columns: Column<Row>[] = [
    { key: "date", header: t("fields.date"), render: (r) => fmtDate(r.date) },
    { key: "currencyId", header: t("fields.currency"), render: (r) => code(r.currencyId) },
    { key: "rate", header: t("fx.rate"), align: "end", render: (r) => fmtNumber(r.rate, 2, 4) },
    { key: "source", header: t("fields.source"), render: (r) => <Badge size="sm" color={r.source === "BCV" ? "primary" : "warning"}>{r.source === "BCV" ? t("fx.sourceBcv") : t("fx.sourceManual")}</Badge> },
    { key: "createdAt", header: t("rates.loadedAt"), render: (r) => fmtDateTime(r.createdAt) },
  ];

  return (
    <div>
      <PageHeader
        title={t("rates.title")}
        subtitle={s ? t(s.autoSync ? "rates.subtitleAuto" : "rates.subtitleManual", { hours: Math.round((s.intervalMinutes / 60) * 10) / 10 }) : undefined}
        actions={can("admin:exchange-rates:create") && <Link href="/admin/exchange-rates" className="text-sm font-medium text-brand-500 hover:text-brand-600">{t("rates.manage")}</Link>}
      />
      <ErrorBox error={summary.error} />

      {s && s.currencies.length === 0 && <Card><p className="text-sm text-gray-500">{t("rates.empty")}</p></Card>}

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {s?.currencies.map((c) => {
          const up = (c.changePct ?? 0) > 0, down = (c.changePct ?? 0) < 0;
          return (
            <Card key={c.currencyId} title={`${c.code} — ${c.name}`}>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-theme-xs text-gray-500">{t("rates.current")}</p>
                  <p className="text-3xl font-semibold tabular-nums text-gray-800 dark:text-white/90">Bs {c.rate ? fmtNumber(c.rate, 2, 4) : "—"}</p>
                  {c.date && <p className="text-theme-xs text-gray-500">{t("rates.validFor", { date: fmtDate(c.date) })}</p>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  {c.source && <Badge size="sm" color={c.source === "BCV" ? "primary" : "warning"}>{c.source === "BCV" ? t("fx.sourceBcv") : t("fx.sourceManual")}</Badge>}
                  {c.changePct !== null && (
                    <span className={up ? "text-sm font-medium text-error-600" : down ? "text-sm font-medium text-success-600" : "text-sm text-gray-500"}>
                      {up ? "▲" : down ? "▼" : "•"} {fmtNumber(Math.abs(c.changePct), 2, 2)} %
                    </span>
                  )}
                  {c.previousRate && <span className="text-theme-xs text-gray-500">{t("rates.previous", { rate: fmtNumber(c.previousRate, 2, 4), date: fmtDate(c.previousDate) })}</span>}
                </div>
              </div>
              <div className="mt-3"><Spark points={c.series} label={t("rates.chartLabel", { code: c.code })} /></div>
              <p className="mt-1 text-theme-xs text-gray-500">
                {c.lastBcv ? t("rates.lastBcv", { rate: fmtNumber(c.lastBcv.rate, 2, 4), date: fmtDate(c.lastBcv.date), at: fmtDateTime(c.lastBcv.loadedAt) }) : t("rates.noBcv")}
              </p>
            </Card>
          );
        })}
      </div>

      <Card title={t("rates.history")}>
        <div className="mb-4 max-w-xs">
          <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-400" htmlFor="rates-cur">{t("fields.currency")}</label>
          <select id="rates-cur" value={currencyId} onChange={(e) => (setCurrencyId(e.target.value), setPage(1))} className="h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-white/90">
            <option value="">{t("common.all")}</option>
            {s?.currencies.map((c) => <option key={c.currencyId} value={c.currencyId}>{c.code}</option>)}
          </select>
        </div>
        <ErrorBox error={history.error} />
        <DataTable columns={columns} rows={history.data} loading={history.loading} rowKey={(r) => r.id} meta={history.meta} onPage={setPage} />
      </Card>
    </div>
  );
}
