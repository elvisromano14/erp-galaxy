"use client";

import { api, ApiError, login as apiLogin, logout as apiLogout, refreshSession, selectCompany as apiSelectCompany, setAccessToken, setSessionLostHandler, type SessionResponse } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export interface Me {
  user: { id: string; email: string; fullName: string; isSuperAdmin: boolean };
  companies: { id: string; rif: string; legalName: string; tradeName: string | null; organizationId: string; organizationName: string }[];
  isOrgAdmin: boolean;
  canCreateCompanies: boolean;
  company: { id: string; rif: string; legalName: string; tradeName: string | null; features: Record<string, boolean>; isIgtfCollector: boolean; baseCurrencyId: string; valuationCurrencyId: string } | null;
  roles: { code: string; name: string }[];
  permissions: string[];
}

type Status = "loading" | "anonymous" | "needs-company" | "ready";

interface AuthContextType {
  status: Status;
  me: Me | null;
  can: (...perms: string[]) => boolean;
  feature: (name: string) => boolean;
  login: (email: string, password: string) => Promise<SessionResponse>;
  selectCompany: (companyId: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return ctx;
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);

  const loadMe = useCallback(async () => {
    const r = await api<Me>("/auth/me");
    setMe(r.data);
    setStatus(r.data.company ? "ready" : "needs-company");
  }, []);

  // Al cargar la página: recuperar la sesión desde la cookie de refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await refreshSession();
      if (cancelled) return;
      if (!token) {
        setStatus("anonymous");
        return;
      }
      try {
        await loadMe();
      } catch {
        if (!cancelled) setStatus("anonymous");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  useEffect(() => {
    setSessionLostHandler(() => {
      setAccessToken(null);
      queryClient.clear();
      setMe(null);
      setStatus("anonymous");
    });
    return () => setSessionLostHandler(null);
  }, [queryClient]);

  const value = useMemo<AuthContextType>(() => {
    const perms = new Set(me?.permissions ?? []);
    return {
      status,
      me,
      can: (...p) => !!me && (perms.has("*") || p.every((x) => perms.has(x))),
      feature: (name) => !!me?.company?.features?.[name],
      login: async (email, password) => {
        const r = await apiLogin(email, password);
        await loadMe();
        return r;
      },
      selectCompany: async (companyId) => {
        await apiSelectCompany(companyId);
        queryClient.clear(); // nada de la empresa anterior debe quedar en caché
        await loadMe();
      },
      logout: async () => {
        await apiLogout().catch(() => undefined);
        queryClient.clear();
        setMe(null);
        setStatus("anonymous");
      },
      reload: loadMe,
    };
  }, [status, me, loadMe, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export { ApiError };
