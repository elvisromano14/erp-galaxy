import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { D, Decimal, round, ZERO } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { SequenceService } from '../../common/db/sequence.service';
import { BusinessRuleException, NotFoundError } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { ExchangeRatesService } from '../catalogs/exchange-rates';
import { caracasToday } from '../inventory/inventory-docs.service';
import { TreasuryService } from './treasury.service';
import { NewReceivable, openingReceivableSchema, receiptListSchema, ReceiptInput, receivableListSchema } from './treasury.types';

const entryStatus = (balance: Decimal, amount: Decimal) => (balance.isZero() ? 'PAID' : balance.eq(amount) ? 'OPEN' : 'PARTIALLY_PAID');

@Injectable()
export class ReceivablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly seq: SequenceService,
    private readonly rates: ExchangeRatesService,
    private readonly treasury: TreasuryService,
  ) {}

  private async rateOf(currencyId: string, date: Date) {
    const r = await this.rates.rateFor(currencyId, date);
    if (!r) throw new BusinessRuleException('No hay tasa de cambio para la moneda y fecha indicadas', 'RATE_NOT_FOUND');
    return D(r.rate);
  }

  // ═════════════════════════ asientos ═════════════════════════

  /** Crea un asiento por cobrar (lo usarán las facturas y notas; hoy, los saldos iniciales). */
  async createEntry(e: NewReceivable) {
    const row = await this.prisma.tx.receivableEntry.create({
      data: {
        companyId: this.prisma.companyId, customerId: e.customerId, entryType: e.entryType, sourceType: e.sourceType ?? null, sourceId: e.sourceId ?? null, documentNo: e.documentNo,
        issueDate: e.issueDate, dueDate: e.dueDate, currencyId: e.currencyId, exchangeRate: e.exchangeRate, amount: e.amount, balance: e.amount, status: 'OPEN', notes: e.notes ?? null, createdBy: this.prisma.userId,
      },
    });
    return row;
  }

  async createOpening(input: z.infer<typeof openingReceivableSchema>) {
    const tx = this.prisma.tx;
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, deletedAt: null } });
    if (!customer) throw new BusinessRuleException('Cliente inexistente', 'CUSTOMER_NOT_FOUND');
    const issue = new Date(input.issueDate);
    const due = new Date(input.dueDate ?? new Date(issue.getTime() + customer.creditDays * 86_400_000).toISOString().slice(0, 10));
    if (due < issue) throw new BusinessRuleException('El vencimiento no puede ser anterior a la emisión', 'INVALID_DUE_DATE', [{ field: 'dueDate', code: 'INVALID' }]);
    const cur = await this.prisma.currency.findUnique({ where: { id: input.currencyId } });
    if (!cur) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
    const rate = cur.code === 'VES' ? '1' : input.exchangeRate ?? (await this.rateOf(input.currencyId, issue)).toString();
    const dup = await tx.receivableEntry.findFirst({ where: { customerId: input.customerId, entryType: 'OPENING', documentNo: input.documentNo, status: { not: 'CANCELLED' } } });
    if (dup) throw new BusinessRuleException('Ya existe un saldo inicial con ese número de documento para el cliente', 'DUPLICATE_DOCUMENT', [{ field: 'documentNo', code: 'DUPLICATE' }]);
    const row = await this.createEntry({ customerId: input.customerId, entryType: 'OPENING', documentNo: input.documentNo, issueDate: issue, dueDate: due, currencyId: input.currencyId, exchangeRate: rate, amount: D(input.amount).toFixed(4), notes: input.notes });
    await this.audit.log('receivable_entry', row.id, 'CREATE', input);
    return row;
  }

  async cancelOpening(id: string, reason: string) {
    const tx = this.prisma.tx;
    await tx.$queryRaw`SELECT id FROM receivable_entries WHERE id = ${id}::uuid AND company_id = ${this.prisma.companyId}::uuid FOR UPDATE`;
    const e = await tx.receivableEntry.findFirst({ where: { id } });
    if (!e) throw new NotFoundError('Cuenta por cobrar', id);
    if (e.entryType !== 'OPENING') throw new BusinessRuleException('Solo se anulan saldos iniciales; los demás asientos se anulan con su documento', 'INVALID_ENTRY_TYPE');
    if (e.status === 'CANCELLED') throw new BusinessRuleException('El asiento ya está anulado', 'INVALID_STATE');
    if (!D(e.balance.toString()).eq(D(e.amount.toString()))) throw new BusinessRuleException('El asiento tiene cobros aplicados; anule primero los cobros', 'HAS_APPLICATIONS');
    await tx.receivableEntry.update({ where: { id }, data: { status: 'CANCELLED', balance: '0', notes: `${e.notes ?? ''}${e.notes ? ' · ' : ''}Anulado: ${reason}` } });
    await this.audit.log('receivable_entry', id, 'CANCEL', { reason });
    return tx.receivableEntry.findFirstOrThrow({ where: { id } });
  }

  async listEntries(q: z.infer<typeof receivableListSchema>) {
    const tx = this.prisma.tx;
    const where: Prisma.ReceivableEntryWhereInput = {};
    if (q.customerId) where.customerId = q.customerId;
    if (q.onlyOpen) where.status = { in: ['OPEN', 'PARTIALLY_PAID'] };
    else if (q.status) where.status = { in: q.status.split(',') };
    if (q.search) where.documentNo = { contains: q.search, mode: 'insensitive' };
    const [rows, total] = await Promise.all([
      tx.receivableEntry.findMany({ where, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      tx.receivableEntry.count({ where }),
    ]);
    const cust = new Map((await tx.customer.findMany({ where: { id: { in: [...new Set(rows.map(r => r.customerId))] } }, select: { id: true, legalName: true } })).map(c => [c.id, c.legalName]));
    const cur = new Map((await this.prisma.currency.findMany({ where: { id: { in: [...new Set(rows.map(r => r.currencyId))] } } })).map(c => [c.id, c.code]));
    return Paged.of(rows.map(r => ({ ...r, customerName: cust.get(r.customerId) ?? null, currency: cur.get(r.currencyId) })), total, q.page, q.limit);
  }

  async openEntries(customerId: string) {
    const tx = this.prisma.tx;
    const entries = await tx.receivableEntry.findMany({ where: { customerId, status: { in: ['OPEN', 'PARTIALLY_PAID'] }, NOT: { balance: 0 } }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }] });
    const cur = new Map((await this.prisma.currency.findMany({ where: { id: { in: [...new Set(entries.map(e => e.currencyId))] } } })).map(c => [c.id, c.code]));
    return entries.map(e => ({ ...e, currency: cur.get(e.currencyId) }));
  }

  /** Saldo por cobrar abierto del cliente en moneda base (a la tasa de cada documento). */
  async exposureBase(customerId: string): Promise<Decimal> {
    const [r] = await this.prisma.tx.$queryRaw<{ s: string }[]>`
      SELECT COALESCE(SUM(balance * exchange_rate), 0)::text AS s FROM receivable_entries
      WHERE company_id = ${this.prisma.companyId}::uuid AND customer_id = ${customerId}::uuid AND status IN ('OPEN', 'PARTIALLY_PAID')`;
    return D(r.s);
  }

  // ═════════════════════════ cobros ═════════════════════════

  async createReceipt(input: ReceiptInput) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, deletedAt: null } });
    if (!customer) throw new BusinessRuleException('Cliente inexistente', 'CUSTOMER_NOT_FOUND');
    const method = await tx.paymentMethod.findFirst({ where: { id: input.paymentMethodId, deletedAt: null, isActive: true } });
    if (!method) throw new BusinessRuleException('Instrumento de pago inexistente o inactivo', 'PAYMENT_METHOD_NOT_FOUND');
    if (method.type === 'CREDIT') throw new BusinessRuleException('Este instrumento no sirve para registrar cobros', 'PAYMENT_METHOD_INVALID');
    if ((method.requiresReference || method.type === 'WITHHOLDING') && !input.reference?.trim()) throw new BusinessRuleException('El instrumento de pago requiere referencia', 'REFERENCE_REQUIRED', [{ field: 'reference', code: 'REQUIRED' }]);
    const date = new Date(input.receiptDate ?? caracasToday());
    const currency = await this.prisma.currency.findUnique({ where: { id: input.currencyId } });
    if (!currency) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
    const rcRate = currency.code === 'VES' ? D(1) : input.exchangeRate ? D(input.exchangeRate) : await this.rateOf(input.currencyId, date);

    const ids = input.applications.map(a => a.receivableEntryId);
    if (new Set(ids).size !== ids.length) throw new BusinessRuleException('Una cuenta por cobrar aparece repetida', 'DUPLICATE_APPLICATION');
    await tx.$queryRaw`SELECT id FROM receivable_entries WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const entries = new Map((await tx.receivableEntry.findMany({ where: { id: { in: ids } } })).map(e => [e.id, e]));

    let total = ZERO;
    const apps = [] as { entryId: string; amount: Decimal; amountReceipt: Decimal; newBalance: Decimal; entryAmount: Decimal }[];
    const rateCache = new Map<string, Decimal>();
    for (const [i, a] of input.applications.entries()) {
      const bad = (code: string, msg: string) => new BusinessRuleException(msg, code, [{ field: `applications[${i}]`, code }]);
      const e = entries.get(a.receivableEntryId);
      if (!e) throw bad('RECEIVABLE_NOT_FOUND', 'Cuenta por cobrar inexistente');
      if (e.customerId !== input.customerId) throw bad('CUSTOMER_MISMATCH', 'La cuenta por cobrar es de otro cliente');
      if (!['OPEN', 'PARTIALLY_PAID'].includes(e.status)) throw bad('RECEIVABLE_NOT_OPEN', `La cuenta por cobrar está ${e.status}`);
      const amount = D(a.amount); const balance = D(e.balance.toString());
      if (balance.isZero() || amount.isNegative() !== balance.isNegative()) throw bad('INVALID_APPLICATION_SIGN', 'El monto debe tener el mismo signo que el saldo de la cuenta');
      if (amount.abs().gt(balance.abs())) throw bad('EXCEEDS_BALANCE', `El monto excede el saldo de la cuenta (${balance.toString()})`);
      let amountReceipt = amount;
      if (e.currencyId !== input.currencyId) {
        if (!rateCache.has(e.currencyId)) rateCache.set(e.currencyId, await this.rateOf(e.currencyId, date));
        amountReceipt = round(amount.mul(rateCache.get(e.currencyId)!).div(rcRate), 4);
      }
      total = total.plus(amountReceipt);
      apps.push({ entryId: e.id, amount, amountReceipt, newBalance: balance.minus(amount), entryAmount: D(e.amount.toString()) });
    }
    if (total.isNegative()) throw new BusinessRuleException('Los saldos a favor aplicados superan lo que se cobra', 'NEGATIVE_RECEIPT');

    // Una retención entregada por el cliente no mueve banco; lo demás entra a una cuenta de la misma moneda.
    const movesBank = total.gt(0) && method.type !== 'WITHHOLDING';
    let account = null;
    if (movesBank) {
      if (!input.bankAccountId) throw new BusinessRuleException('Indique la cuenta bancaria (o caja) donde ingresa el cobro', 'BANK_ACCOUNT_REQUIRED', [{ field: 'bankAccountId', code: 'REQUIRED' }]);
      account = await this.treasury.activeAccount(input.bankAccountId, true);
      if (account.currencyId !== input.currencyId) throw new BusinessRuleException('La cuenta bancaria es de otra moneda que el cobro', 'BANK_CURRENCY_MISMATCH', [{ field: 'bankAccountId', code: 'CURRENCY_MISMATCH' }]);
    }

    const number = await this.seq.next('CUSTOMER_RECEIPT');
    const rc = await tx.customerReceipt.create({
      data: {
        companyId, number, customerId: input.customerId, receiptDate: date, paymentMethodId: method.id, bankAccountId: account?.id ?? null, currencyId: input.currencyId,
        exchangeRate: rcRate.toFixed(8), amount: total.toFixed(4), reference: input.reference?.trim() || null, notes: input.notes ?? null, createdBy: this.prisma.userId,
      },
    });
    await tx.customerReceiptApplication.createMany({ data: apps.map(a => ({ companyId, receiptId: rc.id, receivableEntryId: a.entryId, amount: a.amount.toFixed(4), amountReceipt: a.amountReceipt.toFixed(4) })) });
    for (const a of apps) await tx.receivableEntry.update({ where: { id: a.entryId }, data: { balance: a.newBalance.toFixed(4), status: entryStatus(a.newBalance, a.entryAmount) } });
    if (account) {
      await this.treasury.addMovement({ bankAccountId: account.id, date, kind: 'CUSTOMER_RECEIPT', amount: total, reference: input.reference ?? number, description: `Cobro ${number} de ${customer.legalName}`, sourceType: 'CUSTOMER_RECEIPT', sourceId: rc.id });
    }
    await this.audit.log('customer_receipt', rc.id, 'CREATE', input);
    return this.getReceipt(rc.id);
  }

  async getReceipt(id: string) {
    const tx = this.prisma.tx;
    const rc = await tx.customerReceipt.findFirst({ where: { id } });
    if (!rc) throw new NotFoundError('Cobro', id);
    const apps = await tx.customerReceiptApplication.findMany({ where: { receiptId: id } });
    const entries = new Map((await tx.receivableEntry.findMany({ where: { id: { in: apps.map(a => a.receivableEntryId) } } })).map(e => [e.id, e]));
    const [customer, method, account] = await Promise.all([
      tx.customer.findFirst({ where: { id: rc.customerId }, select: { id: true, rif: true, legalName: true } }),
      tx.paymentMethod.findFirst({ where: { id: rc.paymentMethodId }, select: { id: true, code: true, name: true, type: true } }),
      rc.bankAccountId ? tx.bankAccount.findFirst({ where: { id: rc.bankAccountId }, select: { id: true, name: true, number: true } }) : null,
    ]);
    return {
      ...rc, customer, method, account,
      applications: apps.map(a => { const e = entries.get(a.receivableEntryId); return { ...a, entryType: e?.entryType, documentNo: e?.documentNo, balanceNow: e?.balance }; }),
    };
  }

  async listReceipts(q: z.infer<typeof receiptListSchema>) {
    const tx = this.prisma.tx;
    const where: Prisma.CustomerReceiptWhereInput = {};
    if (q.customerId) where.customerId = q.customerId;
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.dateFrom || q.dateTo) where.receiptDate = { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) };
    if (q.search) where.OR = [{ number: { contains: q.search, mode: 'insensitive' } }, { reference: { contains: q.search, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      tx.customerReceipt.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      tx.customerReceipt.count({ where }),
    ]);
    const cust = new Map((await tx.customer.findMany({ where: { id: { in: [...new Set(rows.map(r => r.customerId))] } }, select: { id: true, legalName: true } })).map(c => [c.id, c.legalName]));
    return Paged.of(rows.map(r => ({ ...r, customerName: cust.get(r.customerId) ?? null })), total, q.page, q.limit);
  }

  async cancelReceipt(id: string, reason: string) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    await tx.$queryRaw`SELECT id FROM customer_receipts WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`;
    const rc = await tx.customerReceipt.findFirst({ where: { id } });
    if (!rc) throw new NotFoundError('Cobro', id);
    if (rc.status === 'CANCELLED') throw new BusinessRuleException('El cobro ya está anulado', 'INVALID_STATE');
    const mov = await tx.bankMovement.findFirst({ where: { sourceType: 'CUSTOMER_RECEIPT', sourceId: id, reversalOf: null } });
    if (mov) {
      if (await tx.bankReconciliationItem.findFirst({ where: { movementId: mov.id } })) throw new BusinessRuleException('El cobro ya fue conciliado con el banco; no se puede anular', 'RECEIPT_RECONCILED');
      await this.treasury.activeAccount(mov.bankAccountId, true);
    }
    const apps = await tx.customerReceiptApplication.findMany({ where: { receiptId: id }, orderBy: { receivableEntryId: 'asc' } });
    await tx.$queryRaw`SELECT id FROM receivable_entries WHERE company_id = ${companyId}::uuid AND id = ANY(${apps.map(a => a.receivableEntryId)}::uuid[]) ORDER BY id FOR UPDATE`;
    for (const a of apps) {
      const e = await tx.receivableEntry.findFirstOrThrow({ where: { id: a.receivableEntryId } });
      if (e.status === 'CANCELLED') throw new BusinessRuleException('Una cuenta por cobrar del cobro fue anulada; no se puede revertir', 'RECEIVABLE_CANCELLED');
      const bal = D(e.balance.toString()).plus(D(a.amount.toString()));
      await tx.receivableEntry.update({ where: { id: e.id }, data: { balance: bal.toFixed(4), status: entryStatus(bal, D(e.amount.toString())) } });
    }
    if (mov) {
      await this.treasury.addMovement({ bankAccountId: mov.bankAccountId, date: new Date(caracasToday()), kind: 'REVERSAL', amount: D(mov.amount.toString()).neg(), reference: rc.number, description: `Anulación del cobro ${rc.number}`, sourceType: 'CUSTOMER_RECEIPT', sourceId: id, reversalOf: mov.id });
    }
    await tx.customerReceipt.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: this.prisma.userId, cancelReason: reason } });
    await this.audit.log('customer_receipt', id, 'CANCEL', { reason });
    return this.getReceipt(id);
  }
}
