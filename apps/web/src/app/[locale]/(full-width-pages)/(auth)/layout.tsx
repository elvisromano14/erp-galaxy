import GridShape from "@/components/common/GridShape";
import ThemeTogglerTwo from "@/components/common/ThemeTogglerTwo";
import { getTranslations } from "next-intl/server";
import React from "react";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("auth");
  return (
    <div className="relative z-1 bg-white p-6 dark:bg-gray-900 sm:p-0">
      <div className="relative flex h-screen w-full flex-col justify-center dark:bg-gray-900 sm:p-0 lg:flex-row">
        {children}
        <div className="hidden h-full w-full items-center bg-brand-950 lg:grid lg:w-1/2 dark:bg-white/5">
          <div className="relative z-1 flex items-center justify-center">
            <GridShape />
            <div className="flex max-w-xs flex-col items-center">
              <div className="mb-4 flex items-center gap-3 text-title-md font-semibold text-white">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500 text-lg font-bold">ERP</span>
                {t("brand")}
              </div>
              <p className="text-center text-gray-400 dark:text-white/60">{t("tagline")}</p>
            </div>
          </div>
        </div>
        <div className="fixed bottom-6 end-6 z-50 hidden sm:block">
          <ThemeTogglerTwo />
        </div>
      </div>
    </div>
  );
}
