import { getStore } from '../../common/db/tenant-context';
import { Body, Controller, ForbiddenException, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ConnectionsService } from './connections.service';
import { ServiceAccountsService } from './service-accounts.service';
import { IntegrationService } from './integration.service';
import { conflictsQuery, conflictStatusSchema, createConnectionSchema, EntityPath, entityPath, eventsQuery, getBatchSchema, refsQuery, reportSchema, runsQuery, saintPriceListsSchema, testResultSchema, updateConnectionSchema, upsertBatchSchema } from './integration.types';

const onlyService = () => {
  if (!getStore().isService) throw new ForbiddenException({ error: 'SERVICE_ACCOUNT_ONLY', message: 'Solo la cuenta de servicio del integrador puede usar esta ruta', details: [] });
};
const entityPipe = new ZodPipe(entityPath);
const idPipe = new ZodPipe(uuid);

/** API de integración (Saint ↔ ERP): lotes idempotentes, referencias externas y eventos de salida. */
@ApiTags('integration') @ApiBearerAuth()
@Controller('integration')
export class IntegrationController {
  constructor(private readonly svc: IntegrationService) {}

  @Post(':entity/upsert-batch') @HttpCode(200) @RequirePermissions('integration:sync:use')
  upsert(@Param('entity', entityPipe) entity: EntityPath, @ZBody(upsertBatchSchema) b: z.infer<typeof upsertBatchSchema>) { return this.svc.upsertBatch(entity, b); }

  @Post(':entity/get-batch') @HttpCode(200) @RequirePermissions('integration:sync:use')
  get(@Param('entity', entityPipe) entity: EntityPath, @ZBody(getBatchSchema) b: z.infer<typeof getBatchSchema>) { return this.svc.getBatch(entity, b); }

  /** Crea (de forma idempotente) las listas de precio de Saint de la empresa y devuelve sus identificadores. */
  @Post('setup/saint-price-lists') @HttpCode(200) @RequirePermissions('integration:sync:use')
  priceLists(@ZBody(saintPriceListsSchema) b: z.infer<typeof saintPriceListsSchema>) { return this.svc.ensureSaintPriceLists(b); }

  @Get('refs') @RequirePermissions('integration:sync:use')
  refs(@ZQuery(refsQuery) q: z.infer<typeof refsQuery>) { return this.svc.refs(q); }

  @Get('events') @RequirePermissions('integration:sync:use')
  events(@ZQuery(eventsQuery) q: z.infer<typeof eventsQuery>) { return this.svc.listEvents(q); }

  @Get('status') @RequirePermissions('integration:sync:use')
  status() { return this.svc.status(); }

  /** Pausa o reanuda toda la integración de la empresa (solo quien administra cuentas de servicio). */
  @Post('enabled') @HttpCode(200) @RequirePermissions('security:service-accounts:update')
  enabled(@ZBody(z.object({ enabled: z.boolean() })) b: { enabled: boolean }) { return this.svc.setEnabled(b.enabled); }
}

@ApiTags('integration') @ApiBearerAuth()
@Controller('integration/service-accounts')
export class ServiceAccountsController {
  constructor(private readonly svc: ServiceAccountsService) {}

  @Get() @RequirePermissions('security:service-accounts:read')
  list() { return this.svc.list(); }

  @Post() @RequirePermissions('security:service-accounts:create')
  create(@ZBody(z.object({ name: z.string().trim().min(2).max(80) })) b: { name: string }) { return this.svc.create(b.name); }

  @Post(':id/rotate') @HttpCode(200) @RequirePermissions('security:service-accounts:update')
  rotate(@Param('id', idPipe) id: string) { return this.svc.rotate(id); }

  @Post(':id/revoke') @HttpCode(200) @RequirePermissions('security:service-accounts:update')
  revoke(@Param('id', idPipe) id: string) { return this.svc.revoke(id); }
}

/**
 * Rutas fijas de integración que no son una entidad (`/integration/connections`, `/integration/monitor`, `/integration/runtime`).
 * Se declaran antes que `:entity/...` en el módulo para que el enrutador no las confunda.
 */
@ApiTags('integration') @ApiBearerAuth()
@Controller('integration/connections')
export class ConnectionsController {
  constructor(private readonly svc: ConnectionsService) {}

  @Get() @RequirePermissions('integration:connections:read')
  list() { return this.svc.list(); }

  @Get(':id') @RequirePermissions('integration:connections:read')
  get(@Param('id', idPipe) id: string) { return this.svc.get(id); }

  @Post() @RequirePermissions('integration:connections:create')
  create(@ZBody(createConnectionSchema) b: z.infer<typeof createConnectionSchema>) { return this.svc.create(b); }

  @Patch(':id') @RequirePermissions('integration:connections:update')
  update(@Param('id', idPipe) id: string, @ZBody(updateConnectionSchema) b: z.infer<typeof updateConnectionSchema>) { return this.svc.update(id, b); }

  @Delete(':id') @RequirePermissions('integration:connections:delete')
  remove(@Param('id', idPipe) id: string) { return this.svc.remove(id); }

  @Post(':id/test') @HttpCode(200) @RequirePermissions('integration:connections:update')
  test(@Param('id', idPipe) id: string) { return this.svc.requestTest(id); }
}

@ApiTags('integration') @ApiBearerAuth()
@Controller('integration/monitor')
export class MonitorController {
  constructor(private readonly svc: ConnectionsService) {}

  @Get() @RequirePermissions('integration:monitor:read')
  summary() { return this.svc.monitor(); }

  @Get('runs') @RequirePermissions('integration:monitor:read')
  runs(@ZQuery(runsQuery) q: z.infer<typeof runsQuery>) { return this.svc.runs(q); }

  @Get('conflicts') @RequirePermissions('integration:monitor:read')
  conflicts(@ZQuery(conflictsQuery) q: z.infer<typeof conflictsQuery>) { return this.svc.conflicts(q); }

  @Post('conflicts/:id/status') @HttpCode(200) @RequirePermissions('integration:monitor:update')
  status(@Param('id', idPipe) id: string, @ZBody(conflictStatusSchema) b: z.infer<typeof conflictStatusSchema>) { return this.svc.setConflictStatus(id, b); }
}

/** Lo que usa el integrador (cuenta de servicio): configuración con la clave descifrada, resultado de pruebas e informes. */
@ApiTags('integration') @ApiBearerAuth()
@Controller('integration/runtime')
export class RuntimeController {
  constructor(private readonly svc: ConnectionsService, private readonly integration: IntegrationService) {}

  /** Entrega claves descifradas: solo la cuenta de servicio (ni siquiera un administrador con todos los permisos). */
  @Get('connections') @RequirePermissions('integration:sync:use')
  async connections() {
    onlyService();
    const enabled = await this.integration.isEnabled();
    return { paused: !enabled, connections: enabled ? await this.svc.runtime() : [] };
  }

  @Post('connections/:id/test-result') @HttpCode(200) @RequirePermissions('integration:sync:use')
  testResult(@Param('id', idPipe) id: string, @ZBody(testResultSchema) b: z.infer<typeof testResultSchema>) { onlyService(); return this.svc.saveTestResult(id, b); }

  @Post('report') @HttpCode(200) @RequirePermissions('integration:sync:use')
  report(@ZBody(reportSchema) b: z.infer<typeof reportSchema>) { onlyService(); return this.svc.report(b); }
}
