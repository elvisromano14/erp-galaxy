import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { uuid } from '@erp/contracts';
import { RequirePermissions } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ZBody, ZQuery } from '../../common/http/zod.decorators';
import { ReceivablesService } from './receivables.service';
import { TreasuryService } from './treasury.service';
import {
  cancelPaymentSchema, ledgerQuery, openingReceivableSchema, openReceivablesQuery, receiptListSchema, receiptSchema, receivableListSchema, movementSchema, openPayablesQuery, paymentListSchema, paymentSchema, reconcileSchema, transferSchema,
} from './treasury.types';

const id = new ZodPipe(uuid);

@ApiTags('treasury') @ApiBearerAuth()
@Controller('treasury')
export class TreasuryController {
  constructor(private readonly svc: TreasuryService, private readonly recv: ReceivablesService) {}

  // ── pagos a proveedores
  @Get('payments') @RequirePermissions('treasury:payments:read')
  listPayments(@ZQuery(paymentListSchema) q: z.infer<typeof paymentListSchema>) { return this.svc.listPayments(q); }
  @Get('payments/:id') @RequirePermissions('treasury:payments:read')
  getPayment(@Param('id', id) pid: string) { return this.svc.getPayment(pid); }
  @Post('payments') @RequirePermissions('treasury:payments:create')
  createPayment(@ZBody(paymentSchema) b: z.infer<typeof paymentSchema>) { return this.svc.createPayment(b); }
  @Post('payments/:id/cancel') @RequirePermissions('treasury:payments:cancel')
  cancelPayment(@Param('id', id) pid: string, @ZBody(cancelPaymentSchema) b: z.infer<typeof cancelPaymentSchema>) { return this.svc.cancelPayment(pid, b.reason); }
  @Get('payables/open') @RequirePermissions('treasury:payments:read')
  openPayables(@ZQuery(openPayablesQuery) q: z.infer<typeof openPayablesQuery>) { return this.svc.openPayables(q.supplierId); }

  // ── bancos
  @Get('accounts/balances') @RequirePermissions('treasury:movements:read')
  balances() { return this.svc.balances(); }
  @Get('accounts/:id/movements') @RequirePermissions('treasury:movements:read')
  ledger(@Param('id', id) aid: string, @ZQuery(ledgerQuery) q: z.infer<typeof ledgerQuery>) { return this.svc.ledger(aid, q); }
  @Post('movements') @RequirePermissions('treasury:movements:create')
  movement(@ZBody(movementSchema) b: z.infer<typeof movementSchema>) { return this.svc.createMovement(b); }
  @Post('transfers') @RequirePermissions('treasury:movements:create')
  transfer(@ZBody(transferSchema) b: z.infer<typeof transferSchema>) { return this.svc.transfer(b); }

  // ── conciliación
  @Get('reconciliations') @RequirePermissions('treasury:reconciliations:read')
  reconciliations(@Query('bankAccountId') accountId?: string) { return this.svc.listReconciliations(accountId); }
  @Post('reconciliations') @RequirePermissions('treasury:reconciliations:create')
  reconcile(@ZBody(reconcileSchema) b: z.infer<typeof reconcileSchema>) { return this.svc.reconcile(b); }

  // ── cuentas por cobrar y cobros
  @Get('receivables') @RequirePermissions('treasury:receivables:read')
  receivables(@ZQuery(receivableListSchema) q: z.infer<typeof receivableListSchema>) { return this.recv.listEntries(q); }
  @Get('receivables/open') @RequirePermissions('treasury:receipts:read')
  openReceivables(@ZQuery(openReceivablesQuery) q: z.infer<typeof openReceivablesQuery>) { return this.recv.openEntries(q.customerId); }
  @Post('receivables/opening') @RequirePermissions('treasury:receivables:create')
  opening(@ZBody(openingReceivableSchema) b: z.infer<typeof openingReceivableSchema>) { return this.recv.createOpening(b); }
  @Post('receivables/:id/cancel') @RequirePermissions('treasury:receivables:create')
  cancelOpening(@Param('id', id) rid: string, @ZBody(cancelPaymentSchema) b: z.infer<typeof cancelPaymentSchema>) { return this.recv.cancelOpening(rid, b.reason); }

  @Get('receipts') @RequirePermissions('treasury:receipts:read')
  receipts(@ZQuery(receiptListSchema) q: z.infer<typeof receiptListSchema>) { return this.recv.listReceipts(q); }
  @Get('receipts/:id') @RequirePermissions('treasury:receipts:read')
  getReceipt(@Param('id', id) rid: string) { return this.recv.getReceipt(rid); }
  @Post('receipts') @RequirePermissions('treasury:receipts:create')
  createReceipt(@ZBody(receiptSchema) b: z.infer<typeof receiptSchema>) { return this.recv.createReceipt(b); }
  @Post('receipts/:id/cancel') @RequirePermissions('treasury:receipts:cancel')
  cancelReceipt(@Param('id', id) rid: string, @ZBody(cancelPaymentSchema) b: z.infer<typeof cancelPaymentSchema>) { return this.recv.cancelReceipt(rid, b.reason); }
}
