"use client";

import { Card, ErrorBox, Loading, PageHeader } from "@/components/erp/ui";
import { useFetch } from "@/components/erp/useFetch";
import { Link } from "@/i18n/navigation";
import { notFound, useParams } from "next/navigation";
import { useTranslations } from "next-intl";

type Def = { category: string; id: string; title: string; description: string; required: string[] };
const CATEGORIES = ["inventory", "categories", "suppliers", "purchases", "customers", "sellers", "sales", "fiscal"];

export default function ReportCategoryPage() {
  const { category } = useParams<{ category: string }>();
  const t = useTranslations();
  const catalog = useFetch<Def[]>("/reports");
  if (!CATEGORIES.includes(category)) notFound();
  const defs = (catalog.data ?? []).filter((d) => d.category === category);

  return (
    <div>
      <PageHeader title={t("reports.title", { category: t(`reports.cat.${category}`) })} subtitle={t("reports.subtitle")} />
      <ErrorBox error={catalog.error} />
      {catalog.loading && !catalog.data ? <Loading /> : defs.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-500">{t("reports.none")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {defs.map((d) => (
            <Link key={d.id} href={`/reports/${category}/${d.id}`} className="block">
              <Card className="h-full transition hover:border-brand-300">
                <h3 className="mb-1 text-base font-medium text-gray-800 dark:text-white/90">{d.title}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{d.description}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
