import { randomUUID } from 'node:crypto';
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
import { ledgerQuery, movementSchema, paymentListSchema, PaymentInput, reconcileSchema, transferSchema } from './treasury.types';

const entryStatus = (balance: Decimal, amount: Decimal) => (balance.isZero() ? 'PAID' : balance.eq(amount) ? 'OPEN' : 'PARTIALLY_PAID');

@Injectable()
export class TreasuryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly seq: SequenceService,
    private readonly rates: ExchangeRatesService,
  ) {}

  private async rateOf(currencyId: string, date: Date) {
    const r = await this.rates.rateFor(currencyId, date);
    if (!r) throw new BusinessRuleException('No hay tasa de cambio para la moneda y fecha indicadas', 'RATE_NOT_FOUND');
    return D(r.rate);
  }

  /** Cuenta bancaria activa (con bloqueo opcional); la usan pagos y cobros. */
  activeAccount(id: string, lock = false) { return this.account(id, lock); }

  private async account(id: string, lock = false) {
    const tx = this.prisma.tx;
    if (lock) await tx.$queryRaw`SELECT id FROM bank_accounts WHERE id = ${id}::uuid AND company_id = ${this.prisma.companyId}::uuid FOR UPDATE`;
    const a = await tx.bankAccount.findFirst({ where: { id, deletedAt: null } });
    if (!a) throw new BusinessRuleException('Cuenta bancaria inexistente', 'BANK_ACCOUNT_NOT_FOUND');
    if (!a.isActive) throw new BusinessRuleException('La cuenta bancaria está inactiva', 'BANK_ACCOUNT_INACTIVE');
    return a;
  }

  /**
   * Inserta un movimiento del libro. Las salidas no pueden dejar la cuenta por debajo de −`overdraftLimit` (0 = sin sobregiro);
   * los reversos y lo que ya ocurrió en el banco (`force`, p. ej. líneas del extracto) están exentos. Bloquea la cuenta para serializar saldos.
   */
  async addMovement(m: { bankAccountId: string; date: Date; kind: string; amount: Decimal; reference?: string | null; description?: string | null; sourceType?: string; sourceId?: string; reversalOf?: string; force?: boolean }) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    if (m.amount.isNegative() && m.kind !== 'REVERSAL' && !m.force) {
      await tx.$queryRaw`SELECT id FROM bank_accounts WHERE id = ${m.bankAccountId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`;
      const acc = await tx.bankAccount.findFirstOrThrow({ where: { id: m.bankAccountId } });
      const [r] = await tx.$queryRaw<{ s: string }[]>`SELECT COALESCE(SUM(amount), 0)::text AS s FROM bank_movements WHERE company_id = ${companyId}::uuid AND bank_account_id = ${m.bankAccountId}::uuid`;
      const available = D(acc.openingBalance.toString()).plus(D(r.s)).plus(D(acc.overdraftLimit.toString()));
      if (available.plus(m.amount).isNegative()) {
        throw new BusinessRuleException(`Fondos insuficientes en ${acc.name}: disponible ${available.toFixed(2)}${D(acc.overdraftLimit.toString()).gt(0) ? ` (incluye sobregiro ${D(acc.overdraftLimit.toString()).toFixed(2)})` : ''}, solicitado ${m.amount.abs().toFixed(2)}`, 'INSUFFICIENT_FUNDS', [{ code: 'INSUFFICIENT_FUNDS', message: available.toFixed(4) }]);
      }
    }
    return tx.bankMovement.create({
      data: {
        companyId, bankAccountId: m.bankAccountId, movementDate: m.date, kind: m.kind, amount: m.amount.toFixed(4),
        reference: m.reference ?? null, description: m.description ?? null, sourceType: m.sourceType ?? null, sourceId: m.sourceId ?? null,
        reversalOf: m.reversalOf ?? null, createdBy: this.prisma.userId,
      },
    });
  }

  // ═════════════════════════ pagos a proveedores ═════════════════════════

  async openPayables(supplierId: string) {
    const tx = this.prisma.tx;
    const entries = await tx.payableEntry.findMany({ where: { supplierId, status: { in: ['OPEN', 'PARTIALLY_PAID'] }, NOT: { balance: 0 } }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }] });
    const docs = new Map((await tx.purchaseDocument.findMany({ where: { id: { in: entries.map(e => e.purchaseDocumentId).filter(Boolean) as string[] } }, select: { id: true, number: true, supplierDocNo: true, docType: true } })).map(d => [d.id, d]));
    const cur = new Map((await this.prisma.currency.findMany({ where: { id: { in: [...new Set(entries.map(e => e.currencyId))] } } })).map(c => [c.id, c.code]));
    return entries.map(e => ({ ...e, currency: cur.get(e.currencyId), document: (e.purchaseDocumentId ? docs.get(e.purchaseDocumentId) : null) ?? { id: null, number: e.documentNo, supplierDocNo: e.documentNo, docType: 'OPENING' } }));
  }

  async createPayment(input: PaymentInput) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, deletedAt: null } });
    if (!supplier) throw new BusinessRuleException('Proveedor inexistente', 'SUPPLIER_NOT_FOUND');
    const method = await tx.paymentMethod.findFirst({ where: { id: input.paymentMethodId, deletedAt: null, isActive: true } });
    if (!method) throw new BusinessRuleException('Instrumento de pago inexistente o inactivo', 'PAYMENT_METHOD_NOT_FOUND');
    if (['CREDIT', 'WITHHOLDING'].includes(method.type)) throw new BusinessRuleException('Este instrumento no sirve para pagar a proveedores', 'PAYMENT_METHOD_INVALID');
    if (method.requiresReference && !input.reference?.trim()) throw new BusinessRuleException('El instrumento de pago requiere referencia', 'REFERENCE_REQUIRED', [{ field: 'reference', code: 'REQUIRED' }]);
    const date = new Date(input.paymentDate ?? caracasToday());
    const currency = await this.prisma.currency.findUnique({ where: { id: input.currencyId } });
    if (!currency) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
    const payRate = currency.code === 'VES' ? D(1) : input.exchangeRate ? D(input.exchangeRate) : await this.rateOf(input.currencyId, date);

    // Cuentas por pagar: bloqueadas en orden para evitar abonos simultáneos al mismo saldo.
    const ids = input.applications.map(a => a.payableEntryId);
    if (new Set(ids).size !== ids.length) throw new BusinessRuleException('Una cuenta por pagar aparece repetida', 'DUPLICATE_APPLICATION');
    await tx.$queryRaw`SELECT id FROM payable_entries WHERE company_id = ${companyId}::uuid AND id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const entries = new Map((await tx.payableEntry.findMany({ where: { id: { in: ids } } })).map(e => [e.id, e]));

    let total = ZERO;
    const apps = [] as { entryId: string; amount: Decimal; amountPayment: Decimal; newBalance: Decimal; entryAmount: Decimal; rateDoc: Decimal; ratePay: Decimal; fx: Decimal }[];
    const rateCache = new Map<string, Decimal>();
    const fxCache = new Map<string, Decimal | null>();
    const fxRate = async (currencyId: string) => { if (!fxCache.has(currencyId)) { const r = await this.rates.rateFor(currencyId, date); fxCache.set(currencyId, r ? D(r.rate) : null); } return fxCache.get(currencyId)!; };
    for (const [i, a] of input.applications.entries()) {
      const bad = (code: string, msg: string) => new BusinessRuleException(msg, code, [{ field: `applications[${i}]`, code }]);
      const e = entries.get(a.payableEntryId);
      if (!e) throw bad('PAYABLE_NOT_FOUND', 'Cuenta por pagar inexistente');
      if (e.supplierId !== input.supplierId) throw bad('SUPPLIER_MISMATCH', 'La cuenta por pagar es de otro proveedor');
      if (!['OPEN', 'PARTIALLY_PAID'].includes(e.status)) throw bad('PAYABLE_NOT_OPEN', `La cuenta por pagar está ${e.status}`);
      const amount = D(a.amount); const balance = D(e.balance.toString());
      if (balance.isZero() || amount.isNegative() !== balance.isNegative()) throw bad('INVALID_APPLICATION_SIGN', 'El monto debe tener el mismo signo que el saldo de la cuenta');
      if (amount.abs().gt(balance.abs())) throw bad('EXCEEDS_BALANCE', `El monto excede el saldo de la cuenta (${balance.toString()})`);
      let amountPayment = amount;
      if (e.currencyId !== input.currencyId) {
        if (!rateCache.has(e.currencyId)) rateCache.set(e.currencyId, await this.rateOf(e.currencyId, date));
        amountPayment = round(amount.mul(rateCache.get(e.currencyId)!).div(payRate), 4);
      }
      total = total.plus(amountPayment);
      // Diferencial cambiario realizado (ganancia +, pérdida −): lo que se paga hoy en Bs frente al valor en Bs con que se registró la deuda.
      const rateDoc = D(e.exchangeRate.toString());
      const ratePay = (await fxRate(e.currencyId)) ?? rateDoc; // bolívares: tasa 1
      apps.push({ entryId: e.id, amount, amountPayment, newBalance: balance.minus(amount), entryAmount: D(e.amount.toString()), rateDoc, ratePay, fx: round(rateDoc.minus(ratePay).mul(amount), 4) });
    }
    if (total.isNegative()) throw new BusinessRuleException('Los saldos a favor aplicados superan lo que se paga', 'NEGATIVE_PAYMENT');
    let account = null;
    if (total.gt(0)) {
      if (!input.bankAccountId) throw new BusinessRuleException('Indique la cuenta bancaria (o caja) de la que sale el pago', 'BANK_ACCOUNT_REQUIRED', [{ field: 'bankAccountId', code: 'REQUIRED' }]);
      account = await this.account(input.bankAccountId, true);
      if (account.currencyId !== input.currencyId) throw new BusinessRuleException('La cuenta bancaria es de otra moneda que el pago', 'BANK_CURRENCY_MISMATCH', [{ field: 'bankAccountId', code: 'CURRENCY_MISMATCH' }]);
    }

    const number = await this.seq.next('SUPPLIER_PAYMENT');
    const pay = await tx.supplierPayment.create({
      data: {
        companyId, number, supplierId: input.supplierId, paymentDate: date, paymentMethodId: method.id, bankAccountId: account?.id ?? null,
        currencyId: input.currencyId, exchangeRate: payRate.toFixed(8), amount: total.toFixed(4), reference: input.reference?.trim() || null,
        notes: input.notes ?? null, createdBy: this.prisma.userId,
      },
    });
    await tx.supplierPaymentApplication.createMany({
      data: apps.map(a => ({ companyId, paymentId: pay.id, payableEntryId: a.entryId, amount: a.amount.toFixed(4), amountPayment: a.amountPayment.toFixed(4), rateDoc: a.rateDoc.toFixed(8), ratePay: a.ratePay.toFixed(8), fxDiffBs: a.fx.toFixed(4) })),
    });
    for (const a of apps) {
      await tx.payableEntry.update({ where: { id: a.entryId }, data: { balance: a.newBalance.toFixed(4), status: entryStatus(a.newBalance, a.entryAmount) } });
    }
    if (account) {
      await this.addMovement({ bankAccountId: account.id, date, kind: 'SUPPLIER_PAYMENT', amount: total.neg(), reference: input.reference ?? number, description: `Pago ${number} a ${supplier.legalName}`, sourceType: 'SUPPLIER_PAYMENT', sourceId: pay.id });
    }
    await this.audit.log('supplier_payment', pay.id, 'CREATE', input);
    return this.getPayment(pay.id);
  }

  async getPayment(id: string) {
    const tx = this.prisma.tx;
    const pay = await tx.supplierPayment.findFirst({ where: { id } });
    if (!pay) throw new NotFoundError('Pago', id);
    const apps = await tx.supplierPaymentApplication.findMany({ where: { paymentId: id } });
    const entries = new Map((await tx.payableEntry.findMany({ where: { id: { in: apps.map(a => a.payableEntryId) } } })).map(e => [e.id, e]));
    const docs = new Map((await tx.purchaseDocument.findMany({ where: { id: { in: [...entries.values()].map(e => e.purchaseDocumentId).filter(Boolean) as string[] } }, select: { id: true, number: true, supplierDocNo: true } })).map(d => [d.id, d]));
    const [supplier, method, account] = await Promise.all([
      tx.supplier.findFirst({ where: { id: pay.supplierId }, select: { id: true, rif: true, legalName: true } }),
      tx.paymentMethod.findFirst({ where: { id: pay.paymentMethodId }, select: { id: true, code: true, name: true } }),
      pay.bankAccountId ? tx.bankAccount.findFirst({ where: { id: pay.bankAccountId }, select: { id: true, name: true, number: true } }) : null,
    ]);
    return {
      ...pay, supplier, method, account,
      applications: apps.map(a => { const e = entries.get(a.payableEntryId); return { ...a, entryType: e?.entryType, document: e ? (e.purchaseDocumentId ? docs.get(e.purchaseDocumentId) : null) ?? { number: e.documentNo, supplierDocNo: e.documentNo } : null, balanceNow: e?.balance }; }),
    };
  }

  async listPayments(q: z.infer<typeof paymentListSchema>) {
    const tx = this.prisma.tx;
    const where: Prisma.SupplierPaymentWhereInput = {};
    if (q.supplierId) where.supplierId = q.supplierId;
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.dateFrom || q.dateTo) where.paymentDate = { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) };
    if (q.search) where.OR = [{ number: { contains: q.search, mode: 'insensitive' } }, { reference: { contains: q.search, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      tx.supplierPayment.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      tx.supplierPayment.count({ where }),
    ]);
    const sup = new Map((await tx.supplier.findMany({ where: { id: { in: [...new Set(rows.map(r => r.supplierId))] } }, select: { id: true, legalName: true } })).map(s => [s.id, s.legalName]));
    return Paged.of(rows.map(r => ({ ...r, supplierName: sup.get(r.supplierId) ?? null })), total, q.page, q.limit);
  }

  async cancelPayment(id: string, reason: string) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    await tx.$queryRaw`SELECT id FROM supplier_payments WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`;
    const pay = await tx.supplierPayment.findFirst({ where: { id } });
    if (!pay) throw new NotFoundError('Pago', id);
    if (pay.status === 'CANCELLED') throw new BusinessRuleException('El pago ya está anulado', 'INVALID_STATE');
    const mov = await tx.bankMovement.findFirst({ where: { sourceType: 'SUPPLIER_PAYMENT', sourceId: id, reversalOf: null } });
    if (mov) {
      if (await tx.bankReconciliationItem.findFirst({ where: { movementId: mov.id } })) throw new BusinessRuleException('El pago ya fue conciliado con el banco; no se puede anular', 'PAYMENT_RECONCILED');
      await this.account(mov.bankAccountId, true);
    }
    const apps = await tx.supplierPaymentApplication.findMany({ where: { paymentId: id }, orderBy: { payableEntryId: 'asc' } });
    await tx.$queryRaw`SELECT id FROM payable_entries WHERE company_id = ${companyId}::uuid AND id = ANY(${apps.map(a => a.payableEntryId)}::uuid[]) ORDER BY id FOR UPDATE`;
    for (const a of apps) {
      const e = await tx.payableEntry.findFirstOrThrow({ where: { id: a.payableEntryId } });
      if (e.status === 'CANCELLED') throw new BusinessRuleException('Una cuenta por pagar del pago fue anulada; no se puede revertir', 'PAYABLE_CANCELLED');
      const bal = D(e.balance.toString()).plus(D(a.amount.toString()));
      await tx.payableEntry.update({ where: { id: e.id }, data: { balance: bal.toFixed(4), status: entryStatus(bal, D(e.amount.toString())) } });
    }
    if (mov) {
      await this.addMovement({ bankAccountId: mov.bankAccountId, date: new Date(caracasToday()), kind: 'REVERSAL', amount: D(mov.amount.toString()).neg(), reference: pay.number, description: `Anulación del pago ${pay.number}`, sourceType: 'SUPPLIER_PAYMENT', sourceId: id, reversalOf: mov.id });
    }
    await tx.supplierPayment.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: this.prisma.userId, cancelReason: reason } });
    await this.audit.log('supplier_payment', id, 'CANCEL', { reason });
    return this.getPayment(id);
  }

  // ═════════════════════════ bancos ═════════════════════════

  async balances() {
    const rows = await this.prisma.tx.$queryRaw<Record<string, string>[]>`
      SELECT a.id, a.name, a.number, a.account_type AS "accountType", c.code AS currency, a.opening_balance::text AS "openingBalance",
             (a.opening_balance + COALESCE(m.total, 0))::text AS balance,
             (a.opening_balance + COALESCE(r.total, 0))::text AS "reconciledBalance",
             COALESCE(m.pending, 0)::int AS "unreconciledCount"
      FROM bank_accounts a JOIN currencies c ON c.id = a.currency_id
      LEFT JOIN (SELECT m.bank_account_id, SUM(m.amount) AS total, COUNT(*) FILTER (WHERE i.movement_id IS NULL) AS pending
                 FROM bank_movements m LEFT JOIN bank_reconciliation_items i ON i.movement_id = m.id AND i.company_id = m.company_id
                 WHERE m.company_id = ${this.prisma.companyId}::uuid GROUP BY m.bank_account_id) m ON m.bank_account_id = a.id
      LEFT JOIN (SELECT m.bank_account_id, SUM(m.amount) AS total FROM bank_movements m
                 JOIN bank_reconciliation_items i ON i.movement_id = m.id AND i.company_id = m.company_id
                 WHERE m.company_id = ${this.prisma.companyId}::uuid GROUP BY m.bank_account_id) r ON r.bank_account_id = a.id
      WHERE a.company_id = ${this.prisma.companyId}::uuid AND a.deleted_at IS NULL
      ORDER BY a.name`;
    return rows;
  }

  async ledger(accountId: string, q: z.infer<typeof ledgerQuery>) {
    const a = await this.prisma.tx.bankAccount.findFirst({ where: { id: accountId, deletedAt: null } });
    if (!a) throw new NotFoundError('Cuenta bancaria', accountId);
    const cid = this.prisma.companyId;
    const from = q.dateFrom ? Prisma.sql`AND x.movement_date >= ${q.dateFrom}::date` : Prisma.empty;
    const to = q.dateTo ? Prisma.sql`AND x.movement_date <= ${q.dateTo}::date` : Prisma.empty;
    const unrec = q.onlyUnreconciled ? Prisma.sql`AND NOT x.reconciled` : Prisma.empty;
    const base = Prisma.sql`
      SELECT x.* FROM (
        SELECT m.id, m.movement_date::text AS "movementDate", m.kind, m.amount::text AS amount, m.reference, m.description, m.source_type AS "sourceType", m.source_id AS "sourceId",
               m.reversal_of AS "reversalOf", (i.movement_id IS NOT NULL) AS reconciled, m.movement_date, m.created_at,
               (${a.openingBalance.toString()}::numeric + SUM(m.amount) OVER (ORDER BY m.movement_date, m.created_at, m.id))::text AS balance
        FROM bank_movements m LEFT JOIN bank_reconciliation_items i ON i.movement_id = m.id AND i.company_id = m.company_id
        WHERE m.company_id = ${cid}::uuid AND m.bank_account_id = ${accountId}::uuid) x
      WHERE true ${from} ${to} ${unrec}`;
    const [rows, count] = await Promise.all([
      this.prisma.tx.$queryRaw<Record<string, unknown>[]>`${base} ORDER BY x.movement_date DESC, x.created_at DESC, x.id DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      this.prisma.tx.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM (${base}) t`,
    ]);
    return Paged.of(rows.map(({ movement_date, created_at, ...r }) => r), count[0].n, q.page, q.limit);
  }

  async createMovement(input: z.infer<typeof movementSchema>) {
    const acc = await this.account(input.bankAccountId, true);
    const raw = D(input.amount);
    const signed = input.kind === 'DEPOSIT' ? raw.abs() : input.kind === 'ADJUSTMENT' ? raw : raw.abs().neg();
    const m = await this.addMovement({ bankAccountId: acc.id, date: new Date(input.movementDate ?? caracasToday()), kind: input.kind, amount: signed, reference: input.reference, description: input.description });
    await this.audit.log('bank_movement', m.id, 'CREATE', input);
    return m;
  }

  async transfer(input: z.infer<typeof transferSchema>) {
    if (input.fromAccountId === input.toAccountId) throw new BusinessRuleException('Las cuentas de origen y destino deben ser distintas', 'SAME_ACCOUNT');
    // bloqueo en orden de id para evitar interbloqueos entre transferencias cruzadas
    const [first, second] = [input.fromAccountId, input.toAccountId].sort();
    const accs = new Map<string, Awaited<ReturnType<TreasuryService['account']>>>();
    accs.set(first, await this.account(first, true)); accs.set(second, await this.account(second, true));
    const from = accs.get(input.fromAccountId)!; const to = accs.get(input.toAccountId)!;
    if (from.currencyId !== to.currencyId && !input.amountIn) throw new BusinessRuleException('Cuentas de distinta moneda: indique el monto que recibe la cuenta destino (amountIn)', 'AMOUNT_IN_REQUIRED', [{ field: 'amountIn', code: 'REQUIRED' }]);
    if (from.currencyId === to.currencyId && input.amountIn && !D(input.amountIn).eq(input.amountOut)) throw new BusinessRuleException('En la misma moneda el monto de entrada debe ser igual al de salida', 'AMOUNT_MISMATCH');
    const date = new Date(input.movementDate ?? caracasToday());
    const ref = randomUUID();
    const out = await this.addMovement({ bankAccountId: from.id, date, kind: 'TRANSFER_OUT', amount: D(input.amountOut).neg(), reference: input.reference, description: `Transferencia a ${to.name}`, sourceType: 'TRANSFER', sourceId: ref });
    const inn = await this.addMovement({ bankAccountId: to.id, date, kind: 'TRANSFER_IN', amount: D(input.amountIn ?? input.amountOut), reference: input.reference, description: `Transferencia desde ${from.name}`, sourceType: 'TRANSFER', sourceId: ref });
    await this.audit.log('bank_transfer', ref, 'CREATE', input);
    return { transferId: ref, out, in: inn };
  }

  // ═════════════════════════ conciliación ═════════════════════════

  async listReconciliations(accountId?: string) {
    return this.prisma.tx.bankReconciliation.findMany({ where: accountId ? { bankAccountId: accountId } : {}, orderBy: [{ statementDate: 'desc' }, { createdAt: 'desc' }], take: 200 });
  }

  /**
   * Concilia movimientos contra el extracto: el saldo en libros de lo conciliado (apertura + todo lo ya conciliado + lo seleccionado)
   * debe coincidir con el saldo del extracto; si no, no se guarda y se informa la diferencia.
   */
  async reconcile(input: z.infer<typeof reconcileSchema>) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const acc = await this.account(input.bankAccountId, true);
    const ids = [...new Set(input.movementIds)];
    const movs = await tx.bankMovement.findMany({ where: { id: { in: ids }, bankAccountId: acc.id } });
    if (movs.length !== ids.length) throw new BusinessRuleException('Hay movimientos que no pertenecen a la cuenta', 'INVALID_MOVEMENT');
    if (movs.some(m => m.movementDate > new Date(input.statementDate))) throw new BusinessRuleException('Hay movimientos posteriores a la fecha del extracto', 'MOVEMENT_AFTER_STATEMENT');
    if (await tx.bankReconciliationItem.findFirst({ where: { movementId: { in: ids } } })) throw new BusinessRuleException('Hay movimientos ya conciliados', 'ALREADY_RECONCILED');
    const [prev] = await tx.$queryRaw<{ s: string }[]>`
      SELECT COALESCE(SUM(m.amount), 0)::text AS s FROM bank_movements m
      JOIN bank_reconciliation_items i ON i.movement_id = m.id AND i.company_id = m.company_id
      WHERE m.company_id = ${companyId}::uuid AND m.bank_account_id = ${acc.id}::uuid`;
    const book = D(acc.openingBalance.toString()).plus(D(prev.s)).plus(movs.reduce((a, m) => a.plus(D(m.amount.toString())), ZERO));
    const diff = D(input.statementBalance).minus(book);
    if (!diff.isZero()) {
      throw new BusinessRuleException(`El saldo del extracto no cuadra con lo conciliado: diferencia ${diff.toFixed(2)} (libros ${book.toFixed(2)})`, 'RECONCILIATION_DIFFERENCE', [{ code: 'RECONCILIATION_DIFFERENCE', message: diff.toFixed(4) }]);
    }
    const rec = await tx.bankReconciliation.create({
      data: { companyId, bankAccountId: acc.id, statementDate: new Date(input.statementDate), statementBalance: D(input.statementBalance).toFixed(4), bookBalance: book.toFixed(4), notes: input.notes ?? null, createdBy: this.prisma.userId },
    });
    await tx.bankReconciliationItem.createMany({ data: ids.map(movementId => ({ companyId, reconciliationId: rec.id, movementId })) });
    await this.audit.log('bank_reconciliation', rec.id, 'CREATE', { account: acc.id, movements: ids.length });
    return { ...rec, movements: ids.length };
  }
}
