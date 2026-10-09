import { Body, Controller, ForbiddenException, Get, Injectable, Module, OnModuleInit, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser, CurrentUser } from '../../common/auth/decorators';
import { PermissionsService } from '../../common/auth/permissions.service';
import { BusinessRuleException, NotFoundError } from '../../common/errors/errors';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';
import { Paged } from '../../common/http/paged';
import { QueueService } from '../../common/queue/queue.service';
import { env } from '../../config/env';
import { paginationQuery } from '@erp/contracts';
import { ReportOutput, toCsv, toPdf, toXlsx } from './report-export';
import { CATEGORIES, FilterKey, Filters, filterSchema, findReport, REPORTS, ReportDef } from './reports.registry';

const formatSchema = z.object({ format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'), delimiter: z.enum([';', ',']).default(';') });
export const JSON_ROW_CAP = 5000;
export const EXPORT_ROW_CAP = 50000;
const MIME = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' } as const;

const FILTER_LABEL: Record<FilterKey, string> = {
  dateFrom: 'Desde', dateTo: 'Hasta', asOf: 'Al', warehouseId: 'Depósito', categoryId: 'Instancia', supplierId: 'Proveedor', customerId: 'Cliente', productId: 'Producto',
  priceListId: 'Lista', status: 'Estado', search: 'Búsqueda', onlyWithStock: 'Solo con existencia', docType: 'Tipo de documento',
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly perms: PermissionsService, private readonly audit: AuditService) {}

  private async allowed(user: AuthUser): Promise<(c: string) => boolean> {
    if (user.isSuperAdmin) return () => true;
    const have = new Set(await this.perms.forUser(user.userId, user.companyId!));
    return c => have.has(`reports:${c}:read`);
  }

  private async features(): Promise<Record<string, boolean>> {
    const c = await this.prisma.company.findUniqueOrThrow({ where: { id: this.prisma.companyId } });
    return c.features as Record<string, boolean>;
  }

  /** Catálogo de reportes que el usuario puede ver (por permiso y por funciones activas de la empresa). */
  async catalog(user: AuthUser) {
    const can = await this.allowed(user);
    const feat = await this.features();
    return REPORTS.filter(r => can(r.category) && (!r.feature || feat[r.feature])).map(r => ({
      category: r.category, categoryName: CATEGORIES[r.category], id: r.id, title: r.title, description: r.description,
      filters: r.filters, required: r.required ?? [], columns: r.columns,
    }));
  }

  private async filtersText(f: Filters, def: ReportDef): Promise<string[]> {
    const tx = this.prisma.tx;
    const out: string[] = [];
    for (const k of def.filters) {
      const v = f[k];
      if (v === undefined || v === '' || v === false) continue;
      let shown = String(v);
      if (k === 'warehouseId') shown = (await tx.warehouse.findFirst({ where: { id: v as string } }))?.name ?? shown;
      else if (k === 'categoryId') shown = (await tx.category.findFirst({ where: { id: v as string } }))?.name ?? shown;
      else if (k === 'supplierId') shown = (await tx.supplier.findFirst({ where: { id: v as string } }))?.legalName ?? shown;
      else if (k === 'productId') { const p = await tx.product.findFirst({ where: { id: v as string } }); shown = p ? `${p.sku} — ${p.name}` : shown; }
      else if (k === 'priceListId') shown = (await tx.priceList.findFirst({ where: { id: v as string } }))?.name ?? shown;
      else if (k === 'dateFrom' || k === 'dateTo' || k === 'asOf') shown = String(v).split('-').reverse().join('/');
      else if (v === true) shown = 'Sí';
      out.push(`${FILTER_LABEL[k]}: ${shown}`);
    }
    return out;
  }

  /** Valida permiso, existencia, funciones activas y filtros obligatorios; devuelve la definición y los filtros ya tipados. */
  async validate(user: AuthUser, category: string, id: string, rawFilters: unknown) {
    const def = findReport(category, id);
    if (!def) throw new NotFoundError('Reporte', `${category}/${id}`);
    if (!(await this.allowed(user))(category)) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'No tiene permiso para este reporte' });
    const feat = await this.features();
    if (def.feature && !feat[def.feature]) throw new NotFoundError('Reporte', `${category}/${id}`);
    const f = new ZodPipe(filterSchema).transform(rawFilters ?? {}, { type: 'query' });
    const missing = (def.required ?? []).filter(k => f[k] === undefined || f[k] === '');
    if (missing.length) throw new BusinessRuleException(`Falta indicar: ${missing.map(m => FILTER_LABEL[m]).join(', ')}`, 'FILTER_REQUIRED', missing.map(m => ({ field: m, code: 'REQUIRED' })));
    return { def, f, feat };
  }

  async run(user: AuthUser, category: string, id: string, rawFilters: unknown, format: 'json' | 'csv' | 'xlsx' | 'pdf', delimiter: ';' | ',') {
    const { def, f, feat } = await this.validate(user, category, id, rawFilters);
    return this.generate(def, f, feat, format, delimiter);
  }

  /** Ejecuta y da formato al reporte. Requiere el contexto de empresa (transacción de la petición o del worker). `rowCap` sube el tope de exportación (segundo plano). */
  async generate(def: ReportDef, f: Filters, feat: Record<string, boolean>, format: 'json' | 'csv' | 'xlsx' | 'pdf', delimiter: ';' | ',', rowCap?: number) {
    const category = def.category, id = def.id;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    const result = await def.run({ tx: this.prisma.tx, companyId: this.prisma.companyId, f, features: feat, today });
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: this.prisma.companyId } });
    const cap = format === 'json' ? JSON_ROW_CAP : (rowCap ?? EXPORT_ROW_CAP);
    const truncated = result.rows.length > cap;
    const rows = truncated ? result.rows.slice(0, cap) : result.rows;
    const filtersText = await this.filtersText(f, def);
    const out: ReportOutput = {
      title: def.title, companyName: company.legalName, companyRif: company.rif, generatedAt: new Date(), filtersText,
      columns: def.columns, rows, totals: result.totals,
    };
    if (format === 'json') {
      return { kind: 'json' as const, body: { report: { category, id, title: def.title, description: def.description }, columns: def.columns, rows, totals: result.totals ?? null, filters: f, filtersText, rowCount: result.rows.length, truncated, generatedAt: out.generatedAt.toISOString() } };
    }
    const buffer = format === 'csv' ? toCsv(out, delimiter) : format === 'xlsx' ? await toXlsx(out) : await toPdf(out);
    await this.prisma.tx.reportRun.create({ data: { companyId: this.prisma.companyId, userId: this.prisma.userId, category, report: id, format, filters: JSON.parse(JSON.stringify(f)), rowCount: result.rows.length } });
    const stamp = today.replace(/-/g, '');
    return { kind: 'file' as const, buffer, mime: MIME[format], filename: `${category}-${id}-${stamp}.${format}`, rowCount: result.rows.length, truncated };
  }
}

