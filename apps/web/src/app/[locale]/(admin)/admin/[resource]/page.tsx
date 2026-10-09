"use client";

import CrudPage from "@/components/erp/CrudPage";
import { CRUD_REGISTRY } from "@/components/erp/crud-registry";
import { useAuth } from "@/context/AuthContext";
import { notFound, useParams } from "next/navigation";
import { useTranslations } from "next-intl";

export default function AdminResourcePage() {
  const { resource } = useParams<{ resource: string }>();
  const { can } = useAuth();
  const t = useTranslations("common");
  const def = CRUD_REGISTRY[resource];
  if (!def) notFound();
  if (!can(`${def.permission}:read`)) return <p className="py-10 text-center text-sm text-gray-500">{t("forbidden")}</p>;
  // `key` reinicia el estado al navegar entre catálogos.
  return <CrudPage key={resource} def={def} />;
}
