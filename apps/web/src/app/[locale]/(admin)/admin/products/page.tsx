"use client";

import Button from "@/components/ui/button/Button";
import DataTable, { type Column } from "@/components/erp/DataTable";
import { BoolBadge, Card, ErrorBox, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import { CheckField } from "@/components/erp/FormFields";
import { useAuth } from "@/context/AuthContext";
import { useRouter } from "@/i18n/navigation";
import { PlusIcon } from "@/icons";
import { useTranslations } from "next-intl";
import { useState } from "react";

type Row = Record<string, any>;

export default function ProductsPage() {
  const t = useTranslations();
  const { can, feature } = useAuth();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [showDeleted, setShowDeleted] = useState(false);
  const list = useFetch<Row[]>("/products", { page, limit: 20, search: search || undefined, sort, includeDeleted: showDeleted || undefined });

  const columns: Column<Row>[] = [
    { key: "sku", header: t("fields.sku"), sort: "sku" },
    { key: "name", header: t("fields.name"), sort: "name" },
    ...(feature("lots") || feature("serials") ? [{ key: "trackingMode", header: t("fields.trackingMode"), render: (r: Row) => t(`enums.trackingMode.${r.trackingMode}`) }] : []),
    { key: "isService", header: t("fields.isService"), render: (r) => <BoolBadge value={r.isService} /> },
    { key: "isActive", header: t("fields.isActive"), render: (r) => <BoolBadge value={r.isActive} /> },
  ];

  return (
    <div>
      <PageHeader
        title={t("sidebar.items.products")}
        actions={
          can("admin:products:create") && (
            <Button size="sm" startIcon={<PlusIcon />} onClick={() => router.push("/admin/products/new")}>
              {t("common.new")}
            </Button>
          )
        }
      />
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => (setSearch(e.target.value), setPage(1))}
            placeholder={t("products.searchPlaceholder")}
            aria-label={t("common.search")}
            className="h-11 w-full max-w-md rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90"
          />
          <CheckField label={t("common.showDeleted")} checked={showDeleted} onChange={(v) => (setShowDeleted(v), setPage(1))} />
        </div>
        <ErrorBox error={list.error} />
        <DataTable
          columns={columns}
          rows={list.data}
          loading={list.loading}
          rowKey={(r) => r.id}
          meta={list.meta}
          onPage={setPage}
          sort={sort}
          onSort={setSort}
          onRowClick={(r) => router.push(`/admin/products/${r.id}`)}
        />
      </Card>
    </div>
  );
}