const jobSchema = z.object({
  category: z.string().min(1).max(40), report: z.string().min(1).max(60),
  format: z.enum(['csv', 'xlsx', 'pdf']), delimiter: z.enum([';', ',']).default(';'),
  filters: z.record(z.unknown()).default({}),
});
const jobListSchema = paginationQuery;

interface JobPayload { jobId: string; companyId: string }

/**
 * Reportes pesados en segundo plano: se registra el trabajo, se encola en BullMQ (cola `reports`) y un worker lo genera y guarda el archivo
 * (descargable hasta `REPORT_FILE_TTL_HOURS`). El estado queda en `report_jobs`: QUEUED → RUNNING → DONE | FAILED (| EXPIRED).
 */
@Injectable()
export class ReportJobsService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService, private readonly reports: ReportsService, private readonly queues: QueueService, private readonly audit: AuditService) {}

  onModuleInit() {
    this.queues.worker<JobPayload>('reports', job => this.process(job.data), { concurrency: 2 });
  }

  async create(user: AuthUser, body: z.infer<typeof jobSchema>) {
    const { def } = await this.reports.validate(user, body.category, body.report, body.filters);
    const row = await this.prisma.tx.reportJob.create({
      data: { companyId: this.prisma.companyId, userId: user.userId, category: def.category, report: def.id, format: body.format, delimiter: body.delimiter, filters: JSON.parse(JSON.stringify(body.filters)) },
      select: this.publicFields,
    });
    // `delay`: la fila se crea en la transacción de esta petición; el worker la busca cuando ya está confirmada (y reintenta si aún no).
    await this.queues.queue('reports').add('export', { jobId: row.id, companyId: this.prisma.companyId } satisfies JobPayload, { delay: 700, attempts: 1, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86_400 } });
    await this.audit.log('report_job', row.id, 'CREATE', { category: def.category, report: def.id, format: body.format });
    return row;
  }

  private readonly publicFields = { id: true, category: true, report: true, format: true, status: true, error: true, rowCount: true, truncated: true, filename: true, sizeBytes: true, createdAt: true, startedAt: true, finishedAt: true, expiresAt: true } as const;

  private mine(user: AuthUser) { return user.isSuperAdmin ? {} : { userId: user.userId }; }

  async list(user: AuthUser, q: z.infer<typeof jobListSchema>) {
    const tx = this.prisma.tx;
    const where = { userId: user.userId };
    const [rows, total] = await Promise.all([
      tx.reportJob.findMany({ where, select: this.publicFields, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
      tx.reportJob.count({ where }),
    ]);
    const titles = new Map(REPORTS.map(r => [`${r.category}/${r.id}`, r.title]));
    return Paged.of(rows.map(r => ({ ...r, title: titles.get(`${r.category}/${r.report}`) ?? r.report })), total, q.page, q.limit);
  }

  async get(user: AuthUser, id: string) {
    const row = await this.prisma.tx.reportJob.findFirst({ where: { id, ...this.mine(user) }, select: this.publicFields });
    if (!row) throw new NotFoundError('Exportación', id);
    return row;
  }

  async download(user: AuthUser, id: string) {
    const row = await this.prisma.tx.reportJob.findFirst({ where: { id, ...this.mine(user) } });
    if (!row) throw new NotFoundError('Exportación', id);
    if (row.status === 'EXPIRED') throw new BusinessRuleException('El archivo expiró; genere el reporte de nuevo', 'FILE_EXPIRED');
    if (row.status !== 'DONE' || !row.file) throw new BusinessRuleException(`La exportación no está lista (estado ${row.status})`, 'NOT_READY');
    return { buffer: Buffer.from(row.file), mime: row.mime!, filename: row.filename! };
  }

  /** Procesa un trabajo (worker): la fila puede tardar en verse mientras se confirma la transacción que la creó. */
  async process({ jobId, companyId }: JobPayload) {
    let job = null as Awaited<ReturnType<typeof this.prisma.tx.reportJob.findFirst>>;
    for (let i = 0; i < 8 && !job; i++) {
      job = await this.prisma.runWithTenant(companyId, tx => tx.reportJob.findFirst({ where: { id: jobId } }));
      if (!job) await new Promise(r => setTimeout(r, 500));
    }
    if (!job || job.status !== 'QUEUED') return;
    await this.prisma.runWithTenant(companyId, tx => tx.reportJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: new Date() } }));
    try {
      const user = { userId: job.userId ?? '', companyId, jti: '', exp: 0, isSuperAdmin: true } as AuthUser; // el permiso ya se validó al crear el trabajo
      const out = await this.prisma.runWithTenant(companyId, async () => {
        const { def, f, feat } = await this.reports.validate(user, job!.category, job!.report, job!.filters);
        const r = await this.reports.generate(def, f, feat, job!.format as 'csv' | 'xlsx' | 'pdf', job!.delimiter as ';' | ',', env.REPORT_ASYNC_ROW_CAP);
        if (r.kind !== 'file') throw new Error('formato inválido');
        return r;
      }, { userId: job.userId ?? undefined }, 15 * 60_000);
      await this.prisma.runWithTenant(companyId, tx => tx.reportJob.update({
        where: { id: jobId },
        data: { status: 'DONE', file: new Uint8Array(out.buffer), filename: out.filename, mime: out.mime, sizeBytes: out.buffer.length, rowCount: out.rowCount, truncated: out.truncated, finishedAt: new Date(), expiresAt: new Date(Date.now() + env.REPORT_FILE_TTL_HOURS * 3_600_000) },
      }));
    } catch (e) {
      await this.prisma.runWithTenant(companyId, tx => tx.reportJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: String((e as Error).message ?? e).slice(0, 500), finishedAt: new Date() } }));
    }
  }
}

