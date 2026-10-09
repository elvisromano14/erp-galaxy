import { isValidRif } from "@erp/domain";
import { z } from "zod";

/** Validadores de formularios (mensajes en español). Los valores de formulario son texto; la API recibe cadenas decimales. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

export const reqText = (max = 200) => z.string().trim().min(1, "Obligatorio").max(max, `Máximo ${max} caracteres`);
export const optText = (max = 500) => z.string().trim().max(max, `Máximo ${max} caracteres`);
export const reqEmail = z.string().trim().min(1, "Obligatorio").email("Correo inválido");
export const optEmail = z.string().trim().refine((v) => v === "" || z.string().email().safeParse(v).success, "Correo inválido");
export const reqDecimal = z.string().trim().min(1, "Obligatorio").regex(DECIMAL, "Número inválido");
export const optDecimal = z.string().trim().refine((v) => v === "" || DECIMAL.test(v), "Número inválido");
export const reqPositiveDecimal = reqDecimal.refine((v) => Number(v) > 0, "Debe ser mayor que cero");
export const reqInt = z.string().trim().min(1, "Obligatorio").regex(/^\d+$/, "Debe ser un entero");
export const optInt = z.string().trim().refine((v) => v === "" || /^\d+$/.test(v), "Debe ser un entero");
export const reqSelect = z.string().min(1, "Seleccione una opción");
export const rif = z.string().trim().min(1, "Obligatorio").refine((v) => isValidRif(v), "RIF inválido (ej.: J-12345678-9)");
export const strongPassword = z.string().min(10, "Mínimo 10 caracteres").regex(/[A-Za-z]/, "Debe incluir letras").regex(/\d/, "Debe incluir números");
export const optPassword = z.string().refine((v) => v === "" || (v.length >= 10 && /[A-Za-z]/.test(v) && /\d/.test(v)), "Mínimo 10 caracteres, con letras y números");
