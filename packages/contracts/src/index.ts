import { z } from 'zod';

export const uuid = z.string().uuid();
export const decimalStr = z.union([z.string().regex(/^-?\d+(\.\d+)?$/), z.number()]).transform(v => String(v));

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  sort: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const selectCompanySchema = z.object({ companyId: uuid });
export const refreshSchema = z.object({ refreshToken: z.string().min(20) });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10) });

export const DOC_STATUS = ['DRAFT', 'CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CLOSED', 'CANCELLED', 'VOIDED'] as const;
export type DocStatus = (typeof DOC_STATUS)[number];
