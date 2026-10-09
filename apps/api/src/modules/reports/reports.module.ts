import { Controller, ForbiddenException, Get, Injectable, Module, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser, CurrentUser } from '../../common/auth/decorators';
import { PermissionsService } from '../../common/auth/permissions.service';
import { BusinessRuleException, NotFoundError } from '../../common/errors/errors';
import { ZodPipe } from '../../common/http/zod.pipe';
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

  async run(user: AuthUser, category: string, id: string, rawFilters: unknown, format: 'json' | 'csv' | 'xlsx' | 'pdf', delimiter: ';' | ',') {
    const def = findReport(category, id);
    if (!def) throw new NotFoundError('Reporte', `${category}/${id}`);
    if (!(await this.allowed(user))(category)) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'No tiene permiso para este reporte' });
    const feat = await this.features();
    if (def.feature && !feat[def.feature]) throw new NotFoundError('Reporte', `${category}/${id}`);
    const f = new ZodPipe(filterSchema).transform(rawFilters ?? {}, { type: 'query' });
    const missing = (def.required ?? []).filter(k => f[k] === undefined || f[k] === '');
    if (missing.length) throw new BusinessRuleException(`Falta indicar: ${missing.map(m => FILTER_LABEL[m]).join(', ')}`, 'FILTER_REQUIRED', missing.map(m => ({ field: m, code: 'REQUIRED' })));

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    const result = await def.run({ tx: this.prisma.tx, companyId: this.prisma.companyId, f, features: feat, today });
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: this.prisma.companyId } });
    const cap = format === 'json' ? JSON_ROW_CAP : EXPORT_ROW_CAP;
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
    return { kind: 'file' as const, buffer, mime: MIME[format], filename: `${category}-${id}-${stamp}.${format}` };
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

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
