"use client";

import { api } from "@/lib/api";
import { cn } from "@/utils";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
 * La lista se dibuja en un portal (fuera de tablas y modales con `overflow`) con posición fija: nunca se recorta,
 * se abre hacia arriba si abajo no cabe y puede ser más ancha que el campo.
 */
export function AsyncPicker({ resource, value, onPick, labelFn, detailFn, placeholder, disabled, extraQuery, autoFocus, inputClassName }: {
  resource: string;
  value: string; // texto mostrado
  onPick: (row: Row) => void;
  labelFn: LabelFn;
  /** Segunda línea de cada opción (p. ej. marca · unidad). */
  detailFn?: LabelFn;
  placeholder?: string;
  disabled?: boolean;
  extraQuery?: Record<string, string>;
  autoFocus?: boolean;
  inputClassName?: string;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxH: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const seq = useRef(0);

  useEffect(() => setText(value), [value]);

  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setLoading(true);
    const h = setTimeout(() => {
      api<Row[]>(resource, { query: { search: text, limit: 20, ...extraQuery } })
        .then((r) => mine === seq.current && (setRows(r.data), setActive(0)))
        .catch(() => undefined)
        .finally(() => mine === seq.current && setLoading(false));
    }, 200);
    return () => clearTimeout(h);
  }, [text, open, resource, extraQuery]);

  // Posición de la lista respecto al campo (en coordenadas de la ventana).
  const place = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, gap = 4, margin = 8;
    const width = Math.min(Math.max(r.width, 448), vw - margin * 2);
    const left = Math.max(margin, Math.min(r.left, vw - width - margin));
    const below = vh - r.bottom - gap - margin, above = r.top - gap - margin;
    const up = below < 220 && above > below;
    setPos(up ? { left, width, bottom: vh - r.top + gap, maxH: Math.min(360, above) } : { left, width, top: r.bottom + gap, maxH: Math.min(360, below) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true); // true: también al desplazarse un contenedor interno
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, place, rows.length]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  // Mantener visible la opción activa al navegar con el teclado.
  useEffect(() => { list.current?.children[active]?.scrollIntoView({ block: "nearest" }); }, [active, rows]);

  const pick = (r: Row) => {
    onPick(r);
    setText(labelFn(r));
    setOpen(false);
  };

  const showList = open && pos && (rows.length > 0 || (!loading && text.trim() !== ""));
  return (
    <div ref={box} className="relative">
      <input
        autoFocus={autoFocus}
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setOpen(true), setActive((a) => Math.min(a + 1, rows.length - 1)));
          if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          if (e.key === "Enter" && open && rows[active]) (e.preventDefault(), pick(rows[active]));
          if (e.key === "Escape") setOpen(false);
        }}
        className={cn(
          "h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30 dark:focus:border-brand-800",
          inputClassName,
        )}
      />
      {showList && createPortal(
        <ul
          ref={list}
          role="listbox"
          style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
          className="z-[100000] overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-theme-lg dark:border-gray-700 dark:bg-gray-dark"
        >
          {rows.length === 0 && <li className="px-3 py-3 text-sm text-gray-500">—</li>}
          {rows.map((r, i) => (
            <li
              key={r.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => (e.preventDefault(), pick(r))}
              onMouseEnter={() => setActive(i)}
              className={cn("cursor-pointer rounded-md px-3 py-2 text-sm text-gray-700 dark:text-gray-300", i === active && "bg-brand-50 dark:bg-brand-500/10")}
            >
              <span className="block break-words">{labelFn(r)}</span>
              {detailFn && detailFn(r) && <span className="mt-0.5 block text-theme-xs text-gray-500 dark:text-gray-400">{detailFn(r)}</span>}
            </li>
          ))}
        </ul>,
        document.body,
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
