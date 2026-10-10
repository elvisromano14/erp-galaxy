import { BadRequestException, Controller, Get, Injectable, Module, Param, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { env } from '../../config/env';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser, CurrentUser } from '../../common/auth/decorators';
import { PermissionsService } from '../../common/auth/permissions.service';
import { BusinessRuleException, NotFoundError } from '../../common/errors/errors';
import { ZQuery } from '../../common/http/zod.decorators';
import { InventoryDocsService } from '../inventory/inventory-docs.service';
import { InventoryModule } from '../inventory/inventory.module';
import { MAX_IMPORT_ROWS, parseImportFile } from './import-file';
import { findImportType, IMPORT_TYPES, ImportCtx, ImportTypeDef, Planned } from './import-types';

const runQuery = z.object({ mode: z.enum(['validate', 'commit']).default('validate'), onExisting: z.enum(['skip', 'update']).default('skip') });
const templateQuery = z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') });
const MAX_BYTES = 10 * 1024 * 1024;

@Injectable()
export class ImportsService {
  constructor(private readonly prisma: PrismaService, private readonly perms: PermissionsService, private readonly audit: AuditService, private readonly docs: InventoryDocsService) {}

  private async can(user: AuthUser, def: ImportTypeDef) {
    if (user.isSuperAdmin) return true;
    const have = new Set(await this.perms.forUser(user.userId, user.companyId!));
    return have.has('admin:import:create') && have.has(def.permission);
  }

  async catalog(user: AuthUser) {
    const out = [];
    for (const t of IMPORT_TYPES) if (await this.can(user, t)) out.push({ key: t.key, title: t.title, description: t.description, supportsExisting: t.supportsExisting, columns: t.columns, maxRows: MAX_IMPORT_ROWS });
    return out;
  }

