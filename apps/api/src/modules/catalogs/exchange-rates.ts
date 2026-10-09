import { Body, Controller, Get, Injectable, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { decimalStr, paginationQuery, uuid } from '@erp/contracts';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequirePermissions } from '../../common/auth/decorators';
import { BusinessRuleException } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const createSchema = z.object({
  currencyId: uuid, rate: decimalStr.refine(v => Number(v) > 0, 'La tasa debe ser positiva'),
  date, source: z.enum(['MANUAL', 'BCV', 'API']).default('MANUAL'),
});
const listSchema = paginationQuery.extend({ currencyId: uuid.optional(), dateFrom: date.optional(), dateTo: date.optional() });
const latestSchema = z.object({ currencyId: uuid.optional(), currencyCode: z.string().length(3).optional(), date: date.optional() });

@Injectable()
export class ExchangeRatesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Tasa Bs por unidad vigente a la fecha (la última cargada para esa fecha o anterior). VES siempre 1. */
  async rateFor(currencyId: string, onDate: Date): Promise<{ rate: string; date: Date } | null> {
    const cur = await this.prisma.currency.findUnique({ where: { id: currencyId } });
    if (!cur) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
    if (cur.code === 'VES') return { rate: '1', date: onDate };
    const row = await this.prisma.exchangeRate.findFirst({
      where: { currencyId, date: { lte: onDate } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return row ? { rate: row.rate.toString(), date: row.date } : null;
  }

  async create(b: z.infer<typeof createSchema>) {
    const cur = await this.prisma.currency.findUnique({ where: { id: b.currencyId } });
    if (!cur) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
    if (cur.code === 'VES') throw new BusinessRuleException('La moneda base (VES) no tiene tasa de cambio', 'BASE_CURRENCY_RATE');
    // Historial inmutable: cada carga agrega una fila (la última de la fecha prevalece).
    const row = await this.prisma.exchangeRate.create({
      data: { currencyId: b.currencyId, rate: b.rate, date: new Date(b.date), source: b.source, createdBy: this.prisma.userId },
    });
    await this.audit.log('exchange_rate', row.id, 'CREATE', b);
    return row;
  }

  async list(q: z.infer<typeof listSchema>) {
    const where = {
      ...(q.currencyId ? { currencyId: q.currencyId } : {}),
      ...((q.dateFrom || q.dateTo) ? { date: { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.exchangeRate.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.exchangeRate.count({ where }),
    ]);
    return Paged.of(rows, total, q.page, q.limit);
  }

  async latest(q: z.infer<typeof latestSchema>) {
    let currencyId = q.currencyId;
    if (!currencyId && q.currencyCode) {
      currencyId = (await this.prisma.currency.findUnique({ where: { code: q.currencyCode.toUpperCase() } }))?.id;
    }
    if (!currencyId) throw new BusinessRuleException('Indique currencyId o currencyCode', 'CURRENCY_REQUIRED');
    const onDate = q.date ? new Date(q.date) : new Date(new Date().toISOString().slice(0, 10));
    const r = await this.rateFor(currencyId, onDate);
    if (!r) throw new BusinessRuleException('No hay tasa de cambio cargada para esa moneda', 'RATE_NOT_FOUND');
    return { currencyId, rate: r.rate, date: r.date.toISOString().slice(0, 10) };
  }
}

@ApiTags('exchange-rates') @ApiBearerAuth()
@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(private readonly svc: ExchangeRatesService) {}
  @Get() @RequirePermissions('admin:exchange-rates:read')
  list(@ZQuery(listSchema) q: z.infer<typeof listSchema>) { return this.svc.list(q); }
  @Get('latest') @RequirePermissions('admin:exchange-rates:read')
  latest(@ZQuery(latestSchema) q: z.infer<typeof latestSchema>) { return this.svc.latest(q); }
  @Post() @RequirePermissions('admin:exchange-rates:create')
  create(@ZBody(createSchema) b: z.infer<typeof createSchema>) { return this.svc.create(b); }
}

@Module({ controllers: [ExchangeRatesController], providers: [ExchangeRatesService], exports: [ExchangeRatesService] })
export class ExchangeRatesModule {}
