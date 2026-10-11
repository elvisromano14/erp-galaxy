import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AllowNoCompany, AuthUser, CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { CompaniesService } from './companies.service';
import { uuid } from '@erp/contracts';
import { ZBody } from '../../common/http/zod.decorators';

const features = z.object({ lots: z.boolean(), serials: z.boolean(), expiry: z.boolean() }).partial();
const createCompany = z.object({
  organizationId: z.string().uuid().optional(),
  rif: z.string().min(5), legalName: z.string().min(2), tradeName: z.string().optional(), fiscalAddress: z.string().trim().min(3, 'La dirección es obligatoria'),
  phone: z.string().trim().max(40).optional(), email: z.string().email().optional(), adminName: z.string().trim().max(200).optional(),
  baseCurrencyCode: z.string().length(3).optional(), valuationCurrencyCode: z.string().length(3).optional(),
  isSpecialTaxpayer: z.boolean().optional(), isVatWithholdingAgent: z.boolean().optional(), isIgtfCollector: z.boolean().optional(),
  admin: z.object({ email: z.string().email(), fullName: z.string().min(2), password: z.string().min(10).optional() }).optional(),
});
const updateCompany = z.object({
  legalName: z.string().min(2).optional(), tradeName: z.string().nullable().optional(), fiscalAddress: z.string().nullable().optional(), phone: z.string().trim().max(40).nullable().optional(), email: z.string().email().nullable().optional(), adminName: z.string().trim().max(200).nullable().optional(),
  isSpecialTaxpayer: z.boolean().optional(), isVatWithholdingAgent: z.boolean().optional(), isIgtfCollector: z.boolean().optional(),
  features: features.optional(),
}).strict();
const createUser = z.object({ email: z.string().email(), fullName: z.string().min(2), password: z.string().min(10).optional(), roleCodes: z.array(z.string()).min(1) });
const updateCompanyById = z.object({
  legalName: z.string().min(2).optional(), tradeName: z.string().nullable().optional(), fiscalAddress: z.string().nullable().optional(), phone: z.string().trim().max(40).nullable().optional(), email: z.string().email().nullable().optional(), adminName: z.string().trim().max(200).nullable().optional(),
  isSpecialTaxpayer: z.boolean().optional(), isVatWithholdingAgent: z.boolean().optional(), isIgtfCollector: z.boolean().optional(), isActive: z.boolean().optional(),
}).strict();
const updateUser = z.object({ fullName: z.string().min(2).optional(), isActive: z.boolean().optional(), roleCodes: z.array(z.string()).optional(), isOrgAdmin: z.boolean().optional() }).strict();
const createRole = z.object({ code: z.string().min(2).max(30), name: z.string().min(2), permissions: z.array(z.string()) });
const updateRole = z.object({ name: z.string().min(2).optional(), permissions: z.array(z.string()).optional() }).strict();

@ApiTags('companies') @ApiBearerAuth()
@Controller('companies')
export class CompaniesController {
  constructor(private readonly svc: CompaniesService) {}

  /** Alta de empresa: solo el administrador global. */
  @Post() @AllowNoCompany()
  create(@CurrentUser() u: AuthUser, @ZBody(createCompany) b: z.infer<typeof createCompany>) {
    if (!u.isSuperAdmin) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Solo el administrador global puede crear empresas' });
    return this.svc.create(b, u);
  }

  /** Solo las empresas visibles para el usuario; nunca las de otros clientes. */
  @Get() @AllowNoCompany()
  list(@CurrentUser() u: AuthUser, @Query('includeInactive') includeInactive?: string) {
    return this.svc.listVisible(u, includeInactive === 'true');
  }

  @Get('current') @RequirePermissions('security:companies:read')
  current() { return this.svc.current(); }

  @Patch('current') @RequirePermissions('security:companies:update')
  update(@ZBody(updateCompany) b: z.infer<typeof updateCompany>) { return this.svc.updateCurrent(b); }

  /** Edición/baja de cualquier empresa de MI cliente (no requiere tenerla seleccionada). */
  @Patch(':id') @AllowNoCompany()
  updateById(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string, @ZBody(updateCompanyById) b: z.infer<typeof updateCompanyById>) { return this.svc.updateById(id, b, u); }
}

@ApiTags('users') @ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly svc: CompaniesService) {}
  @Get() @RequirePermissions('security:users:read') list() { return this.svc.listUsers(); }
  @Post() @RequirePermissions('security:users:create')
  create(@ZBody(createUser) b: z.infer<typeof createUser>) { return this.svc.createUser(b); }
  @Patch(':id') @RequirePermissions('security:users:update')
  update(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string, @ZBody(updateUser) b: z.infer<typeof updateUser>) { return this.svc.updateUser(id, b, u); }
}

@ApiTags('roles') @ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly svc: CompaniesService) {}
  @Get() @RequirePermissions('security:roles:read') list() { return this.svc.listRoles(); }
  @Post() @RequirePermissions('security:roles:create')
  create(@ZBody(createRole) b: z.infer<typeof createRole>) { return this.svc.createRole(b); }
  @Patch(':id') @RequirePermissions('security:roles:update')
  update(@Param('id', new ZodPipe(uuid)) id: string, @ZBody(updateRole) b: z.infer<typeof updateRole>) { return this.svc.updateRole(id, b); }
}

@ApiTags('permissions') @ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly svc: CompaniesService) {}
  @Get() @RequirePermissions('security:roles:read') list() { return this.svc.listPermissions(); }
}
