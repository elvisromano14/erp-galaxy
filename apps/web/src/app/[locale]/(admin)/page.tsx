"use client";

import { Card, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import { useAuth } from "@/context/AuthContext";
import { Link } from "@/i18n/navigation";
import { fmtMoney } from "@/lib/format";
import { useTranslations } from "next-intl";

function Metric({ label, value, href }: { label: string; value: React.ReactNode; href?: string }) {
  const body = (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 transition hover:border-brand-300 dark:border-gray-800 dark:bg-white/3">
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-2 text-title-sm font-semibold tabular-nums text-gray-800 dark:text-white/90">{value}</p>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

interface Alert { code: string; severity: "info" | "warning" | "critical"; count: number; amountBase?: string; link: string; sample: Record<string, string>[] }
const SEVERITY_STYLE = {
  critical: "border-error-200 bg-error-50 text-error-700 dark:border-error-500/30 dark:bg-error-500/10 dark:text-error-400",
  warning: "border-warning-200 bg-warning-50 text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-orange-400",
  info: "border-blue-light-200 bg-blue-light-50 text-blue-light-700 dark:border-blue-light-500/30 dark:bg-blue-light-500/10 dark:text-blue-light-400",
} as const;

export default function Dashboard() {
  const t = useTranslations("dashboard");
  const { me, can } = useAuth();
  const products = useFetch<unknown[]>(can("admin:products:read") ? "/products" : null, { limit: 1 });
  const suppliers = useFetch<unknown[]>(can("admin:suppliers:read") ? "/suppliers" : null, { limit: 1 });
  const customers = useFetch<unknown[]>(can("admin:customers:read") ? "/customers" : null, { limit: 1 });
  const valuation = useFetch<{ totalValue: string }>(can("inventory:valuation:read") ? "/inventory/valuation" : null);
  const low = useFetch<Record<string, string>[]>(can("inventory:stock:read") ? "/inventory/stock" : null, { belowMin: true, limit: 5 });
  const alerts = useFetch<Alert[]>("/alerts");
  const salesOrders = useFetch<unknown[]>(can("sales:orders:read") ? "/sales/orders" : null, { status: "CONFIRMED", limit: 1 });
  const openOrders = useFetch<unknown[]>(can("purchases:orders:read") ? "/purchases/orders" : null, { status: "CONFIRMED,PARTIALLY_FULFILLED", limit: 1 });

  return (
    <div>
      <PageHeader title={t("title", { company: me?.company?.tradeName ?? me?.company?.legalName ?? "" })} subtitle={t("subtitle")} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {products.meta && <Metric label={t("products")} value={products.meta.total} href="/admin/products" />}
        {suppliers.meta && <Metric label={t("suppliers")} value={suppliers.meta.total} href="/admin/suppliers" />}
        {customers.meta && <Metric label={t("customers")} value={customers.meta.total} href="/admin/customers" />}
        {valuation.data && <Metric label={t("inventoryValue")} value={fmtMoney(valuation.data.totalValue)} href="/inventory/valuation" />}
        {openOrders.meta && <Metric label={t("openOrders")} value={openOrders.meta.total} href="/purchases/orders" />}
        {salesOrders.meta && <Metric label={t("salesOrders")} value={salesOrders.meta.total} href="/sales/orders" />}
      </div>
      {(alerts.data?.length ?? 0) > 0 && (
        <Card title={t("alertsTitle")} className="mt-6">
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {alerts.data!.map((a) => (
              <li key={a.code}>
                <Link href={a.link} className={`block rounded-xl border p-4 transition hover:opacity-90 ${SEVERITY_STYLE[a.severity]}`}>
                  <p className="text-sm font-semibold">{t(`alerts.${a.code}`, { count: a.count })}</p>
                  {a.amountBase && <p className="mt-1 text-xs tabular-nums">{t("alertAmount")}: {fmtMoney(a.amountBase)}</p>}
                  {a.sample.length > 0 && <p className="mt-1 truncate text-xs opacity-80">{a.sample.map((r) => r.sku ?? r.number ?? r.customer).join(" · ")}</p>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {low.data && (
        <Card title={t("belowMin")} className="mt-6">
          {low.data.length === 0 ? (
            <p className="text-sm text-gray-500">{t("noneBelowMin")}</p>
          ) : (
            <ul className="divide-y divide-gray-100 text-sm dark:divide-gray-800">
              {low.data.map((r, i) => (
                <li key={i} className="flex justify-between py-2">
                  <span className="text-gray-700 dark:text-gray-300">{r.sku} — {r.name} ({r.warehouseCode})</span>
                  <span className="tabular-nums text-error-500">{Number(r.quantity)} / {Number(r.minStock)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
