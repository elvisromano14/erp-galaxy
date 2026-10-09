"use client";

import Button from "@/components/ui/button/Button";
import { useAuth } from "@/context/AuthContext";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export default function SelectCompanyPage() {
  const t = useTranslations("auth");
  const { status, me, selectCompany, logout } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (status === "anonymous") router.replace("/signin");
    if (status === "ready") router.replace("/");
  }, [status, router]);

  if (!me) return null;

  return (
    <div className="flex w-full flex-1 flex-col lg:w-1/2">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <h1 className="mb-2 text-title-sm font-semibold text-gray-800 sm:text-title-md dark:text-white/90">{t("selectCompany")}</h1>
        <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">{t("selectCompanyHint")}</p>
        {me.companies.length === 0 && <p className="mb-4 text-sm text-error-500">{t("noCompanies")}</p>}
        {[...new Set(me.companies.map((c) => c.organizationName))].map((org) => (
          <section key={org} className="mb-5">
            {(me.user.isSuperAdmin || me.companies.some((c) => c.organizationName !== org)) && (
              <h2 className="mb-2 text-xs font-medium uppercase text-gray-400">{org}</h2>
            )}
            <ul className="flex flex-col gap-3">
              {me.companies.filter((c) => c.organizationName === org).map((c) => (
                <li key={c.id}>
                  <button
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy(c.id);
                      try {
                        await selectCompany(c.id);
                        router.replace("/");
                      } finally {
                        setBusy(null);
                      }
                    }}
                    className="w-full rounded-xl border border-gray-200 p-4 text-start transition hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50 dark:border-gray-800 dark:hover:bg-brand-500/10"
                  >
                    <span className="block text-sm font-medium text-gray-800 dark:text-white/90">{c.tradeName ?? c.legalName}</span>
                    <span className="block text-theme-xs text-gray-500 dark:text-gray-400">{c.rif}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await logout();
            router.replace("/signin");
          }}
        >
          {t("signOut")}
        </Button>
      </div>
    </div>
  );
}