  async template(user: AuthUser, key: string, format: 'xlsx' | 'csv') {
    const def = findImportType(key);
    if (!def || !(await this.can(user, def))) throw new NotFoundError('Plantilla', key);
    if (format === 'csv') {
      const text = '﻿' + def.columns.map(c => c.header).join(';') + '\r\n';
      return { buffer: Buffer.from(text, 'utf8'), mime: 'text/csv; charset=utf-8', filename: `plantilla-${key}.csv` };
    }
    const wb = new ExcelJS.Workbook(); wb.creator = 'Mini ERP';
    const style = (row: ExcelJS.Row, req: boolean[]) => {
      row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      row.eachCell((cell, i) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: req[i - 1] ? 'FFD92D20' : 'FF465FFF' } }; });
    };
    const data = wb.addWorksheet('Datos');
    style(data.addRow(def.columns.map(c => c.header)), def.columns.map(c => !!c.required));
    data.views = [{ state: 'frozen', ySplit: 1 }];
    def.columns.forEach((c, i) => { data.getColumn(i + 1).width = Math.max(c.header.length + 4, 16); });
    const ex = wb.addWorksheet('Ejemplo');
    style(ex.addRow(def.columns.map(c => c.header)), def.columns.map(c => !!c.required));
    ex.addRow(def.columns.map(c => c.example));
    ex.columns.forEach(col => { col.width = 22; });
    const ins = wb.addWorksheet('Instrucciones');
    ins.addRow([`Plantilla de importación: ${def.title}`]).font = { bold: true, size: 13 };
    ins.addRow([def.description]); ins.addRow([`Hasta ${MAX_IMPORT_ROWS} filas por archivo. Llene la hoja «Datos» (los encabezados en rojo son obligatorios). No cambie los nombres de las columnas.`]);
    ins.addRow(['Decimales: se aceptan 1234.56 o 1.234,56. Listas (códigos de barras, seriales): separe con coma, | o ; (en un CSV separado por «;», use coma o | dentro de la celda)']); ins.addRow([]);
    const h = ins.addRow(['Columna', 'Obligatoria', 'Descripción', 'Ejemplo']); h.font = { bold: true };
    for (const c of def.columns) ins.addRow([c.header, c.required ? 'Sí' : 'No', c.help, c.example]);
    [30, 12, 70, 34].forEach((w, i) => { ins.getColumn(i + 1).width = w; });
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `plantilla-${key}.xlsx` };
  }

  async run(user: AuthUser, key: string, file: Express.Multer.File | undefined, mode: 'validate' | 'commit', onExisting: 'skip' | 'update') {
    const def = findImportType(key);
    if (!def || !(await this.can(user, def))) throw new NotFoundError('Tipo de importación', key);
    if (!file) throw new BadRequestException({ error: 'FILE_REQUIRED', message: 'Adjunte el archivo en el campo «file»' });
    let parsed;
    try { parsed = await parseImportFile(file.buffer, file.originalname); } catch (e) { throw new BusinessRuleException((e as Error).message, 'INVALID_FILE'); }
    if (!parsed.rows.length) throw new BusinessRuleException('El archivo no tiene filas de datos', 'EMPTY_FILE');
    if (parsed.rows.length > MAX_IMPORT_ROWS) throw new BusinessRuleException(`El archivo tiene ${parsed.rows.length} filas; el máximo es ${MAX_IMPORT_ROWS}. Divídalo en varios`, 'TOO_MANY_ROWS');
    const missing = def.columns.filter(c => c.required && !parsed.headers.includes(c.header));
    if (missing.length) throw new BusinessRuleException(`Faltan columnas obligatorias: ${missing.map(m => m.header).join(', ')}`, 'MISSING_COLUMNS', missing.map(m => ({ field: m.header, code: 'MISSING_COLUMN' })));
    const unknown = parsed.headers.filter(h => h && !def.columns.some(c => c.header === h));

    const ctx: ImportCtx = { prisma: this.prisma, tx: this.prisma.tx, companyId: this.prisma.companyId, userId: this.prisma.userId, docs: this.docs, today: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }) };
    const planned = await def.plan(ctx, parsed.rows, { onExisting });
    const summary = {
      total: planned.length, create: planned.filter(p => p.action === 'create' && !p.errors.length).length, update: planned.filter(p => p.action === 'update').length,
      skip: planned.filter(p => p.action === 'skip').length, errors: planned.filter(p => p.errors.length).length, warnings: planned.filter(p => p.warnings.length).length,
    };
    const brief = (p: Planned) => ({ row: p.row, label: p.label, action: p.errors.length ? 'error' : p.action, errors: p.errors, warnings: p.warnings });
    const problems = planned.filter(p => p.errors.length || p.warnings.length);
    const rowsOut = [...problems.slice(0, 300), ...planned.filter(p => !p.errors.length && !p.warnings.length).slice(0, 15)].map(brief).sort((a, b) => a.row - b.row);
    const base = { type: key, filename: file.originalname, unknownColumns: unknown, summary, rows: rowsOut, truncated: problems.length > 300 };

    if (mode === 'validate') return { ...base, committed: false };
    if (summary.errors) {
      throw new BusinessRuleException(`El archivo tiene ${summary.errors} fila(s) con errores; corrija y vuelva a validar. No se importó nada`, 'IMPORT_HAS_ERRORS',
        planned.filter(p => p.errors.length).slice(0, 20).flatMap(p => p.errors.map(e => ({ field: `fila ${p.row}`, code: 'ROW_ERROR', message: e }))));
    }
    // Todo o nada: la aplicación corre dentro de la transacción de la petición.
    const result = await def.apply(ctx, planned.filter(p => p.action !== 'skip'));
    await this.audit.log('import', undefined, 'COMMIT', { type: key, file: file.originalname, ...summary, ...result });
    return { ...base, committed: true, result };
  }
}

@ApiTags('imports') @ApiBearerAuth()
@Controller('imports')
export class ImportsController {
  constructor(private readonly svc: ImportsService) {}

  /** Tipos de importación disponibles para el usuario, con sus columnas. */
  @Get('types') types(@CurrentUser() u: AuthUser) { return this.svc.catalog(u); }

  @Get(':type/template')
  async template(@CurrentUser() u: AuthUser, @Param('type') type: string, @ZQuery(templateQuery) q: z.infer<typeof templateQuery>, @Res({ passthrough: true }) res: Response) {
    const t = await this.svc.template(u, type, q.format);
    res.setHeader('Content-Disposition', `attachment; filename="${t.filename}"`);
    return new StreamableFile(t.buffer, { type: t.mime });
  }

  /** `mode=validate` (por defecto) no escribe nada; `mode=commit` importa todo o nada. Archivo .xlsx o .csv en el campo `file`. */
  @Post(':type')
  @Throttle({ default: { limit: env.THROTTLE_HEAVY_PER_MIN, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } }))
  run(@CurrentUser() u: AuthUser, @Param('type') type: string, @UploadedFile() file: Express.Multer.File | undefined, @ZQuery(runQuery) q: z.infer<typeof runQuery>) {
    return this.svc.run(u, type, file, q.mode, q.onExisting);
  }
}

@Module({ imports: [InventoryModule], controllers: [ImportsController], providers: [ImportsService] })
export class ImportsModule {}
