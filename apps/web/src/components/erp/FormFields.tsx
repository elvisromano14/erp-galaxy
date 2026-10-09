"use client";

import Checkbox from "@/components/form/input/Checkbox";
import Input from "@/components/form/input/InputField";
import Label from "@/components/form/Label";
import { cn } from "@/utils";
import { useId } from "react";

interface FieldShellProps {
  label: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}

export function FieldShell({ label, required, error, hint, htmlFor, className, children }: FieldShellProps) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>
        {label} {required && <span className="text-error-500">*</span>}
      </Label>
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-error-500">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-gray-500">{hint}</p>
      ) : null}
    </div>
  );
}

interface BaseProps {
  label: string;
  required?: boolean;
  error?: string | null;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

export function TextField({ label, required, error, hint, disabled, className, value, onChange, type = "text", placeholder, maxLength }: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "email" | "date" | "tel";
  placeholder?: string;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <FieldShell {...{ label, required, error, hint, className }} htmlFor={id}>
      <Input id={id} type={type} value={value} disabled={disabled} error={!!error} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
    </FieldShell>
  );
}

/** Decimal como cadena (nunca `number` para dinero/cantidades): admite coma o punto como separador. */
export function DecimalField({ label, required, error, hint, disabled, className, value, onChange, placeholder, align }: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  align?: "end";
}) {
  const id = useId();
  return (
    <FieldShell {...{ label, required, error, hint, className }} htmlFor={id}>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        disabled={disabled}
        error={!!error}
        placeholder={placeholder}
        className={align === "end" ? "text-end" : ""}
        onChange={(e) => onChange(e.target.value.replace(",", ".").replace(/[^0-9.\-]/g, ""))}
      />
    </FieldShell>
  );
}

export function IntField(props: BaseProps & { value: string; onChange: (v: string) => void }) {
  const id = useId();
  const { label, required, error, hint, className, disabled, value, onChange } = props;
  return (
    <FieldShell {...{ label, required, error, hint, className }} htmlFor={id}>
      <Input id={id} inputMode="numeric" value={value} disabled={disabled} error={!!error} onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ""))} />
    </FieldShell>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({ label, required, error, hint, disabled, className, value, onChange, options, placeholder }: BaseProps & {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
}) {
  const id = useId();
  return (
    <FieldShell {...{ label, required, error, hint, className }} htmlFor={id}>
      <NativeSelect id={id} value={value} onChange={onChange} options={options} placeholder={placeholder} disabled={disabled} error={!!error} />
    </FieldShell>
  );
}

/** Select nativo controlado con el estilo del template (el `Select` del template no es controlable). */
export function NativeSelect({ id, value, onChange, options, placeholder, disabled, error, className }: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  className?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-11 w-full rounded-lg border bg-transparent px-4 py-2.5 text-sm shadow-theme-xs focus:ring-3 focus:outline-hidden dark:bg-gray-900",
        error ? "border-error-500 focus:border-error-300 focus:ring-error-500/20" : "border-gray-300 focus:border-brand-300 focus:ring-brand-500/10 dark:border-gray-700 dark:focus:border-brand-800",
        value ? "text-gray-800 dark:text-white/90" : "text-gray-400",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <option value="" className="text-gray-700 dark:bg-gray-900 dark:text-gray-400">
        {placeholder ?? "—"}
      </option>
      {options.map((o) => (
        <option key={o.value} value={o.value} className="text-gray-700 dark:bg-gray-900 dark:text-gray-400">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CheckField({ label, checked, onChange, disabled, className, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; className?: string; hint?: string }) {
  const id = useId();
  return (
    <div className={cn("flex flex-col justify-center", className)}>
      <Checkbox id={id} label={label} checked={checked} onChange={onChange} disabled={disabled} />
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export function TextAreaField({ label, required, error, hint, disabled, className, value, onChange, rows = 3 }: BaseProps & { value: string; onChange: (v: string) => void; rows?: number }) {
  const id = useId();
  return (
    <FieldShell {...{ label, required, error, hint, className }} htmlFor={id}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full rounded-lg border bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs focus:ring-3 focus:outline-hidden dark:bg-gray-900 dark:text-white/90",
          error ? "border-error-500 focus:ring-error-500/20" : "border-gray-300 focus:border-brand-300 focus:ring-brand-500/10 dark:border-gray-700",
        )}
      />
    </FieldShell>
  );
}
