import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../../common/db/prisma.service';
import { getStore } from '../../common/db/tenant-context';

export type EventOp = 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'STATUS';
export type EventOrigin = 'ERP' | 'MOBILE' | 'INTEGRATION';

/**
 * Eventos de salida (outbox transaccional): se escriben en la MISMA transacción que el cambio, así que o existen
 * los dos o ninguno. Lo que escribe una cuenta de servicio (el integrador) se marca INTEGRATION para que el
 * integrador lo ignore y no haya rebotes.
 */
@Injectable()
export class IntegrationEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async emit(e: { entity: string; entityId: string; op: EventOp; version?: number | null; summary?: Record<string, unknown>; origin?: EventOrigin }) {
    const store = getStore();
    const origin: EventOrigin = e.origin ?? (store.isService ? 'INTEGRATION' : store.origin ?? 'ERP');
    await this.prisma.tx.integrationEvent.create({
      data: {
        companyId: this.prisma.companyId, entity: e.entity, entityId: e.entityId, op: e.op,
        version: e.version ?? null, origin, summary: e.summary ? JSON.parse(JSON.stringify(e.summary)) : undefined,
      },
    });
  }
}

export interface ExternalRefView { system: string; connector: string; key: string; number: string | null; origin: string }

/** Referencias externas (código o número en Saint) de uno o varios registros; las fichas las muestran. */
@Injectable()
export class ExternalRefsService {
  constructor(private readonly prisma: PrismaService) {}

  async forEntity(entity: string, ids: string[]): Promise<Map<string, ExternalRefView[]>> {
    const out = new Map<string, ExternalRefView[]>();
    if (!ids.length) return out;
    const rows = await this.prisma.tx.externalRef.findMany({ where: { entity, entityId: { in: ids } }, orderBy: { createdAt: 'asc' } });
    for (const r of rows) {
      const list = out.get(r.entityId) ?? [];
      list.push({ system: r.system, connector: r.connector, key: r.externalKey, number: r.externalNumber, origin: r.origin });
      out.set(r.entityId, list);
    }
    return out;
  }
}

@Global()
@Module({ providers: [IntegrationEventsService, ExternalRefsService], exports: [IntegrationEventsService, ExternalRefsService] })
export class IntegrationEventsModule {}
