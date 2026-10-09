"use client";

import { useAuth } from "@/context/AuthContext";
import { useSidebar } from "@/context/SidebarContext";
import { useRouter } from "@/i18n/navigation";
import AppHeader from "@/layout/AppHeader";
import AppSidebar from "@/layout/AppSidebar";
import Backdrop from "@/layout/Backdrop";
import { useTranslations } from "next-intl";
import React, { useEffect } from "react";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { isExpanded, isHovered, isMobileOpen } = useSidebar();
  const { status } = useAuth();
  const router = useRouter();
  const t = useTranslations("common");

  useEffect(() => {
    if (status === "anonymous") router.replace("/signin");
    if (status === "needs-company") router.replace("/select-company");
  }, [status, router]);

  if (status !== "ready") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-gray-500 dark:text-gray-400" role="status">
        {t("loading")}
      </div>
    );
  }

  const mainContentMargin = isMobileOpen ? "ms-0" : isExpanded || isHovered ? "lg:ms-[290px]" : "lg:ms-[90px]";

  return (
    <div className="min-h-screen xl:flex">
      <AppSidebar />
      <Backdrop />
      <div className={`flex-1 transition-all duration-300 ease-in-out ${mainContentMargin}`}>
        <AppHeader />
        <div className="mx-auto max-w-(--breakpoint-2xl) p-4 md:p-6">{children}</div>
      </div>
    </div>
  );
}
