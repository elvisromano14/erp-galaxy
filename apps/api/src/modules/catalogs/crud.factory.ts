import { Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Query, Type } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z, ZodObject, ZodRawShape } from 'zod';
import { paginationQuery, uuid } from '@erp/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { RequirePermissions } from '../../common/auth/decorators';
import { PrismaService } from '../../common/db/prisma.service';
import { NotFoundError, ValidationError } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';

/**
 * Generador de CRUD estándar para catálogos (erp-v3 §11.2):
 *   GET /, GET /:id, POST /, PATCH /:id, DELETE /:id (baja lógica), POST /:id/restore
 * Los datos siempre se filtran por RLS (empresa activa); `companyId` se inyecta al crear.
 */
export interface CrudConfig<S extends ZodRawShape> {
  path: string;                      // ruta bajo /api/v1
  entity: string;                    // etiqueta para mensajes / auditoría
  model: string;                     // delegate de Prisma (camelCase)
  permission: string;                // p. ej. 'admin:products' → :read/:create/:update/:delete
  create: ZodObject<S>;
  update?: ZodObject<any>;           // por defecto create.partial()
  searchFields: string[];
  sortable: string[];
  defaultSort?: string;
  filterable?: string[];             // ?filter[x]=
  softDelete?: boolean;              // usa deletedAt
  global?: boolean;                  // tabla sin company_id
  /** Hook previo a crear/actualizar (validaciones de negocio, normalización). */
  beforeSave?: (data: any, ctx: { prisma: PrismaService; id?: string; isCreate: boolean }) => Promise<any> | any;
  /** Campos Decimal / fecha que llegan como string. */
  dateFields?: string[];
}

const idPipe = new ZodPipe(uuid);

export function makeCrud<S extends ZodRawShape>(cfg: CrudConfig<S>): Type<unknown> {
  const createSchema = cfg.create;
  const updateSchema = cfg.update ?? cfg.create.partial();
  const listQuery = paginationQuery.extend({ filter: z.record(z.string()).optional(), includeDeleted: z.coerce.boolean().optional() });
  const model = cfg.model;

  @Injectable()
  class Service {
    constructor(readonly prisma: PrismaService, readonly audit: AuditService) {}
    delegate() { return (this.prisma.db as any)[model]; }

    private convert(data: Record<string, unknown>) {
      for (const f of cfg.dateFields ?? []) if (typeof data[f] === 'string') data[f] = new Date(data[f] as string);
      return data;
    }

    async list(q: z.infer<typeof listQuery>) {
      const where: Record<string, unknown> = {};
      if (cfg.softDelete && !q.includeDeleted) where.deletedAt = null;
      if (q.search && cfg.searchFields.length) {
        where.OR = cfg.searchFields.map(f => ({ [f]: { contains: q.search, mode: 'insensitive' } }));
      }
      for (const [k, v] of Object.entries(q.filter ?? {})) {
        if (!(cfg.filterable ?? []).includes(k)) throw new ValidationError(`Filtro no permitido: ${k}`, [{ field: `filter.${k}`, code: 'FILTER_NOT_ALLOWED' }]);
        where[k] = v === 'true' ? true : v === 'false' ? false : v;
      }
      const orderBy = this.parseSort(q.sort);
      const [rows, total] = await Promise.all([
        this.delegate().findMany({ where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit }),
        this.delegate().count({ where }),
      ]);
      return Paged.of(rows, total, q.page, q.limit);
    }

    private parseSort(sort?: string) {
      const raw = sort ?? cfg.defaultSort ?? cfg.sortable[0];
      return raw.split(',').filter(Boolean).map(s => {
        const desc = s.startsWith('-');
        const field = desc ? s.slice(1) : s;
        if (!cfg.sortable.includes(field)) throw new ValidationError(`Orden no permitido: ${field}`, [{ field: 'sort', code: 'SORT_NOT_ALLOWED' }]);
        return { [field]: desc ? 'desc' : 'asc' };
      });
    }

    async get(id: string) {
      const row = await this.delegate().findFirst({ where: { id } });
      if (!row) throw new NotFoundError(cfg.entity, id);
      return row;
    }

    async create(input: Record<string, unknown>) {
      let data = this.convert({ ...input });
      if (cfg.beforeSave) data = (await cfg.beforeSave(data, { prisma: this.prisma, isCreate: true })) ?? data;
      if (!cfg.global) data.companyId = this.prisma.companyId;
      const row = await this.delegate().create({ data });
      await this.audit.log(cfg.entity, row.id, 'CREATE', input);
      return row;
    }

    async update(id: string, input: Record<string, unknown>) {
      await this.get(id);
      let data = this.convert({ ...input });
      if (cfg.beforeSave) data = (await cfg.beforeSave(data, { prisma: this.prisma, id, isCreate: false })) ?? data;
      const row = await this.delegate().update({ where: { id }, data });
      await this.audit.log(cfg.entity, id, 'UPDATE', input);
      return row;
    }

    async remove(id: string) {
      await this.get(id);
      if (cfg.softDelete) await this.delegate().update({ where: { id }, data: { deletedAt: new Date() } });
      else await this.delegate().delete({ where: { id } });
      await this.audit.log(cfg.entity, id, 'DELETE');
    }

    async restore(id: string) {
      const row = await this.delegate().findFirst({ where: { id } });
      if (!row) throw new NotFoundError(cfg.entity, id);
      const restored = await this.delegate().update({ where: { id }, data: { deletedAt: null } });
      await this.audit.log(cfg.entity, id, 'RESTORE');
      return restored;
    }
  }

  const P = (a: string) => cfg.permission + ':' + a;

  @ApiTags(cfg.path) @ApiBearerAuth()
  @Controller(cfg.path)
  class CrudController {
    constructor(readonly svc: Service) {}

    @Get() @RequirePermissions(P('read'))
    list(@ZQuery(listQuery) q: z.infer<typeof listQuery>) { return this.svc.list(q); }

    @Get(':id') @RequirePermissions(P('read'))
    get(@Param('id', idPipe) id: string) { return this.svc.get(id); }

    @Post() @RequirePermissions(P('create'))
    create(@ZBody(createSchema) b: Record<string, unknown>) { return this.svc.create(b); }

    @Patch(':id') @RequirePermissions(P('update'))
    update(@Param('id', idPipe) id: string, @ZBody(updateSchema) b: Record<string, unknown>) { return this.svc.update(id, b); }

    @Delete(':id') @RequirePermissions(P('delete'))
    remove(@Param('id', idPipe) id: string) { return this.svc.remove(id); }

    @Post(':id/restore') @RequirePermissions(P('update'))
    restore(@Param('id', idPipe) id: string) { return this.svc.restore(id); }
  }

  // Nest resuelve el constructor por metadatos de diseño: forzar el tipo del servicio en el controlador dinámico.
  Reflect.defineMetadata('design:paramtypes', [Service], CrudController);
  Reflect.defineMetadata('design:paramtypes', [PrismaService, AuditService], Service);
  (CrudController as any).__service = Service;
  return CrudController;
}
