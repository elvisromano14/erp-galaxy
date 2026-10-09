import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Type } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { cancelSchema, INV_DOC_ROUTES, InventoryDocsService, invDocListSchema, invDocSchema, invDocUpdateSchema } from './inventory-docs.service';
import { InventoryQueriesService, kardexQuerySchema, periodSchema, serialHistorySchema, serialsQuerySchema, stockQuerySchema, valuationQuerySchema } from './inventory-queries.service';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';

const id = new ZodPipe(uuid);

function makeDocController(route: (typeof INV_DOC_ROUTES)[number]): Type<unknown> {
  const P = (a: string) => `${route.permission}:${a}`;
  @ApiTags(`inventory/${route.path}`) @ApiBearerAuth()
  @Controller(`inventory/${route.path}`)
  class DocController {
    constructor(readonly svc: InventoryDocsService) {}
    @Get() @RequirePermissions(P('read'))
    list(@ZQuery(invDocListSchema) q: z.infer<typeof invDocListSchema>) { return this.svc.list(route.docType, q); }
    @Get(':id') @RequirePermissions(P('read'))
    get(@Param('id', id) did: string) { return this.svc.get(route.docType, did); }
    @Post() @RequirePermissions(P('create'))
    create(@ZBody(invDocSchema) b: z.infer<typeof invDocSchema>) { return this.svc.create(route.docType, b); }
    @Patch(':id') @RequirePermissions(P('update'))
    update(@Param('id', id) did: string, @ZBody(invDocUpdateSchema) b: z.infer<typeof invDocUpdateSchema>) { return this.svc.update(route.docType, did, b); }
    @Delete(':id') @RequirePermissions(P('update'))
    remove(@Param('id', id) did: string) { return this.svc.remove(route.docType, did); }
    @Post(':id/confirm') @RequirePermissions(P('confirm'))
    confirm(@Param('id', id) did: string) { return this.svc.confirm(route.docType, did); }
    @Post(':id/cancel') @RequirePermissions(P('cancel'))
    cancel(@Param('id', id) did: string, @ZBody(cancelSchema) b: z.infer<typeof cancelSchema>) { return this.svc.cancel(route.docType, did, b.reason); }
  }
  Reflect.defineMetadata('design:paramtypes', [InventoryDocsService], DocController);
  return DocController;
}

export const DocControllers: Type<unknown>[] = INV_DOC_ROUTES.map(makeDocController);

@ApiTags('inventory/adjustments') @ApiBearerAuth()
@Controller('inventory/adjustments')
export class CountSheetController {
  constructor(private readonly docs: InventoryDocsService) {}
  @Get(':id/count-sheet') @RequirePermissions('inventory:adjustments:read')
  sheet(@Param('id', id) did: string) { return this.docs.countSheet(did); }
}

@ApiTags('inventory') @ApiBearerAuth()
@Controller('inventory')
export class InventoryQueriesController {
  constructor(private readonly q: InventoryQueriesService) {}

  @Get('stock') @RequirePermissions('inventory:stock:read')
  stock(@ZQuery(stockQuerySchema) q: z.infer<typeof stockQuerySchema>) { return this.q.stock(q); }

  @Get('kardex') @RequirePermissions('inventory:kardex:read')
  kardex(@ZQuery(kardexQuerySchema) q: z.infer<typeof kardexQuerySchema>) { return this.q.kardex(q); }

  @Get('serials') @RequirePermissions('inventory:serials:read')
  serials(@ZQuery(serialsQuerySchema) q: z.infer<typeof serialsQuerySchema>) { return this.q.serials(q); }

  @Get('serials/history') @RequirePermissions('inventory:serials:read')
  serialHistory(@ZQuery(serialHistorySchema) q: z.infer<typeof serialHistorySchema>) { return this.q.serialHistory(q); }

  @Get('valuation') @RequirePermissions('inventory:valuation:read')
  valuation(@ZQuery(valuationQuerySchema) q: z.infer<typeof valuationQuerySchema>) { return this.q.valuation(q); }

  @Get('periods') @RequirePermissions('inventory:periods:read')
  periods() { return this.q.periods(); }

  @Post('periods/close') @RequirePermissions('inventory:periods:close')
  close(@ZBody(periodSchema) b: z.infer<typeof periodSchema>) { return this.q.closePeriod(b); }

  @Post('periods/reopen') @RequirePermissions('inventory:periods:close')
  reopen(@ZBody(periodSchema) b: z.infer<typeof periodSchema>) { return this.q.reopenPeriod(b); }
}

@ApiTags('products') @ApiBearerAuth()
@Controller('products')
export class ProductInventoryController {
  constructor(private readonly q: InventoryQueriesService) {}
  @Get(':id/stock') @RequirePermissions('inventory:stock:read')
  stock(@Param('id', id) pid: string) { return this.q.productStock(pid); }
  @Get(':id/kardex') @RequirePermissions('inventory:kardex:read')
  kardex(@Param('id', id) pid: string, @ZQuery(kardexQuerySchema.omit({ productId: true })) q: any) { return this.q.kardex({ ...q, productId: pid }); }
}
