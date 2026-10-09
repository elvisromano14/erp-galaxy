import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Rutas autenticadas que no requieren empresa activa (p. ej. select-company). */
export const NO_COMPANY = 'noCompany';
export const AllowNoCompany = () => SetMetadata(NO_COMPANY, true);

export const PERMISSIONS = 'permissions';
export const RequirePermissions = (...perms: string[]) => SetMetadata(PERMISSIONS, perms);

export interface AuthUser { userId: string; companyId?: string; jti: string; exp: number; isSuperAdmin: boolean }

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
