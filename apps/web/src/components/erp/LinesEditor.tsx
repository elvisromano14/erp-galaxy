"use client";

import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { TrashBinIcon } from "@/icons";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/utils";
import { useTranslations } from "next-intl";
import { AsyncPicker, type LabelFn } from "./RefSelect";
import { NativeSelect, type Option } from "./FormFields";

export type Line = Record<string, any> & { _key: string };

export interface LineCol {
  key: string;
  header: string;
  kind: "product" | "decimal" | "text" | "date" | "readonly" | "select";
  align?: "end";
  className?: string;
  /** Para `readonly`: cómo mostrar el valor. */
  format?: (line: Line) => React.ReactNode;
  options?: Option[];
  /** Si devuelve false, la celda se muestra como texto (p. ej. lote solo si el producto lo requiere). */
  editable?: (line: Line) => boolean;
  placeholder?: string;
}

export const productLabel: LabelFn = (r) => `${r.sku} — ${r.name}`;
let counter = 0;
export const newKey = () => `l${++counter}-${Date.now()}`;

/** Rejilla de líneas editable (compras, inventario). Todo valor decimal es texto; el servidor recalcula y manda. */
export default function LinesEditor({ columns, lines, onChange, readOnly, onProductPick, productQuery, footer }: {
  columns: LineCol[];
  lines: Line[];
  onChange: (lines: Line[]) => void;
  readOnly?: boolean;
  onProductPick?: (index: number, product: Record<string, any>) => Partial<Line> | void;
  productQuery?: Record<string, string>;
  footer?: React.ReactNode;
}) {
  const t = useTranslations("common");
  const upd = (i: number, patch: Partial<Line>) => onChange(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const input = "h-10 w-full rounded-lg border border-gray-300 bg-transparent px-3 text-sm text-gray-800 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90";

  return (
    <div>
      <div className="max-w-full overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <Table>
          <TableHeader className="border-b border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-white/3">
            <TableRow>
              <TableCell isHeader className="w-10 px-3 py-3 text-start text-theme-xs font-medium text-gray-500">#</TableCell>
              {columns.map((c) => (
                <TableCell key={c.key} isHeader className={cn("px-3 py-3 text-theme-xs font-medium whitespace-nowrap text-gray-500 dark:text-gray-400", c.align === "end" ? "text-end" : "text-start", c.className)}>
                  {c.header}
                </TableCell>
              ))}
              {!readOnly && <TableCell isHeader className="w-10 px-3 py-3">{""}</TableCell>}
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y divide-gray-100 dark:divide-gray-800">
            {lines.map((l, i) => (
              <TableRow key={l._key}>
                <TableCell className="px-3 py-2 text-theme-xs text-gray-400">{i + 1}</TableCell>
                {columns.map((c) => {
                  const editable = !readOnly && c.kind !== "readonly" && (c.editable ? c.editable(l) : true);
                  const value = l[c.key] ?? "";
                  return (
                    <TableCell key={c.key} className={cn("px-3 py-2 align-top text-theme-sm text-gray-700 dark:text-gray-300", c.align === "end" && "text-end", c.className)}>
                      {c.kind === "readonly" ? (
                        <span className="tabular-nums">{c.format ? c.format(l) : String(value || "—")}</span>
                      ) : !editable ? (
                        <span className={cn(c.kind === "decimal" && "tabular-nums")}>{c.kind === "product" ? l.productLabel : c.kind === "decimal" ? fmtNumber(value, 0, 6) : c.kind === "select" ? (c.options?.find((o) => o.value === value)?.label ?? "—") : String(value || "—")}</span>
                      ) : c.kind === "product" ? (
                        <AsyncPicker
                          resource="/products"
                          value={l.productLabel ?? ""}
                          labelFn={productLabel}
                          placeholder={c.placeholder}
                          extraQuery={{ isActive: "true", ...productQuery }}
                          inputClassName="h-10"
                          onPick={(row) => upd(i, { productId: row.id, productLabel: productLabel(row), product: row, ...(onProductPick?.(i, row) ?? {}) })}
                        />
                      ) : c.kind === "decimal" ? (
                        <input
                          inputMode="decimal"
                          value={value}
                          aria-label={c.header}
                          onChange={(e) => upd(i, { [c.key]: e.target.value.replace(",", ".").replace(/[^0-9.]/g, "") })}
                          className={cn(input, "text-end tabular-nums")}
                        />
                      ) : c.kind === "date" ? (
                        <input type="date" value={value} aria-label={c.header} onChange={(e) => upd(i, { [c.key]: e.target.value })} className={input} />
                      ) : c.kind === "select" ? (
                        <NativeSelect value={value} onChange={(v) => upd(i, { [c.key]: v })} options={c.options ?? []} className="h-10" />
                      ) : (
                        <input value={value} aria-label={c.header} onChange={(e) => upd(i, { [c.key]: e.target.value })} className={input} />
                      )}
                    </TableCell>
                  );
                })}
                {!readOnly && (
                  <TableCell className="px-3 py-2 align-middle">
                    <button type="button" aria-label={t("delete")} title={t("delete")} className="text-gray-400 hover:text-error-500" onClick={() => onChange(lines.filter((_, idx) => idx !== i))}>
                      <TrashBinIcon />
                    </button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {lines.length === 0 && <p className="py-6 text-center text-sm text-gray-500">{t("noLines")}</p>}
      </div>
      {!readOnly && (
        <button type="button" onClick={() => onChange([...lines, { _key: newKey() }])} className="mt-3 text-sm font-medium text-brand-500 hover:text-brand-600">
          + {t("addLine")}
        </button>
      )}
      {footer}
    </div>
  );
}
