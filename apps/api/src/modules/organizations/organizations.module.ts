import { Body, Controller, ForbiddenException, Get, Global, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { AllowNoCompany, AuthUser, CurrentUser } from '../../common/auth/decorators';
import { ZBody } from '../../common/http/zod.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { AccessService } from './access.service';
import { OrganizationsService } from './organizations.service';

const createOrg = z.object({
  name: z.string().trim().min(2).max(200),
  admin: z.object({ email: z.string().email(), fullName: z.string().min(2), password: z.string().min(10).optional() }).optional(),
});
const updateOrg = z.object({ name: z.string().trim().min(2).max(200).optional(), isActive: z.boolean().optional() }).strict();

@ApiTags('organizations') @ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly svc: OrganizationsService, private readonly access: AccessService) {}

  /** Superadmin: todos los clientes. Administrador de cliente: solo el suyo. Los demás usuarios: ninguno. */
  @Get() @AllowNoCompany()
  async list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u);
  }

  @Post() @AllowNoCompany()
  create(@CurrentUser() u: AuthUser, @ZBody(createOrg) b: z.infer<typeof createOrg>) {
    if (!u.isSuperAdmin) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Solo el administrador global puede crear clientes' });
    return this.svc.create(b);
  }

  @Patch(':id') @AllowNoCompany()
  update(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string, @ZBody(updateOrg) b: z.infer<typeof updateOrg>) {
    if (!u.isSuperAdmin) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Solo el administrador global puede modificar clientes' });
    return this.svc.update(id, b);
  }
}

const createClient = z.object({
  fullName: z.string().trim().min(2).max(200), email: z.string().email(), password: z.string().min(10), companyIds: z.array(uuid).min(1),
});

/** Clientes (administradores de empresa): solo el administrador global. */
@ApiTags('clients') @ApiBearerAuth()
@Controller('clients')
export class ClientsController {
  constructor(private readonly svc: OrganizationsService) {}
  private only(u: AuthUser) {
    if (!u.isSuperAdmin) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Solo el administrador global puede gestionar clientes' });
  }
  @Get() @AllowNoCompany()
  list(@CurrentUser() u: AuthUser) { this.only(u); return this.svc.listClients(); }
  @Post() @AllowNoCompany()
  create(@CurrentUser() u: AuthUser, @ZBody(createClient) b: z.infer<typeof createClient>) { this.only(u); return this.svc.createClient(b); }
  @Patch(':id/companies') @AllowNoCompany()
  setCompanies(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string, @ZBody(z.object({ companyIds: z.array(uuid).min(1) }).strict()) b: { companyIds: string[] }) {
    this.only(u); return this.svc.setClientCompanies(id, b.companyIds);
  }
  @Patch(':id') @AllowNoCompany()
  setActive(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string, @ZBody(z.object({ isActive: z.boolean() }).strict()) b: { isActive: boolean }) {
    this.only(u); return this.svc.setClientActive(id, b.isActive);
  }
}

@Global()
@Module({ controllers: [OrganizationsController, ClientsController], providers: [AccessService, OrganizationsService], exports: [AccessService, OrganizationsService] })
export class OrganizationsModule {}
