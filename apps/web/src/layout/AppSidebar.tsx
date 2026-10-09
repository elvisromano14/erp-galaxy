"use client";

import { useAuth } from "@/context/AuthContext";
import { useSidebar } from "@/context/SidebarContext";
import { Link, usePathname } from "@/i18n/navigation";
import { BoxCubeIcon, BoxIcon, ChevronDownIcon, FileIcon, GridIcon, HorizontaLDots, ListIcon, PlugInIcon } from "@/icons";
import { cn } from "@/utils";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { NAV, type NavSection } from "./nav";

const ICONS: Record<NavSection["icon"], React.ReactNode> = {
  grid: <GridIcon />,
  box: <BoxIcon />,
  cube: <BoxCubeIcon />,
  cart: <ListIcon />,
  settings: <PlugInIcon />,
  report: <FileIcon />,
};

const AppSidebar: React.FC = () => {
  const { isExpanded, isMobileOpen, isHovered, setIsHovered } = useSidebar();
  const pathname = usePathname();
  const t = useTranslations("sidebar");
  const { can, feature, me } = useAuth();
  const [opened, setOpened] = useState<string | null>(null);

  const sections = useMemo(
    () =>
      NAV.map((s) => ({ ...s, items: s.items.filter((i) => (!i.perm || can(i.perm)) && (!i.feature || feature(i.feature)) && (!i.flag || (i.flag === "superAdmin" ? !!me?.user.isSuperAdmin : !!me?.canCreateCompanies))) })).filter(
        (s) => s.items.length > 0,
      ),
    [can, feature, me],
  );

  const isActive = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const showLabels = isExpanded || isHovered || isMobileOpen;
  // Abre por defecto la sección de la ruta actual.
  const current = sections.find((s) => s.items.some((i) => isActive(i.path)))?.key ?? null;
  const open = opened ?? current;

  return (
    <aside
      className={cn(
        "fixed top-0 start-0 z-50 flex h-full flex-col border-e border-gray-200 bg-white px-5 text-gray-900 transition-all duration-300 ease-in-out dark:border-gray-800 dark:bg-gray-900",
        isExpanded || isMobileOpen || isHovered ? "w-72.5" : "w-22.5",
        isMobileOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full",
        "xl:translate-x-0 xl:rtl:translate-x-0",
      )}
      onMouseEnter={() => !isExpanded && setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className={cn("flex py-8", !isExpanded && !isHovered ? "xl:justify-center" : "justify-start")}>
        <Link href="/" className="flex items-center gap-2 text-title-sm font-semibold text-gray-800 dark:text-white/90">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">ERP</span>
          {showLabels && <span>{t("brand")}</span>}
        </Link>
      </div>
      <div className="no-scrollbar flex flex-col overflow-y-auto duration-300 ease-linear">
        <nav className="mb-6">
          <h2 className={cn("mb-4 flex text-xs leading-5 text-gray-400 uppercase", !showLabels ? "xl:justify-center" : "justify-start")}>
            {showLabels ? t("menu") : <HorizontaLDots />}
          </h2>
          <ul className="flex flex-col gap-1">
            <li>
              <Link href="/" className={cn("group menu-item", pathname === "/" ? "menu-item-active" : "menu-item-inactive")}>
                <span className={pathname === "/" ? "menu-item-icon-active" : "menu-item-icon-inactive"}>{ICONS.grid}</span>
                {showLabels && <span className="menu-item-text">{t("dashboard")}</span>}
              </Link>
            </li>
            {sections.map((s) => {
              const isOpen = open === s.key;
              return (
                <li key={s.key}>
                  <button
                    onClick={() => setOpened(isOpen ? "" : s.key)}
                    className={cn(
                      "group menu-item cursor-pointer",
                      isOpen ? "menu-item-active" : "menu-item-inactive",
                      !showLabels ? "lg:justify-center" : "lg:justify-start",
                    )}
                  >
                    <span className={isOpen ? "menu-item-icon-active" : "menu-item-icon-inactive"}>{ICONS[s.icon]}</span>
                    {showLabels && <span className="menu-item-text">{t(`sections.${s.key}`)}</span>}
                    {showLabels && (
                      <ChevronDownIcon className={cn("ms-auto h-5 w-5 transition-transform duration-200", isOpen && "rotate-180 text-brand-500")} />
                    )}
                  </button>
                  {showLabels && isOpen && (
                    <ul className="ms-9 mt-2 space-y-1">
                      {s.items.map((i) => (
                        <li key={i.key}>
                          <Link
                            href={i.path}
                            className={cn("menu-dropdown-item", isActive(i.path) ? "menu-dropdown-item-active" : "menu-dropdown-item-inactive")}
                          >
                            {t(`items.${i.key}`)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </aside>
  );
};

export default AppSidebar;
