"use client";

import { api } from "@/lib/api";
import { cn } from "@/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { FieldShell, NativeSelect, type Option } from "./FormFields";
import { useFetch } from "./useFetch";

type Row = Record<string, any>;
export type LabelFn = (row: Row) => string;

/** Opciones de un catálogo pequeño (hasta 100 filas), cacheadas por sesión de página. */
export function useOptions(resource: string | null, label: string | LabelFn, filter?: Record<string, string>) {
  const { data, loading } = useFetch<Row[]>(resource, { limit: 100, ...(filter ? Object.fromEntries(Object.entries(filter).map(([k, v]) => [`filter[${k}]`, v])) : {}) });
  const options = useMemo<Option[]>(
    () => (data ?? []).map((r) => ({ value: r.id as string, label: typeof label === "function" ? label(r) : String(r[label] ?? r.id) })),
    [data, label],
  );
  return { options, loading, rows: data ?? [] };
}

export function RefSelect({ label, required, error, hint, disabled, className, value, onChange, resource, labelKey, filter, placeholder }: {
  label: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  disabled?: boolean;
  className?: string;
  value: string;
  onChange: (v: string) => void;
  resource: string;
  labelKey: string | LabelFn;
  filter?: Record<string, string>;
  placeholder?: string;
}) {
  const { options } = useOptions(resource, labelKey, filter);
  const id = `ref-${resource}-${label}`;
  return (
    <FieldShell {...{ label, required, error, hint, className }} htmlFor={id}>
      <NativeSelect id={id} value={value} onChange={onChange} options={options} disabled={disabled} error={!!error} placeholder={placeholder} />
    </FieldShell>
  );
}

/**
 * Buscador asíncrono (productos, proveedores, clientes…): consulta `?search=` al escribir.
 * Devuelve la fila completa para que el llamador use sus campos (precio, impuesto, etc.).
 */
export function AsyncPicker({ resource, value, onPick, labelFn, placeholder, disabled, extraQuery, autoFocus, inputClassName }: {
  resource: string;
  value: string; // texto mostrado
  onPick: (row: Row) => void;
  labelFn: LabelFn;
  placeholder?: string;
  disabled?: boolean;
  extraQuery?: Record<string, string>;
  autoFocus?: boolean;
  inputClassName?: string;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => setText(value), [value]);

  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    const h = setTimeout(() => {
      api<Row[]>(resource, { query: { search: text, limit: 10, ...extraQuery } })
        .then((r) => mine === seq.current && (setRows(r.data), setActive(0)))
        .catch(() => undefined);
    }, 200);
    return () => clearTimeout(h);
  }, [text, open, resource, extraQuery]);

  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const pick = (r: Row) => {
    onPick(r);
    setText(labelFn(r));
    setOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <input
        autoFocus={autoFocus}
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, rows.length - 1)));
          if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          if (e.key === "Enter" && open && rows[active]) (e.preventDefault(), pick(rows[active]));
          if (e.key === "Escape") setOpen(false);
        }}
        className={cn(
          "h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90",
          inputClassName,
        )}
      />
      {open && rows.length > 0 && (
        <ul role="listbox" className="absolute z-50 mt-1 max-h-64 w-full min-w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-theme-lg dark:border-gray-700 dark:bg-gray-dark">
          {rows.map((r, i) => (
            <li
              key={r.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => (e.preventDefault(), pick(r))}
              className={cn("cursor-pointer rounded-md px-3 py-2 text-sm text-gray-700 dark:text-gray-300", i === active && "bg-brand-50 dark:bg-brand-500/10")}
            >
              {labelFn(r)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Campo de formulario con buscador asíncrono (muestra la etiqueta de la selección actual). */
export function AsyncRefField({ label, required, error, hint, disabled, className, value, display, onPick, resource, labelFn, placeholder }: {
  label: string; required?: boolean; error?: string | null; hint?: string; disabled?: boolean; className?: string;
  value: string; display: string; onPick: (row: Row) => void; resource: string; labelFn: LabelFn; placeholder?: string;
}) {
  const id = `async-${resource}`;
  return (
    <FieldShell {...{ label, required, error, hint, className }} htmlFor={id}>
      <AsyncPicker resource={resource} value={display} onPick={onPick} labelFn={labelFn} placeholder={placeholder} disabled={disabled} />
      <input type="hidden" value={value} readOnly />
    </FieldShell>
  );
}
