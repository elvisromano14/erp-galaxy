"use client";

import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/utils";
import { createColumnHelper, type RowData, tableFeatures, useTable } from "@tanstack/react-table";
import { useMemo } from "react";
import { Empty, Loading, Pager } from "./ui";

export interface Column<T extends RowData> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  /** Campo de ordenación del servidor (si se omite, la columna no ordena). */
  sort?: string;
  className?: string;
  align?: "start" | "end";
}

interface Props<T extends RowData> {
  columns: Column<T>[];
  rows: T[] | null;
  loading?: boolean;
  rowKey: (row: T) => string;
  meta?: { page?: number; totalPages?: number; total?: number };
  onPage?: (p: number) => void;
  sort?: string;
  onSort?: (s: string) => void;
  onRowClick?: (row: T) => void;
  emptyText?: string;
}

const features = tableFeatures({});
const EMPTY: unknown[] = [];

/**
 * Tabla con TanStack Table: el modelo de filas/columnas lo gestiona la librería; paginación y orden son del
 * servidor (manualPagination / manualSorting) y se controlan desde fuera (erp-v3 §14.2).
 */
export default function DataTable<T extends RowData>({ columns, rows, loading, rowKey, meta, onPage, sort, onSort, onRowClick, emptyText }: Props<T>) {
  // Estable entre renders (requisito de TanStack Table v9). Orden/paginación son del servidor: no se registran
  // funciones de orden/paginación en la tabla; solo su modelo de filas/columnas.
  const defs = useMemo(() => {
    const helper = createColumnHelper<typeof features, T>();
    return helper.columns(
      columns.map((c) =>
        helper.display({
          id: c.key,
          header: c.header,
          cell: ({ row }) => (c.render ? c.render(row.original) : String((row.original as Record<string, unknown>)[c.key] ?? "—")),
        }),
      ),
    );
  }, [columns]);
  const data = useMemo(() => rows ?? (EMPTY as T[]), [rows]);
  const byId = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);

  const table = useTable({ features, columns: defs, data, getRowId: (row: T) => rowKey(row) });

  return (
    <div>
      <div className="max-w-full overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <Table>
          <TableHeader className="border-b border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-white/3">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => {
                  const c = byId.get(h.column.id)!;
                  const active = c.sort && sort?.replace(/^-/, "") === c.sort;
                  return (
                    <TableCell
                      key={h.id}
                      isHeader
                      className={cn("px-4 py-3 text-theme-xs font-medium whitespace-nowrap text-gray-500 dark:text-gray-400", c.align === "end" ? "text-end" : "text-start", c.className)}
                    >
                      {c.sort && onSort ? (
                        <button type="button" className="inline-flex items-center gap-1 hover:text-gray-800 dark:hover:text-white" onClick={() => onSort(sort === c.sort ? `-${c.sort}` : c.sort!)}>
                          <table.FlexRender header={h} />
                          <span aria-hidden className={cn("text-[10px]", active ? "text-brand-500" : "opacity-30")}>{sort === `-${c.sort}` ? "▼" : "▲"}</span>
                        </button>
                      ) : (
                        <table.FlexRender header={h} />
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className="divide-y divide-gray-100 dark:divide-gray-800">
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className={cn(onRowClick && "cursor-pointer hover:bg-gray-50 dark:hover:bg-white/3")}>
                {row.getAllCells().map((cell) => {
                  const c = byId.get(cell.column.id)!;
                  return (
                    <TableCell key={cell.id} className={cn("px-4 py-3 text-theme-sm text-gray-700 dark:text-gray-300", c.align === "end" ? "text-end tabular-nums" : "text-start", c.className)}>
                      <span onClick={() => c.key !== "actions" && onRowClick?.(row.original)} className={cn(c.key !== "actions" && onRowClick && "block")}>
                        <table.FlexRender cell={cell} />
                      </span>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {loading && !rows && <Loading />}
        {!loading && rows && rows.length === 0 && <Empty text={emptyText} />}
      </div>
      {meta && onPage && <Pager page={meta.page ?? 1} totalPages={meta.totalPages ?? 1} total={meta.total} onPage={onPage} />}
    </div>
  );
}
