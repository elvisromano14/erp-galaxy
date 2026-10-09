import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../../common/auth/decorators';
import { PermissionsService } from '../../common/auth/permissions.service';
import { AlertsService } from './alerts.service';

@ApiTags('alerts') @ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(private readonly svc: AlertsService, private readonly perms: PermissionsService) {}

  /** Alertas operativas visibles para el usuario (según sus permisos). Sin permiso especial: cada alerta se filtra por los suyos. */
  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const have = u.isSuperAdmin ? null : new Set(await this.perms.forUser(u.userId, u.companyId!));
    return this.svc.summary(p => (have ? have.has(p) : true));
  }
}
