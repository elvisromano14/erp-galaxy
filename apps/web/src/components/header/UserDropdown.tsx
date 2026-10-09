"use client";

import { useAuth } from "@/context/AuthContext";
import { useRouter } from "@/i18n/navigation";
import { ChevronDownIcon } from "@/icons";
import { cn } from "@/utils";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Dropdown } from "../ui/dropdown/Dropdown";
import { DropdownItem } from "../ui/dropdown/DropdownItem";

export default function UserDropdown() {
  const t = useTranslations("userDropdown");
  const { me, selectCompany, logout } = useAuth();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const close = () => setIsOpen(false);

  if (!me) return null;
  const initials = me.user.fullName.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="relative">
      <button onClick={() => setIsOpen(!isOpen)} className="dropdown-toggle flex items-center text-gray-700 dark:text-gray-400">
        <span className="me-3 flex h-11 w-11 items-center justify-center overflow-hidden rounded-full bg-brand-50 text-sm font-semibold text-brand-500 dark:bg-brand-500/15 dark:text-brand-400">
          {initials}
        </span>
        <span className="me-1 hidden text-theme-sm font-medium sm:block">{me.user.fullName}</span>
        <ChevronDownIcon className={cn("stroke-gray-500 transition-transform duration-200 dark:stroke-gray-400", isOpen && "rotate-180")} />
      </button>

      <Dropdown isOpen={isOpen} onClose={close} className="absolute inset-e-0 mt-4.25 flex w-72 flex-col rounded-2xl border border-gray-200 bg-white p-3 shadow-theme-lg dark:border-gray-800 dark:bg-gray-dark">
        <div className="px-3 pb-2">
          <span className="block text-theme-sm font-medium text-gray-700 dark:text-gray-400">{me.user.fullName}</span>
          <span className="mt-0.5 block text-theme-xs text-gray-500 dark:text-gray-400">{me.user.email}</span>
          {me.roles.length > 0 && <span className="mt-1 block text-theme-xs text-brand-500">{me.roles.map((r) => r.name).join(", ")}</span>}
        </div>
        {me.companies.length > 1 && (
          <div className="border-t border-gray-200 py-2 dark:border-gray-800">
            <p className="px-3 pb-1 text-theme-xs uppercase text-gray-400">{t("switchCompany")}</p>
            <ul className="flex flex-col gap-1">
              {me.companies.map((c) => (
                <li key={c.id}>
                  <DropdownItem
                    onItemClick={async () => {
                      close();
                      if (c.id !== me.company?.id) {
                        await selectCompany(c.id);
                        router.push("/");
                      }
                    }}
                    className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-theme-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5", c.id === me.company?.id && "bg-brand-50 text-brand-500 dark:bg-brand-500/10")}
                  >
                    {c.tradeName ?? c.legalName}
                  </DropdownItem>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="border-t border-gray-200 pt-2 dark:border-gray-800">
          <button
            onClick={async () => {
              close();
              await logout();
              router.replace("/signin");
            }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-theme-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5"
          >
            {t("signOut")}
          </button>
        </div>
      </Dropdown>
    </div>
  );
}
