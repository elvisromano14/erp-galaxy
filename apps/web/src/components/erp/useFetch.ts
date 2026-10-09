"use client";

import { ApiError, api, type ApiMeta } from "@/lib/api";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

type Query = Record<string, string | number | boolean | undefined | null>;

export interface FetchState<T> {
  data: T | null;
  meta: ApiMeta | undefined;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

/**
 * Lectura de la API con TanStack Query (caché, deduplicación y cancelación de respuestas obsoletas).
 * Con `path = null` la consulta queda deshabilitada. Conserva los datos anteriores mientras llegan los nuevos.
 */
export function useFetch<T = unknown>(path: string | null, query?: Query): FetchState<T> {
  const q = useQuery({
    queryKey: ["api", path, query ?? {}],
    queryFn: () => api<T>(path!, { query }),
    enabled: path !== null,
    placeholderData: keepPreviousData,
  });
  const refetch = q.refetch;
  const reload = useCallback(() => void refetch(), [refetch]);
  return {
    data: q.data?.data ?? null,
    meta: q.data?.meta,
    loading: path !== null && q.isPending,
    error: q.error ? (q.error instanceof ApiError ? q.error : new ApiError(0, "NETWORK", String(q.error))) : null,
    reload,
  };
}
