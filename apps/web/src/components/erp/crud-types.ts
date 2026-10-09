import type { LabelFn } from "./RefSelect";

export type FieldDef =
  | { name: string; type: "text" | "email" | "tel" | "date"; required?: boolean; nullable?: boolean; maxLength?: number; placeholder?: string; wide?: boolean }
  | { name: string; type: "textarea"; required?: boolean; nullable?: boolean; wide?: boolean }
  | { name: string; type: "decimal"; required?: boolean; nullable?: boolean; default?: string; hint?: string }
  | { name: string; type: "int"; required?: boolean; default?: string }
  | { name: string; type: "boolean"; default?: boolean }
  | { name: string; type: "select"; options: string[]; required?: boolean; default?: string }
  | { name: string; type: "ref"; resource: string; labelKey: string | LabelFn; required?: boolean; nullable?: boolean; filter?: Record<string, string> };

export interface ColumnDef {
  key: string;
  type?: "text" | "bool" | "enum" | "decimal" | "date" | "int";
  sort?: boolean;
  align?: "end";
}

export interface CrudDef {
  /** Ruta de la API (también sirve de segmento de URL en /admin/<resource>). */
  resource: string;
  /** Prefijo de permisos: `${permission}:read|create|update|delete`. */
  permission: string;
  columns: ColumnDef[];
  fields: FieldDef[];
  softDelete?: boolean;
  defaultSort?: string;
  /** Campos que no se pueden cambiar al editar. */
  immutableOnEdit?: string[];
}
