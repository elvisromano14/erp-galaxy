import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { PermissionsService } from '../../common/auth/permissions.service';
import { AuthUser } from '../../common/auth/decorators';
import { BusinessRuleException, ConflictError, NotFoundError } from '../../common/errors/errors';
import { env } from '../../config/env';
import { registerDeviceSchema } from './mobile.types';
import { z } from 'zod';

/** Comparación simple de versiones `x.y.z` (los sufijos se ignoran). */
export function versionLt(a: string, b: string): boolean {
  const n = (v: string) => v.split('-')[0].split('.').map(x => parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); }
  return false;
}

export function appConfig() {
  return {
    minAppVersion: env.MOBILE_MIN_APP_VERSION, latestAppVersion: env.MOBILE_LATEST_APP_VERSION, schemaVersion: env.MOBILE_SCHEMA_VERSION,
    maintenance: env.MOBILE_MAINTENANCE_MESSAGE ? { message: env.MOBILE_MAINTENANCE_MESSAGE } : null, serverTime: new Date().toISOString(),
  };
}

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly perms: PermissionsService) {}

  /** Vendedor ligado al usuario (las políticas y el alcance de los datos salen de él). */
  async sellerOf(userId: string) {
    return this.prisma.db.seller.findFirst({ where: { userId, deletedAt: null, isActive: true } });
  }

  async canSeeAll(user: AuthUser) {
    return (await this.perms.forUser(user.userId, user.companyId!)).includes('sales:documents:read-all');
  }

  /** Alta (o reconocimiento) de un dispositivo. Un mismo `deviceKey` siempre devuelve el mismo registro. */
  async register(user: AuthUser, input: z.infer<typeof registerDeviceSchema>) {
    const tx = this.prisma.db;
    const companyId = this.prisma.companyId;
    const existing = await tx.device.findUnique({ where: { companyId_deviceKey: { companyId, deviceKey: input.deviceKey } } });
    if (existing) {
      if (existing.userId !== user.userId) throw new ForbiddenException({ error: 'DEVICE_OWNED_BY_OTHER', message: 'Este dispositivo está registrado para otro usuario' });
      if (existing.revokedAt) throw new ForbiddenException({ error: 'DEVICE_REVOKED', message: 'Este dispositivo fue revocado por la administración' });
      return this.view(await tx.device.update({ where: { id: existing.id }, data: { name: input.name, appVersion: input.appVersion ?? existing.appVersion, lastSeenAt: new Date() } }));
    }
    if (!(await this.sellerOf(user.userId)) && !(await this.canSeeAll(user))) {
      throw new BusinessRuleException('Su usuario no está ligado a un vendedor: pida a administración que lo asigne', 'SELLER_REQUIRED');
    }
    const active = await tx.device.count({ where: { userId: user.userId, revokedAt: null } });
    if (active >= env.MOBILE_MAX_DEVICES_PER_USER) {
      throw new ConflictError('Ya tiene un dispositivo activo; pida a administración que lo revoque para registrar otro', 'DEVICE_LIMIT_REACHED');
    }
    const codes = (await tx.device.findMany({ select: { deviceCode: true } })).map(d => parseInt(d.deviceCode.slice(1), 10) || 0);
    const next = (codes.length ? Math.max(...codes) : 0) + 1;
    const device = await tx.device.create({
      data: { companyId, userId: user.userId, deviceKey: input.deviceKey, deviceCode: `D${String(next).padStart(2, '0')}`, name: input.name, platform: input.platform, appVersion: input.appVersion ?? null, lastSeenAt: new Date() },
    });
    await this.audit.log('device', device.id, 'REGISTER', { name: input.name, platform: input.platform, code: device.deviceCode });
    return this.view(device);
  }

  /** Valida el dispositivo de la petición (cabecera `X-Device-Id`): debe existir, ser del usuario y no estar revocado. */
  async assertActive(user: AuthUser, deviceId: string | undefined, appVersion?: string) {
    if (!deviceId) throw new HttpException({ error: 'DEVICE_REQUIRED', message: 'Falta la cabecera X-Device-Id (registre el dispositivo)', details: [] }, 400);
    const device = await this.prisma.db.device.findFirst({ where: { id: deviceId, userId: user.userId } });
    if (!device) throw new ForbiddenException({ error: 'DEVICE_UNKNOWN', message: 'Dispositivo no registrado' });
    if (device.revokedAt) throw new ForbiddenException({ error: 'DEVICE_REVOKED', message: 'Este dispositivo fue revocado por la administración' });
    if (!device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 60_000 || (appVersion && appVersion !== device.appVersion)) {
      await this.prisma.db.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date(), ...(appVersion ? { appVersion } : {}) } });
    }
    return device;
  }

  async list() {
    const devices = await this.prisma.db.device.findMany({ orderBy: [{ revokedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }] });
    const users = new Map((await this.prisma.db.user.findMany({ where: { id: { in: [...new Set(devices.map(d => d.userId))] } }, select: { id: true, fullName: true, email: true } })).map(u => [u.id, u]));
    return devices.map(d => ({ ...this.view(d), user: users.get(d.userId) ?? null }));
  }

  async setRevoked(id: string, revoked: boolean, actorId: string) {
    const device = await this.prisma.db.device.findUnique({ where: { id } });
    if (!device) throw new NotFoundError('Dispositivo', id);
    const updated = await this.prisma.db.device.update({ where: { id }, data: { revokedAt: revoked ? new Date() : null, revokedBy: revoked ? actorId : null } });
    if (revoked) await this.prisma.db.refreshToken.updateMany({ where: { userId: device.userId, companyId: this.prisma.companyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log('device', id, revoked ? 'REVOKE' : 'RESTORE', { code: device.deviceCode });
    return this.view(updated);
  }

  private view(d: { id: string; userId: string; deviceCode: string; name: string; platform: string; appVersion: string | null; lastSeenAt: Date | null; revokedAt: Date | null; createdAt: Date }) {
    return { id: d.id, userId: d.userId, deviceCode: d.deviceCode, name: d.name, platform: d.platform, appVersion: d.appVersion, lastSeenAt: d.lastSeenAt, revokedAt: d.revokedAt, createdAt: d.createdAt };
  }
}
