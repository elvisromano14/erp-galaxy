import { Body, CanActivate, Controller, ExecutionContext, Get, Headers, HttpException, Injectable, Module, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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
import { AuditService } from '../../common/audit/audit.service';
import { MobileAppService } from './mobile-app.service';
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
  constructor(private readonly devices: DevicesService, private readonly pull: SyncPullService, private readonly push: SyncPushService, private readonly app: MobileAppService, private readonly audit: AuditService) {}

  /** Versiones y mantenimiento (sin autenticación: la app lo consulta antes de iniciar sesión). */
  @Public() @Get('app/config')
  config() { return appConfig(); }

  // ───────────── descarga de la app (APK) desde el ERP ─────────────
  /** Datos del APK publicado (versión, tamaño, SHA-256). */
  @Get('mobile/app') @RequirePermissions('mobile:app:download')
  appInfo() { return this.app.info(); }

  /** Enlace de descarga firmado y de vida corta (se puede abrir desde el navegador del teléfono sin iniciar sesión). */
  @Post('mobile/app/link') @RequirePermissions('mobile:app:download')
  async appLink(@CurrentUser() u: AuthUser) {
    const info = this.app.info();
    if (!info.available) throw new HttpException({ error: 'APK_NOT_AVAILABLE', message: 'Aún no hay una app publicada para descargar', details: [] }, 404);
    const { token, expiresAt } = this.app.createLink(u.userId);
    await this.audit.log('mobile_app', undefined, 'DOWNLOAD_LINK', { version: info.version });
    return { url: `/api/v1/mobile/app/download?token=${token}`, expiresAt, ...info };
  }

  /** Descarga del APK con el enlace firmado (soporta reanudación y descarga parcial). */
  @Public() @Get('mobile/app/download')
  download(@Query('token') token: string | undefined, @Res() res: Response) {
    this.app.verify(token ?? '');
    const f = this.app.file();
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Cache-Control', 'private, no-store');
    res.download(f.path, f.fileName);
  }

  @Post('devices/register') @RequirePermissions('mobile:sync:use')
  register(@CurrentUser() u: AuthUser, @ZBody(registerDeviceSchema) b: z.infer<typeof registerDeviceSchema>) { return this.devices.register(u, b); }

  @Get('devices') @RequirePermissions('mobile:devices:read')
  list() { return this.devices.list(); }

  @Post('devices/:id/revoke') @RequirePermissions('mobile:devices:update')
  revoke(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string) { return this.devices.setRevoked(id, true, u.userId); }

  @Post('devices/:id/release') @RequirePermissions('mobile:devices:update')
  release(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string) { return this.devices.release(id, u.userId); }

  @Post('devices/:id/restore') @RequirePermissions('mobile:devices:update')
  restore(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(uuid)) id: string) { return this.devices.setRevoked(id, false, u.userId); }

  @Get('sync/pull') @RequirePermissions('mobile:sync:use') @UseGuards(AppVersionGuard)
  async pullPage(@CurrentUser() u: AuthUser, @Headers('x-device-id') deviceId: string | undefined, @Headers('x-app-version') appVersion: string | undefined, @Headers('x-queue-size') queueSize: string | undefined, @ZQuery(pullQuery) q: z.infer<typeof pullQuery>) {
    await this.devices.assertActive(u, deviceId, appVersion, queueSize);
    return this.pull.pull(u, q);
  }

  /** Existencia en vivo por depósito (sin costos). */
  @Get('sync/stock/:productId') @RequirePermissions('mobile:sync:use', 'inventory:stock:read') @UseGuards(AppVersionGuard)
  async liveStock(@CurrentUser() u: AuthUser, @Headers('x-device-id') deviceId: string | undefined, @Headers('x-app-version') appVersion: string | undefined, @Param('productId', new ZodPipe(uuid)) productId: string) {
    await this.devices.assertActive(u, deviceId, appVersion);
    return this.pull.liveStock(productId);
  }

  @Post('sync/push') @RequirePermissions('mobile:sync:use') @UseGuards(AppVersionGuard)
  async pushOps(@CurrentUser() u: AuthUser, @Headers('x-device-id') deviceId: string | undefined, @Headers('x-app-version') appVersion: string | undefined, @Headers('x-queue-size') queueSize: string | undefined, @ZBody(pushSchema) b: z.infer<typeof pushSchema>) {
    const device = await this.devices.assertActive(u, deviceId, appVersion, queueSize);
    return this.push.push(u, device.id, b.operations);
  }
}

@Module({ imports: [SalesModule], controllers: [MobileController], providers: [DevicesService, SyncPullService, SyncPushService, AppVersionGuard, MobileAppService] })
export class MobileModule {}
