import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { RedisService } from '../db/redis.service';

const TTL = 300;
const key = (companyId: string, userId: string) => `perm:${companyId}:${userId}`;

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  async forUser(userId: string, companyId: string): Promise<string[]> {
    const cached = await this.redis.client.get(key(companyId, userId));
    if (cached) return JSON.parse(cached);
    const perms = await this.prisma.runWithTenant(companyId, async tx => {
      const roles = await tx.userRole.findMany({ where: { userId, companyId }, select: { roleId: true } });
      if (!roles.length) return [] as string[];
      const rp = await tx.rolePermission.findMany({ where: { companyId, roleId: { in: roles.map(r => r.roleId) } }, select: { permissionCode: true } });
      return [...new Set(rp.map(r => r.permissionCode))];
    });
    await this.redis.client.set(key(companyId, userId), JSON.stringify(perms), 'EX', TTL);
    return perms;
  }

  async invalidate(companyId: string, userId?: string) {
    if (userId) { await this.redis.client.del(key(companyId, userId)); return; }
    const keys = await this.redis.client.keys(`perm:${companyId}:*`);
    if (keys.length) await this.redis.client.del(...keys);
  }
}
