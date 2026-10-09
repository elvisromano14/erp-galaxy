import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { getStore } from '../db/tenant-context';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entity: string, entityId: string | undefined, action: string, diff?: unknown, opts: { companyId?: string | null; userId?: string | null } = {}) {
    const s = getStore();
    // createMany: INSERT sin RETURNING (las filas sin empresa no son visibles por la política SELECT).
    await this.prisma.db.auditLog.createMany({
      data: [{
        companyId: opts.companyId === undefined ? s.companyId ?? null : opts.companyId,
        userId: opts.userId === undefined ? s.userId ?? null : opts.userId,
        entity, entityId, action,
        diff: diff === undefined ? undefined : JSON.parse(JSON.stringify(diff)),
        ip: s.ip, requestId: s.requestId,
      }],
    });
  }
}
