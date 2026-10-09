import { Body, Controller, Get, Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Decimal } from '@erp/domain';
import { z } from 'zod';
import { decimalStr, paginationQuery, uuid } from '@erp/contracts';
import { env } from '../../config/env';
import { PrismaService } from '../../common/db/prisma.service';
import { RedisService } from '../../common/db/redis.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequirePermissions } from '../../common/auth/decorators';
import { BusinessRuleException } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Las tasas MANUALES son de la empresa que las carga; las del BCV son globales y las trae la sincronización. */
const createSchema = z.object({
  currencyId: uuid, rate: decimalStr.refine(v => Number(v) > 0, 'La tasa debe ser positiva'), date,
});
const listSchema = paginationQuery.extend({ currencyId: uuid.optional(), dateFrom: date.optional(), dateTo: date.optional(), source: z.enum(['MANUAL', 'BCV']).optional() });
const latestSchema = z.object({ currencyId: uuid.optional(), currencyCode: z.string().length(3).optional(), date: date.optional() });

@Injectable()
export class ExchangeRatesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /**
   * Tasa Bs por unidad vigente a la fecha. VES siempre 1.
   * Gana la más reciente por fecha; en la misma fecha, la MANUAL de la empresa prevalece sobre la del BCV;
   * y entre iguales, la cargada al último. (RLS: solo ve las globales y las de su empresa.)
   */
  async rateFor(currencyId: string, onDate: Date): Promise<{ rate: string; date: Date; source: string } | null> {
    const cur = await this.prisma.currency.findUnique({ where: { id: currencyId } });
    if (!cur) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
    if (cur.code === 'VES') return { rate: '1', date: onDate, source: 'BASE' };
    const rows = await this.prisma.db.$queryRaw<{ rate: string; date: Date; source: string }[]>`
      SELECT rate::text AS rate, date, source FROM exchange_rates
      WHERE currency_id = ${currencyId}::uuid AND date <= ${onDate}::date
      ORDER BY date DESC, (company_id IS NOT NULL) DESC, created_at DESC LIMIT 1`;
    return rows[0] ? { ...rows[0], rate: new Decimal(rows[0].rate).toString() } : null;
  }

  async create(b: z.infer<typeof createSchema>) {
    const cur = await this.prisma.currency.findUnique({ where: { id: b.currencyId } });
    if (!cur) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
    if (cur.code === 'VES') throw new BusinessRuleException('La moneda base (VES) no tiene tasa de cambio', 'BASE_CURRENCY_RATE');
    // Historial inmutable: cada carga agrega una fila (la última de la fecha prevalece).
    const row = await this.prisma.db.exchangeRate.create({
      data: { currencyId: b.currencyId, rate: b.rate, date: new Date(b.date), source: 'MANUAL', companyId: this.prisma.companyId, createdBy: this.prisma.userId },
    });
    await this.audit.log('exchange_rate', row.id, 'CREATE', b);
    return row;
  }

  async list(q: z.infer<typeof listSchema>) {
    const where = {
      ...(q.currencyId ? { currencyId: q.currencyId } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...((q.dateFrom || q.dateTo) ? { date: { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) } } : {}),
    };
    const db = this.prisma.db;
    const [rows, total] = await Promise.all([
      db.exchangeRate.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      db.exchangeRate.count({ where }),
    ]);
    return Paged.of(rows.map(r => ({ ...r, isGlobal: r.companyId === null })), total, q.page, q.limit);
  }

  async latest(q: z.infer<typeof latestSchema>) {
    let currencyId = q.currencyId;
    if (!currencyId && q.currencyCode) {
      currencyId = (await this.prisma.currency.findUnique({ where: { code: q.currencyCode.toUpperCase() } }))?.id;
    }
    if (!currencyId) throw new BusinessRuleException('Indique currencyId o currencyCode', 'CURRENCY_REQUIRED');
    const onDate = q.date ? new Date(q.date) : new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }));
    const r = await this.rateFor(currencyId, onDate);
    if (!r) throw new BusinessRuleException('No hay tasa de cambio cargada para esa moneda', 'RATE_NOT_FOUND');
    return { currencyId, rate: r.rate, date: r.date.toISOString().slice(0, 10), source: r.source };
  }
}

interface DolarApiItem { moneda: string; fuente: string; promedio: number | null; fechaActualizacion: string }

/**
 * Sincroniza la tasa OFICIAL (BCV) desde DolarApi (https://ve.dolarapi.com) para USD y EUR.
 * Inserta filas GLOBALES (company_id NULL, source BCV); no pisa las manuales de ninguna empresa.
 */
@Injectable()
export class BcvSyncService {
  private readonly log = new Logger('BcvSync');
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async fetchOne(path: string): Promise<DolarApiItem> {
    const res = await fetch(`${env.FX_API_URL}${path}`, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`DolarApi respondió ${res.status}`);
    return (await res.json()) as DolarApiItem;
  }

