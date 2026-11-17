import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { env } from '../../config/env';
import { PrismaService } from '../../common/db/prisma.service';
import { QueueService } from '../../common/queue/queue.service';
import { ProductsService } from './products.service';

/**
 * Mantiene al día las listas de precio derivadas (Bs): la tasa cambia, el precio en Bs cambia.
 * Corre cada FX_SYNC_INTERVAL_MINUTES (tras la sincronización del BCV) y a las 00:05 de Caracas (tasa del nuevo día).
 * Solo escribe los precios que cambian, así que es barato cuando la tasa no se movió.
 */
@Injectable()
export class PriceRecalcScheduler implements OnApplicationBootstrap {
  private readonly log = new Logger('PriceRecalc');
  constructor(private readonly prisma: PrismaService, private readonly products: ProductsService, private readonly queues: QueueService) {}

  async recomputeAllCompanies(): Promise<number> {
    const companies = await this.prisma.db.company.findMany({ where: { isActive: true }, select: { id: true } });
    let changed = 0;
    for (const c of companies) {
      try {
        const r = await this.prisma.runWithTenant(c.id, () => this.products.recomputeDerivedLists());
        changed += r.reduce((a, x) => a + x.changed, 0);
      } catch (e) { this.log.warn(`Empresa ${c.id}: ${(e as Error).message}`); }
    }
    return changed;
  }

  async onApplicationBootstrap() {
    if (!env.JOBS_ENABLED) return;
    const q = this.queues.queue('price-recalc');
    const base = { removeOnComplete: 10, removeOnFail: 50 };
    try {
      await q.upsertJobScheduler('recalc-interval', { every: env.FX_SYNC_INTERVAL_MINUTES * 60_000 }, { name: 'recalc', opts: base });
      await q.upsertJobScheduler('recalc-daily', { pattern: '5 0 * * *', tz: 'America/Caracas' }, { name: 'recalc', opts: base });
    } catch (e) { this.log.warn(`No se pudo programar el recálculo de listas: ${(e as Error).message}`); }
    this.queues.worker('price-recalc', async () => {
      const n = await this.recomputeAllCompanies();
      if (n) this.log.log(`Precios derivados recalculados: ${n}`);
    });
  }
}
