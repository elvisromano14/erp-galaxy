import { Body, CanActivate, Controller, ExecutionContext, Get, Headers, HttpException, Injectable, Module, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../../common/auth/decorators';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { env } from '../../config/env';
import { SalesModule } from '../sales/sales.module';
import { appConfig, DevicesService, versionLt } from './devices.service';
import { pullQuery, pushSchema, registerDeviceSchema } from './mobile.types';
import { SyncPullService } from './sync-pull.service';
import { SyncPushService } from './sync-push.service';

/** Versión mínima de la app (cabecera `X-App-Version`): por debajo → 426 y la app conserva su cola pendiente. */
@Injectable()
export class AppVersionGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const v = ctx.switchToHttp().getRequest().headers['x-app-version'];
    if (typeof v === 'string' && versionLt(v, env.MOBILE_MIN_APP_VERSION)) {
      throw new HttpException({ error: 'UPGRADE_REQUIRED', message: `Actualice la aplicación (versión mínima ${env.MOBILE_MIN_APP_VERSION})`, details: [] }, 426);
    }
    return true;
  }
}

@ApiTags('mobile') @ApiBearerAuth()
@Controller()
export class MobileController {
  constructor(private readonly devices: DevicesService, private readonly pull: SyncPullService, private readonly push: SyncPushService) {}

  /** Versiones y mantenimiento (sin autenticación: la app lo consulta antes de iniciar sesión). */
  @Public() @Get('app/config')
  config() { return appConfig(); }

  @Post('devices/register') @RequirePermissions('mobile:sync:use')
  register(@CurrentUser() u: AuthUser, @ZBody(registerDeviceSchema) b: z.infer<typeof registerDeviceSchema>) { return this.devices.register(u, b); }

  @Get('devices') @RequirePermissions('mobile:devices:read')
  list() { return this.devices.list(); }

  @Post('devices/:id/revoke') @RequirePermissions('mobile:devices:update')
  revoke(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string) { return this.devices.setRevoked(id, true, u.userId); }

  @Post('devices/:id/restore') @RequirePermissions('mobile:devices:update')
  restore(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string) { return this.devices.setRevoked(id, false, u.userId); }

  @Get('sync/pull') @RequirePermissions('mobile:sync:use') @UseGuards(AppVersionGuard)
  async pullPage(@CurrentUser() u: AuthUser, @Headers('x-device-id') deviceId: string | undefined, @Headers('x-app-version') appVersion: string | undefined, @ZQuery(pullQuery) q: z.infer<typeof pullQuery>) {
    await this.devices.assertActive(u, deviceId, appVersion);
    return this.pull.pull(u, q);
  }

  /** Existencia en vivo por depósito (sin costos). */
  @Get('sync/stock/:productId') @RequirePermissions('mobile:sync:use', 'inventory:stock:read') @UseGuards(AppVersionGuard)
  async liveStock(@CurrentUser() u: AuthUser, @Headers('x-device-id') deviceId: string | undefined, @Headers('x-app-version') appVersion: string | undefined, @Param('productId', new ZodPipe(uuid)) productId: string) {
    await this.devices.assertActive(u, deviceId, appVersion);
    return this.pull.liveStock(productId);
  }

  @Post('sync/push') @RequirePermissions('mobile:sync:use') @UseGuards(AppVersionGuard)
  async pushOps(@CurrentUser() u: AuthUser, @Headers('x-device-id') deviceId: string | undefined, @Headers('x-app-version') appVersion: string | undefined, @ZBody(pushSchema) b: z.infer<typeof pushSchema>) {
    const device = await this.devices.assertActive(u, deviceId, appVersion);
    return this.push.push(u, device.id, b.operations);
  }
}

@Module({ imports: [SalesModule], controllers: [MobileController], providers: [DevicesService, SyncPullService, SyncPushService, AppVersionGuard] })
export class MobileModule {}
