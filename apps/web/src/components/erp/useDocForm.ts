"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { type Dispatch, type SetStateAction, useCallback, useState } from "react";
import { type FieldErrors, type FieldValues, type Path, type PathValue, useForm } from "react-hook-form";
import type { z } from "zod";
import { newKey } from "./LinesEditor";

type LineLike = { _key: string } & Record<string, any>;

/**
 * Formulario de documento con React Hook Form: cabecera + rejilla de líneas en el MISMO formulario, validado con Zod.
 * Expone `h`/`setH` y `lines`/`setLines` con la forma de `useState`, de modo que el editor conserve su lógica (tasa del día, precios,
 * conversiones) y el estado, la validación y los errores vivan en RHF. `check()` valida todo y muestra los errores de campo.
 */
export function useDocForm<H extends FieldValues, L extends LineLike = LineLike>(defaults: H, schema: z.ZodTypeAny) {
  type V = H & { lines: L[] };
  const form = useForm<V>({ defaultValues: { ...defaults, lines: [{ _key: newKey() }] } as never, resolver: zodResolver(schema as never) as never, mode: "onSubmit" });
  const all = form.watch() as V;
  const h = all as H;
  const lines = (all.lines ?? []) as L[];
  // Tras el primer intento de guardar, los campos se revalidan en cada cambio (los errores se limpian al corregir).
  const [attempted, setAttempted] = useState(false);
  const revalidate = attempted;

  const setH: Dispatch<SetStateAction<H>> = useCallback((u) => {
    const cur = form.getValues() as unknown as H;
    const next = typeof u === "function" ? (u as (s: H) => H)(cur) : u;
    for (const [k, v] of Object.entries(next)) {
      if (k !== "lines" && (cur as Record<string, unknown>)[k] !== v) form.setValue(k as Path<V>, v as PathValue<V, Path<V>>, { shouldDirty: true, shouldValidate: revalidate });
    }
  }, [form, revalidate]);

  const setLines: Dispatch<SetStateAction<L[]>> = useCallback((u) => {
    const next = typeof u === "function" ? (u as (s: L[]) => L[])((form.getValues("lines" as Path<V>) as L[]) ?? []) : u;
    form.setValue("lines" as Path<V>, next as PathValue<V, Path<V>>, { shouldDirty: true, shouldValidate: revalidate });
  }, [form, revalidate]);

  const errors = form.formState.errors as FieldErrors<FieldValues>;
  /** Mensaje de un campo de la cabecera (`customerId`). */
  const errorOf = (name: string): string | null => {
    const e = (errors as Record<string, { message?: string }>)[name];
    return e?.message ?? null;
  };
  /** Mensajes de las líneas y de la regla general de líneas («Agregue al menos un producto»). */
  const lineIssues = (): string[] => {
    const e = errors.lines as unknown;
    if (!e) return [];
    const out: string[] = [];
    const walk = (x: unknown) => {
      if (!x || typeof x !== "object") return;
      const o = x as { message?: unknown } & Record<string, unknown>;
      if (typeof o.message === "string") out.push(o.message);
      for (const [k, v] of Object.entries(o)) if (k !== "message" && k !== "ref" && k !== "type") walk(v);
    };
    walk(e);
    return [...new Set(out)];
  };
  /** Valida cabecera y líneas; devuelve `true` si todo es válido. */
  const check = async () => { setAttempted(true); return form.trigger(); };
  const reset = (values: H & { lines?: L[] }) => form.reset({ ...values, lines: values.lines ?? [{ _key: newKey() }] } as never);
  return { form, h, setH, lines, setLines, errorOf, lineIssues, check, reset, isDirty: form.formState.isDirty };
}
