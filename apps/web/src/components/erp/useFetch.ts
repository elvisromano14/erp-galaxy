"use client";

import { ApiError, api, type ApiMeta } from "@/lib/api";
import { useCallback, useEffect, useRef, useState } from "react";

type Query = Record<string, string | number | boolean | undefined | null>;

export interface FetchState<T> {
  data: T | null;
  meta: ApiMeta | undefined;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

/** Carga un recurso de la API; se repite cuando cambia la ruta o la consulta. Ignora respuestas obsoletas. */
export function useFetch<T = unknown>(path: string | null, query?: Query): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<ApiMeta | undefined>();
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const key = JSON.stringify(query ?? {});

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    api<T>(path, { query: JSON.parse(key) })
      .then((r) => {
        if (mine !== seq.current) return;
        setData(r.data);
        setMeta(r.meta);
        setError(null);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setError(e instanceof ApiError ? e : new ApiError(0, "NETWORK", String(e)));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [path, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, meta, loading, error, reload };
}
