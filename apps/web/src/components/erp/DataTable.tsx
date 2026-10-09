"use client";

import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/utils";
import { Empty, Loading, Pager } from "./ui";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  /** Campo de ordenación del servidor (si se omite, la columna no ordena). */
  sort?: string;
  className?: string;
  align?: "start" | "end";
}

interface Props<T> {
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

/** Tabla con paginación/orden del lado del servidor (erp-v3 §14.2). */
export default function DataTable<T>({ columns, rows, loading, rowKey, meta, onPage, sort, onSort, onRowClick, emptyText }: Props<T>) {
  return (
    <div>
      <div className="max-w-full overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <Table>
          <TableHeader className="border-b border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-white/3">
            <TableRow>
              {columns.map((c) => {
                const active = c.sort && (sort === c.sort || sort === `-${c.sort}`);
                return (
                  <TableCell
                    key={c.key}
                    isHeader
                    className={cn("px-4 py-3 text-theme-xs font-medium whitespace-nowrap text-gray-500 dark:text-gray-400", c.align === "end" ? "text-end" : "text-start", c.className)}
                  >
                    {c.sort && onSort ? (
                      <button type="button" className="inline-flex items-center gap-1 hover:text-gray-800 dark:hover:text-white" onClick={() => onSort(sort === c.sort ? `-${c.sort}` : c.sort!)}>
                        {c.header}
                        <span aria-hidden className={cn("text-[10px]", active ? "text-brand-500" : "opacity-30")}>{sort === `-${c.sort}` ? "▼" : "▲"}</span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows?.map((row) => (
              <TableRow key={rowKey(row)} className={cn(onRowClick && "cursor-pointer hover:bg-gray-50 dark:hover:bg-white/3")}>
                {columns.map((c) => (
                  <TableCell
                    key={c.key}
                    className={cn("px-4 py-3 text-theme-sm text-gray-700 dark:text-gray-300", c.align === "end" ? "text-end tabular-nums" : "text-start", c.className)}
                  >
                    <span onClick={() => c.key !== "actions" && onRowClick?.(row)} className={cn(c.key !== "actions" && onRowClick && "block")}>
                      {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "—")}
                    </span>
                  </TableCell>
                ))}
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
