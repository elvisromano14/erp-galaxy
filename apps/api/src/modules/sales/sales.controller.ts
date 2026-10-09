import { Controller, Delete, Get, Param, Patch, Post, Res, StreamableFile, Type } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { PermissionsService } from '../../common/auth/permissions.service';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';
import { InvoicingService } from './invoicing.service';
import { SalesService } from './sales.service';
import {
  SalesRoute, SALES_ROUTES, salesCancelSchema, salesDocSchema, salesDocUpdateSchema, salesListSchema, confirmSchema, confirmInvoiceSchema, creditNoteSchema, debitNoteSchema, pdfQuery, Viewer,
} from './sales.types';

const id = new ZodPipe(uuid);

async function viewerOf(perms: PermissionsService, u: AuthUser): Promise<Viewer> {
  if (u.isSuperAdmin) return { userId: u.userId, all: true, creditOverride: true };
  const have = await perms.forUser(u.userId, u.companyId!);
  return { userId: u.userId, all: have.includes('sales:documents:read-all'), creditOverride: have.includes('sales:orders:credit-override') };
}

/** Lectura por tipo de documento; los vendedores sin `sales:documents:read-all` solo ven los suyos. */
function makeReadController(route: SalesRoute): Type<unknown> {
  const P = (a: string) => `${route.permission}:${a}`;
  const t = route.docType;

  @ApiTags(route.path) @ApiBearerAuth()
  @Controller(route.path)
  class ReadController {
    constructor(readonly svc: SalesService, readonly perms: PermissionsService) {}

    @Get() @RequirePermissions(P('read'))
    async list(@CurrentUser() u: AuthUser, @ZQuery(salesListSchema) q: z.infer<typeof salesListSchema>) { return this.svc.list(t, q, await viewerOf(this.perms, u)); }

    @Get(':id') @RequirePermissions(P('read'))
    async get(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.get(t, did, await viewerOf(this.perms, u)); }
  }
  Reflect.defineMetadata('design:paramtypes', [SalesService, PermissionsService], ReadController);
  return ReadController;
}

/** Alta/edición/baja de borradores. Las notas de crédito solo nacen de una factura (endpoint propio) y las facturas se anulan por el suyo. */
function makeWriteController(route: SalesRoute): Type<unknown> {
  const P = (a: string) => `${route.permission}:${a}`;
  const t = route.docType;

  @ApiTags(route.path) @ApiBearerAuth()
  @Controller(route.path)
  class WriteController {
    constructor(readonly svc: SalesService, readonly perms: PermissionsService) {}

    @Post() @RequirePermissions(P('create'))
    async create(@CurrentUser() u: AuthUser, @ZBody(salesDocSchema) b: z.infer<typeof salesDocSchema>) { return this.svc.create(t, b, await viewerOf(this.perms, u)); }

    @Patch(':id') @RequirePermissions(P('update'))
    async update(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(salesDocUpdateSchema) b: z.infer<typeof salesDocUpdateSchema>) {
      return this.svc.update(t, did, b as any, await viewerOf(this.perms, u));
    }

    @Delete(':id') @RequirePermissions(P('update'))
    async remove(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.remove(t, did, await viewerOf(this.perms, u)); }

    @Post(':id/cancel') @RequirePermissions(P('cancel'))
    async cancel(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(salesCancelSchema) b: z.infer<typeof salesCancelSchema>) {
      return this.svc.cancel(t, did, b.reason, await viewerOf(this.perms, u));
    }
  }
  Reflect.defineMetadata('design:paramtypes', [SalesService, PermissionsService], WriteController);
  return WriteController;
}

@ApiTags('sales/actions') @ApiBearerAuth()
@Controller('sales')
export class SalesActionsController {
  constructor(private readonly svc: SalesService, private readonly inv: InvoicingService, private readonly perms: PermissionsService) {}

  @Post('quotes/:id/send') @RequirePermissions('sales:quotes:confirm')
  async send(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.quoteAction(did, 'send', await viewerOf(this.perms, u)); }
  @Post('quotes/:id/accept') @RequirePermissions('sales:quotes:confirm')
  async accept(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.quoteAction(did, 'accept', await viewerOf(this.perms, u)); }
  @Post('quotes/:id/reject') @RequirePermissions('sales:quotes:confirm')
  async reject(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.quoteAction(did, 'reject', await viewerOf(this.perms, u)); }
  @Post('quotes/:id/convert-to-budget') @RequirePermissions('sales:budgets:create')
  async quoteToBudget(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.convert('QUOTE', 'BUDGET', did, await viewerOf(this.perms, u)); }
  @Post('quotes/:id/convert-to-order') @RequirePermissions('sales:orders:create')
  async quoteToOrder(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.convert('QUOTE', 'ORDER', did, await viewerOf(this.perms, u)); }