  async syncNow(): Promise<{ currency: string; rate: string; date: string; status: 'INSERTED' | 'UNCHANGED' | 'SKIPPED'; reason?: string }[]> {
    const results: { currency: string; rate: string; date: string; status: 'INSERTED' | 'UNCHANGED' | 'SKIPPED'; reason?: string }[] = [];
    const errors: string[] = [];
    for (const [code, path] of [['USD', '/dolares/oficial'], ['EUR', '/euros/oficial']] as const) {
      try {
        const item = await this.fetchOne(path);
        const rate = item.promedio;
        if (!rate || !(rate > 0) || !Number.isFinite(rate)) { results.push({ currency: code, rate: '', date: '', status: 'SKIPPED', reason: 'sin tasa publicada' }); continue; }
        const rateDate = /^(\d{4}-\d{2}-\d{2})/.exec(item.fechaActualizacion)?.[1];
        if (!rateDate) { results.push({ currency: code, rate: String(rate), date: '', status: 'SKIPPED', reason: 'fecha inválida' }); continue; }
        const currency = await this.prisma.currency.findUnique({ where: { code } });
        if (!currency) { results.push({ currency: code, rate: String(rate), date: rateDate, status: 'SKIPPED', reason: 'moneda no registrada' }); continue; }
        // Sin contexto de empresa (cliente global del pool): solo ve/inserta filas globales.
        const last = await this.prisma.exchangeRate.findFirst({ where: { currencyId: currency.id, date: new Date(rateDate), companyId: null, source: 'BCV' }, orderBy: { createdAt: 'desc' } });
        if (last && Number(last.rate) === rate) { results.push({ currency: code, rate: String(rate), date: rateDate, status: 'UNCHANGED' }); continue; }
        await this.prisma.exchangeRate.create({ data: { currencyId: currency.id, rate: String(rate), date: new Date(rateDate), source: 'BCV', companyId: null } });
        results.push({ currency: code, rate: String(rate), date: rateDate, status: 'INSERTED' });
      } catch (e) {
        errors.push(`${code}: ${(e as Error).message}`);
      }
    }
    if (errors.length && !results.length) throw new BusinessRuleException(`No se pudo consultar DolarApi (${errors.join('; ')}). Cargue la tasa manualmente.`, 'FX_SOURCE_UNAVAILABLE');
    if (errors.length) this.log.warn(errors.join('; '));
    return results;
  }
}

@ApiTags('exchange-rates') @ApiBearerAuth()
@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(private readonly svc: ExchangeRatesService, private readonly sync: BcvSyncService, private readonly audit: AuditService) {}
  @Get() @RequirePermissions('admin:exchange-rates:read')
  list(@ZQuery(listSchema) q: z.infer<typeof listSchema>) { return this.svc.list(q); }
  @Get('latest') @RequirePermissions('admin:exchange-rates:read')
  latest(@ZQuery(latestSchema) q: z.infer<typeof latestSchema>) { return this.svc.latest(q); }
  /** Tasa manual de la empresa activa (prevalece sobre la del BCV de la misma fecha). */
  @Post() @RequirePermissions('admin:exchange-rates:create')
  create(@ZBody(createSchema) b: z.infer<typeof createSchema>) { return this.svc.create(b); }
  /** Consulta ahora la tasa oficial (BCV) en DolarApi. */
  @Post('sync') @RequirePermissions('admin:exchange-rates:create')
  async syncNow() {
    const r = await this.sync.syncNow();
    await this.audit.log('exchange_rate', undefined, 'SYNC_BCV', r);
    return r;
  }
}

/** Planificador ligero (sin dependencias): sincroniza al arrancar y cada FX_SYNC_INTERVAL_MINUTES; con candado en Redis. */
@Injectable()
export class BcvScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('BcvScheduler');
  private timer?: NodeJS.Timeout;
  constructor(private readonly sync: BcvSyncService, private readonly redis: RedisService) {}

  onApplicationBootstrap() {
    if (!env.FX_SYNC_ENABLED) return;
    const tick = async () => {
      const ok = await this.redis.client.set('lock:fx-sync', '1', 'EX', 120, 'NX').catch(() => null);
      if (!ok) return;
      try {
        const r = await this.sync.syncNow();
        this.log.log(`Tasas BCV: ${r.map(x => `${x.currency}=${x.rate || '-'} ${x.status}`).join(', ')}`);
      } catch (e) {
        this.log.warn((e as Error).message);
      }
    };
    setTimeout(tick, 10_000).unref();
    this.timer = setInterval(tick, env.FX_SYNC_INTERVAL_MINUTES * 60_000);
    this.timer.unref();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }
}

@Module({
  controllers: [ExchangeRatesController],
  providers: [ExchangeRatesService, BcvSyncService, BcvScheduler],
  exports: [ExchangeRatesService, BcvSyncService],
})
export class ExchangeRatesModule {}
