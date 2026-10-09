import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Type } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { PurchasesService } from './purchases.service';
import {
  cancelSchema, PurchaseRoute, PURCHASE_ROUTES, purchaseDocSchema, purchaseDocUpdateSchema, purchaseListSchema, receiveSchema,
} from './purchases.types';

const id = new ZodPipe(uuid);

/**
 * Un controlador por tipo de documento (erp-v3 §11.2). Acciones específicas:
 *  quotes: send / accept / reject / convert-to-order · orders: receive · delivery-notes: convert-to-purchase.
 */
function makeController(route: PurchaseRoute): Type<unknown> {
  const P = (a: string) => `${route.permission}:${a}`;
  const t = route.docType;

  @ApiTags(route.path) @ApiBearerAuth()
  @Controller(route.path)
  class DocController {
    constructor(readonly svc: PurchasesService) {}

    @Get() @RequirePermissions(P('read'))
    list(@Query(new ZodPipe(purchaseListSchema)) q: z.infer<typeof purchaseListSchema>) { return this.svc.list(t, q); }

    @Get(':id') @RequirePermissions(P('read'))
    get(@Param('id', id) did: string) { return this.svc.get(t, did); }

    @Post() @RequirePermissions(P('create'))
    create(@Body(new ZodPipe(purchaseDocSchema)) b: z.infer<typeof purchaseDocSchema>) { return this.svc.create(t, b); }

    @Patch(':id') @RequirePermissions(P('update'))
    update(@Param('id', id) did: string, @Body(new ZodPipe(purchaseDocUpdateSchema)) b: z.infer<typeof purchaseDocUpdateSchema>) { return this.svc.update(t, did, b as any); }

    @Delete(':id') @RequirePermissions(P('update'))
    remove(@Param('id', id) did: string) { return this.svc.remove(t, did); }

    @Post(':id/cancel') @RequirePermissions(P('cancel'))
    cancel(@Param('id', id) did: string, @Body(new ZodPipe(cancelSchema)) b: z.infer<typeof cancelSchema>) { return this.svc.cancel(t, did, b.reason); }
  }
  Reflect.defineMetadata('design:paramtypes', [PurchasesService], DocController);
  return DocController;
}

// `confirm` no aplica a cotizaciones (se envían). Se añade por separado para mantener los permisos claros.
@ApiTags('purchases/confirm') @ApiBearerAuth()
@Controller()
export class PurchaseConfirmController {
  constructor(private readonly svc: PurchasesService) {}
  @Post('purchases/orders/:id/confirm') @RequirePermissions('purchases:orders:confirm')
  order(@Param('id', id) did: string) { return this.svc.confirm('ORDER', did); }
  @Post('purchases/delivery-notes/:id/confirm') @RequirePermissions('purchases:delivery-notes:confirm')
  deliveryNote(@Param('id', id) did: string) { return this.svc.confirm('DELIVERY_NOTE', did); }
  @Post('purchases/delivery-note-returns/:id/confirm') @RequirePermissions('purchases:delivery-note-returns:confirm')
  deliveryNoteReturn(@Param('id', id) did: string) { return this.svc.confirm('DELIVERY_NOTE_RETURN', did); }
  @Post('purchases/returns/:id/confirm') @RequirePermissions('purchases:returns:confirm')
  purchaseReturn(@Param('id', id) did: string) { return this.svc.confirm('PURCHASE_RETURN', did); }
  @Post('purchases/:id/confirm') @RequirePermissions('purchases:invoices:confirm')
  purchase(@Param('id', id) did: string) { return this.svc.confirm('PURCHASE', did); }
}

@ApiTags('purchases/actions') @ApiBearerAuth()
@Controller('purchases')
export class PurchaseActionsController {
  constructor(private readonly svc: PurchasesService) {}

  @Post('quotes/:id/send') @RequirePermissions('purchases:quotes:confirm')
  send(@Param('id', id) did: string) { return this.svc.quoteAction(did, 'send'); }
  @Post('quotes/:id/accept') @RequirePermissions('purchases:quotes:confirm')
  accept(@Param('id', id) did: string) { return this.svc.quoteAction(did, 'accept'); }
  @Post('quotes/:id/reject') @RequirePermissions('purchases:quotes:confirm')
  reject(@Param('id', id) did: string) { return this.svc.quoteAction(did, 'reject'); }
  @Post('quotes/:id/convert-to-order') @RequirePermissions('purchases:orders:create')
  toOrder(@Param('id', id) did: string) { return this.svc.convertQuoteToOrder(did); }

  @Post('orders/:id/receive') @RequirePermissions('purchases:delivery-notes:create', 'purchases:delivery-notes:confirm')
  receive(@Param('id', id) did: string, @Body(new ZodPipe(receiveSchema)) b: z.infer<typeof receiveSchema>) { return this.svc.receive(did, b); }

  @Post('delivery-notes/:id/convert-to-purchase') @RequirePermissions('purchases:invoices:create')
  toPurchase(@Param('id', id) did: string) { return this.svc.convertDeliveryNoteToPurchase(did); }
}

// Orden de registro: acciones y confirmaciones primero; `purchases` (compras) al final.
export const PurchaseControllers: Type<unknown>[] = [
  PurchaseActionsController, PurchaseConfirmController, ...PURCHASE_ROUTES.map(makeController),
];