  @Post('budgets/:id/confirm') @RequirePermissions('sales:budgets:confirm')
  async confirmBudget(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(confirmSchema) b: z.infer<typeof confirmSchema>) { return this.svc.confirm('BUDGET', did, await viewerOf(this.perms, u), b.overrideCredit); }
  @Post('budgets/:id/convert-to-order') @RequirePermissions('sales:orders:create')
  async budgetToOrder(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.svc.convert('BUDGET', 'ORDER', did, await viewerOf(this.perms, u)); }

  @Post('orders/:id/confirm') @RequirePermissions('sales:orders:confirm')
  async confirmOrder(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(confirmSchema) b: z.infer<typeof confirmSchema>) { return this.svc.confirm('ORDER', did, await viewerOf(this.perms, u), b.overrideCredit); }

  // ── facturación
  @Post('orders/:id/convert-to-invoice') @RequirePermissions('sales:invoices:create')
  async orderToInvoice(@CurrentUser() u: AuthUser, @Param('id', id) did: string) { return this.inv.invoiceFromOrder(did, await viewerOf(this.perms, u)); }

  @Post('invoices/:id/confirm') @RequirePermissions('sales:invoices:confirm')
  async confirmInvoice(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(confirmInvoiceSchema) b: z.infer<typeof confirmInvoiceSchema>) { return this.inv.confirmInvoice(did, await viewerOf(this.perms, u), b); }

  @Post('invoices/:id/cancel') @RequirePermissions('sales:invoices:cancel')
  async cancelInvoice(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(salesCancelSchema) b: z.infer<typeof salesCancelSchema>) { return this.inv.cancelInvoice(did, b.reason, await viewerOf(this.perms, u)); }

  @Post('invoices/:id/credit-note') @RequirePermissions('sales:credit-notes:create', 'sales:credit-notes:confirm')
  async creditNote(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(creditNoteSchema) b: z.infer<typeof creditNoteSchema>) { return this.inv.createCreditNote(did, b, await viewerOf(this.perms, u)); }

  @Post('invoices/:id/debit-note') @RequirePermissions('sales:debit-notes:create')
  async debitNote(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZBody(debitNoteSchema) b: z.infer<typeof debitNoteSchema>) { return this.inv.createDebitNote(did, b, await viewerOf(this.perms, u)); }

  @Get('debit-notes/:id/pdf') @RequirePermissions('sales:debit-notes:read')
  async debitNotePdf(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZQuery(pdfQuery) q: z.infer<typeof pdfQuery>, @Res({ passthrough: true }) res: Response) {
    return this.sendPdf(res, await this.inv.pdf('DEBIT_NOTE', did, q.format, await viewerOf(this.perms, u)));
  }

  @Get('invoices/:id/pdf') @RequirePermissions('sales:invoices:read')
  async invoicePdf(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZQuery(pdfQuery) q: z.infer<typeof pdfQuery>, @Res({ passthrough: true }) res: Response) {
    return this.sendPdf(res, await this.inv.pdf('INVOICE', did, q.format, await viewerOf(this.perms, u)));
  }

  @Get('credit-notes/:id/pdf') @RequirePermissions('sales:credit-notes:read')
  async creditNotePdf(@CurrentUser() u: AuthUser, @Param('id', id) did: string, @ZQuery(pdfQuery) q: z.infer<typeof pdfQuery>, @Res({ passthrough: true }) res: Response) {
    return this.sendPdf(res, await this.inv.pdf('CREDIT_NOTE', did, q.format, await viewerOf(this.perms, u)));
  }

  private sendPdf(res: Response, r: { buffer: Buffer; filename: string }) {
    res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return new StreamableFile(r.buffer, { type: 'application/pdf' });
  }
}

// Orden de registro: acciones primero (rutas más específicas), luego lectura/escritura por tipo.
export const SalesControllers: Type<unknown>[] = [
  SalesActionsController,
  ...SALES_ROUTES.map(makeReadController),
  ...SALES_ROUTES.filter(r => !['CREDIT_NOTE', 'DEBIT_NOTE'].includes(r.docType)).map(makeWriteController),
];
