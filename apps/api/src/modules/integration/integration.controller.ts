import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ServiceAccountsService } from './service-accounts.service';
import { IntegrationService } from './integration.service';
import { EntityPath, entityPath, eventsQuery, getBatchSchema, refsQuery, saintPriceListsSchema, upsertBatchSchema } from './integration.types';

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
