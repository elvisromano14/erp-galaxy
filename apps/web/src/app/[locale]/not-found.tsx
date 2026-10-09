"use client";

import GridShape from "@/components/common/GridShape";
import { Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

export default function NotFound() {
  const t = useTranslations("notFound");

  return (
    <div className="relative z-1 flex min-h-screen flex-col items-center justify-center overflow-hidden p-6">
      <GridShape />
      <div className="mx-auto w-full max-w-60.5 text-center sm:max-w-118">
        <h1 className="mb-4 text-title-2xl font-bold text-gray-800 dark:text-white/90">404</h1>
        <h2 className="mb-4 text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("error")}</h2>
        <p className="mb-6 text-base text-gray-700 sm:text-lg dark:text-gray-400">{t("message")}</p>
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-5 py-3.5 text-sm font-medium text-gray-700 shadow-theme-xs hover:bg-gray-50 hover:text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-white/3 dark:hover:text-gray-200"
        >
          {t("back")}
        </Link>
      </div>
    </div>
  );
}
