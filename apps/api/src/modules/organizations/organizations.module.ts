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

@Global()
@Module({ controllers: [OrganizationsController], providers: [AccessService, OrganizationsService], exports: [AccessService, OrganizationsService] })
export class OrganizationsModule {}
