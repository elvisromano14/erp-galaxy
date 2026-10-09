"use client";

import { type Control, type FieldPath, type FieldValues, useController } from "react-hook-form";
import { CheckField, DecimalField, IntField, SelectField, TextAreaField, TextField, type Option } from "./FormFields";
import { type LabelFn, RefSelect } from "./RefSelect";

/**
 * Campos enlazados a React Hook Form: cada uno obtiene valor, cambio y error del formulario.
 * `serverError` permite mostrar errores que vienen de la API (p. ej. duplicados) sobre el mismo campo.
 */
interface Base<V extends FieldValues> {
  control: Control<V>;
  name: FieldPath<V>;
  label: string;
  required?: boolean;
  hint?: string;
  disabled?: boolean;
  className?: string;
  serverError?: string | null;
}

function useField<V extends FieldValues>(control: Control<V>, name: FieldPath<V>, serverError?: string | null) {
  const { field, fieldState } = useController({ control, name });
  return { value: field.value as unknown, onChange: field.onChange as (v: unknown) => void, error: fieldState.error?.message ?? serverError ?? null };
}

export function RText<V extends FieldValues>(p: Base<V> & { type?: "text" | "email" | "date" | "tel"; placeholder?: string; maxLength?: number }) {
  const f = useField(p.control, p.name, p.serverError);
  return <TextField label={p.label} required={p.required} hint={p.hint} disabled={p.disabled} className={p.className} type={p.type} placeholder={p.placeholder} maxLength={p.maxLength} value={String(f.value ?? "")} onChange={f.onChange} error={f.error} />;
}

export function RDecimal<V extends FieldValues>(p: Base<V> & { placeholder?: string; align?: "end" }) {
  const f = useField(p.control, p.name, p.serverError);
  return <DecimalField label={p.label} required={p.required} hint={p.hint} disabled={p.disabled} className={p.className} placeholder={p.placeholder} align={p.align} value={String(f.value ?? "")} onChange={f.onChange} error={f.error} />;
}

export function RInt<V extends FieldValues>(p: Base<V>) {
  const f = useField(p.control, p.name, p.serverError);
  return <IntField label={p.label} required={p.required} hint={p.hint} disabled={p.disabled} className={p.className} value={String(f.value ?? "")} onChange={f.onChange} error={f.error} />;
}

export function RSelect<V extends FieldValues>(p: Base<V> & { options: Option[]; placeholder?: string }) {
  const f = useField(p.control, p.name, p.serverError);
  return <SelectField label={p.label} required={p.required} hint={p.hint} disabled={p.disabled} className={p.className} options={p.options} placeholder={p.placeholder} value={String(f.value ?? "")} onChange={f.onChange} error={f.error} />;
}

export function RCheck<V extends FieldValues>(p: Omit<Base<V>, "required">) {
  const f = useField(p.control, p.name, p.serverError);
  return <CheckField label={p.label} hint={p.hint} disabled={p.disabled} className={p.className} checked={!!f.value} onChange={f.onChange as (v: boolean) => void} />;
}

export function RTextArea<V extends FieldValues>(p: Base<V> & { rows?: number }) {
  const f = useField(p.control, p.name, p.serverError);
  return <TextAreaField label={p.label} required={p.required} hint={p.hint} disabled={p.disabled} className={p.className} rows={p.rows} value={String(f.value ?? "")} onChange={f.onChange} error={f.error} />;
}

export function RRef<V extends FieldValues>(p: Base<V> & { resource: string; labelKey: string | LabelFn; filter?: Record<string, string> }) {
  const f = useField(p.control, p.name, p.serverError);
  return <RefSelect label={p.label} required={p.required} hint={p.hint} disabled={p.disabled} className={p.className} resource={p.resource} labelKey={p.labelKey} filter={p.filter} value={String(f.value ?? "")} onChange={f.onChange} error={f.error} />;
}