@ApiTags('reports/jobs') @ApiBearerAuth()
@Controller('reports/jobs')
export class ReportJobsController {
  constructor(private readonly svc: ReportJobsService) {}

  /** Encola la exportación (csv/xlsx/pdf) de un reporte pesado. Responde de inmediato; consulte el estado y descargue cuando esté en DONE. */
  @Post() create(@CurrentUser() u: AuthUser, @ZBody(jobSchema) b: z.infer<typeof jobSchema>) { return this.svc.create(u, b); }
  @Get() list(@CurrentUser() u: AuthUser, @ZQuery(jobListSchema) q: z.infer<typeof jobListSchema>) { return this.svc.list(u, q); }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(z.string().uuid())) id: string) { return this.svc.get(u, id); }
  @Get(':id/download')
  async download(@CurrentUser() u: AuthUser, @Param('id', new ZodPipe(z.string().uuid())) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.download(u, id);
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return new StreamableFile(r.buffer, { type: r.mime });
  }
}

@ApiTags('reports') @ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  /** Catálogo de reportes disponibles para el usuario. */
  @Get() catalog(@CurrentUser() u: AuthUser) { return this.svc.catalog(u); }

  /** `format=json|csv|xlsx|pdf` más los filtros del reporte. Cada exportación queda registrada (report_runs). */
  @Get(':category/:report')
  async run(
    @CurrentUser() u: AuthUser, @Param('category') category: string, @Param('report') report: string, @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { format, delimiter } = new ZodPipe(formatSchema).transform(query, { type: 'query' });
    const r = await this.svc.run(u, category, report, query, format, delimiter);
    if (r.kind === 'json') return r.body;
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return new StreamableFile(r.buffer, { type: r.mime });
  }
}

@Module({ controllers: [ReportJobsController, ReportsController], providers: [ReportsService, ReportJobsService] })
export class ReportsModule {}
