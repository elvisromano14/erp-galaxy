import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { D, Decimal, round } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { SequenceService } from '../../common/db/sequence.service';
import { BusinessRuleException, NotFoundError } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { env } from '../../config/env';
import { caracasToday } from '../inventory/inventory-docs.service';
import { withholdingPdf } from './withholding-pdf';
import { issueWithholdingSchema, receiveWithholdingSchema, withholdingListSchema } from './withholdings.types';

const entryStatus = (balance: Decimal, amount: Decimal) => (balance.isZero() ? 'PAID' : balance.eq(amount) ? 'OPEN' : 'PARTIALLY_PAID');
const TOL = D('0.01');

/**
 * Retenciones de IVA / ISLR. Reducen la cuenta por pagar (las que practicamos) o por cobrar (las que nos practican) por el monto retenido,
 * convertido a la moneda del asiento con la tasa del documento. Porcentajes y reglas son de REFERENCIA: los valida el contador.
 */
@Injectable()
export class WithholdingsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly seq: SequenceService) {}

  private period(d: Date) { return d.toISOString().slice(0, 7); }

  /** Aplica `amountBs` al asiento (lo convierte a la moneda del asiento con la tasa del documento) y devuelve lo aplicado. */
  private async applyToEntry(kind: 'payable' | 'receivable', entryId: string, amountBs: Decimal, sign: 1 | -1) {
    const tx = this.prisma.tx;
    await tx.$queryRaw`SELECT id FROM ${Prisma.raw(kind === 'payable' ? 'payable_entries' : 'receivable_entries')} WHERE id = ${entryId}::uuid AND company_id = ${this.prisma.companyId}::uuid FOR UPDATE`;
    const e = kind === 'payable' ? await tx.payableEntry.findFirstOrThrow({ where: { id: entryId } }) : await tx.receivableEntry.findFirstOrThrow({ where: { id: entryId } });
    const applied = round(amountBs.div(D(e.exchangeRate.toString())), 4);
    const balance = D(e.balance.toString());
    if (sign === 1) {
      if (!['OPEN', 'PARTIALLY_PAID'].includes(e.status)) throw new BusinessRuleException(`El documento no tiene saldo abierto (${e.status}): no se puede aplicar la retención`, 'ENTRY_NOT_OPEN');
      if (applied.gt(balance.plus(TOL))) throw new BusinessRuleException(`La retención (${applied.toFixed(2)}) excede el saldo del documento (${balance.toFixed(2)})`, 'EXCEEDS_BALANCE');
    }
    const next = sign === 1 ? Decimal.max(balance.minus(applied), D(0)) : balance.plus(applied);
    const data = { balance: next.toFixed(4), status: entryStatus(next, D(e.amount.toString())) };
    if (kind === 'payable') await tx.payableEntry.update({ where: { id: entryId }, data }); else await tx.receivableEntry.update({ where: { id: entryId }, data });
    return applied;
  }

  // ═════════════════════════ practicadas (a proveedores) ═════════════════════════

  async issue(input: z.infer<typeof issueWithholdingSchema>) {
    const tx = this.prisma.tx;
    const company = await tx.company.findUniqueOrThrow({ where: { id: this.prisma.companyId } });
    if (input.kind === 'IVA' && !company.isVatWithholdingAgent) throw new BusinessRuleException('La empresa no está marcada como agente de retención de IVA (Configuración → Empresa)', 'NOT_VAT_AGENT');
    const doc = await tx.purchaseDocument.findFirst({ where: { id: input.purchaseDocumentId, docType: 'PURCHASE', status: 'CONFIRMED' } });
    if (!doc) throw new BusinessRuleException('Solo se retiene sobre una compra confirmada', 'INVALID_DOCUMENT');
    const supplier = await tx.supplier.findFirstOrThrow({ where: { id: doc.supplierId } });
    const entry = await tx.payableEntry.findFirst({ where: { purchaseDocumentId: doc.id, entryType: 'INVOICE', status: { not: 'CANCELLED' } } });
    if (!entry) throw new BusinessRuleException('La compra no tiene cuenta por pagar', 'NO_PAYABLE');
    const rate = D(doc.exchangeRate.toString());
    const pct = D(input.percentage ?? (input.kind === 'IVA' ? supplier.retentionIvaPct.toString() : 0));
    if (pct.lte(0)) throw new BusinessRuleException(input.kind === 'IVA' ? 'El proveedor no tiene porcentaje de retención de IVA: indíquelo' : 'Indique el porcentaje de retención de ISLR', 'PERCENTAGE_REQUIRED', [{ field: 'percentage', code: 'REQUIRED' }]);
    const baseBs = input.baseBs !== undefined ? D(input.baseBs) : input.kind === 'IVA' ? round(D(doc.taxTotal.toString()).mul(rate), 4) : round(D(doc.taxableBase.toString()).plus(D(doc.exemptBase.toString())).mul(rate), 4);
    if (baseBs.lte(0)) throw new BusinessRuleException('La base de la retención es cero (compra exenta o sin IVA)', 'ZERO_BASE');
    const amountBs = round(baseBs.mul(pct).div(100), 2);
    if (amountBs.lte(0)) throw new BusinessRuleException('El monto retenido es cero', 'ZERO_AMOUNT');
    if (await tx.withholding.findFirst({ where: { purchaseDocumentId: doc.id, kind: input.kind, status: 'CONFIRMED' } })) throw new BusinessRuleException(`La compra ya tiene una retención de ${input.kind}`, 'ALREADY_WITHHELD');
    const applied = await this.applyToEntry('payable', entry.id, amountBs, 1);
    const date = new Date(input.voucherDate ?? caracasToday());
    const number = await this.seq.next(input.kind === 'IVA' ? 'WITHHOLDING_IVA' : 'WITHHOLDING_ISLR');
    const row = await tx.withholding.create({
      data: {
        companyId: this.prisma.companyId, direction: 'ISSUED', kind: input.kind, number, voucherDate: date, period: this.period(date), supplierId: supplier.id, purchaseDocumentId: doc.id,
        payableEntryId: entry.id, concept: input.concept ?? null, baseBs: baseBs.toFixed(4), percentage: pct.toFixed(4), amountBs: amountBs.toFixed(2), appliedAmount: applied.toFixed(4), notes: input.notes ?? null, createdBy: this.prisma.userId,
      },
    });
    await this.audit.log('withholding', row.id, 'CREATE', input);
    return this.get(row.id);
  }

  // ═════════════════════════ recibidas (de clientes) ═════════════════════════

  async receive(input: z.infer<typeof receiveWithholdingSchema>) {
    const tx = this.prisma.tx;
    const doc = await tx.salesDocument.findFirst({ where: { id: input.salesDocumentId, docType: 'INVOICE', status: 'CONFIRMED' } });
    if (!doc) throw new BusinessRuleException('Solo se registra retención sobre una factura emitida', 'INVALID_DOCUMENT');
    const customer = await tx.customer.findFirstOrThrow({ where: { id: doc.customerId } });
    const entry = await tx.receivableEntry.findFirst({ where: { sourceType: 'SALES_INVOICE', sourceId: doc.id, status: { not: 'CANCELLED' } } });
    if (!entry) throw new BusinessRuleException('La factura no tiene cuenta por cobrar (fue de contado)', 'NO_RECEIVABLE');
    const rate = D(doc.exchangeRate.toString());
    const pct = D(input.percentage ?? (input.kind === 'IVA' ? customer.retentionIvaPct.toString() : 0));
    if (pct.lte(0)) throw new BusinessRuleException('Indique el porcentaje de retención', 'PERCENTAGE_REQUIRED', [{ field: 'percentage', code: 'REQUIRED' }]);
    const baseBs = input.baseBs !== undefined ? D(input.baseBs) : input.kind === 'IVA' ? round(D(doc.taxTotal.toString()).mul(rate), 4) : round(D(doc.taxableBase.toString()).plus(D(doc.exemptBase.toString())).mul(rate), 4);
    if (baseBs.lte(0)) throw new BusinessRuleException('La base de la retención es cero', 'ZERO_BASE');
    const amountBs = round(baseBs.mul(pct).div(100), 2);
    if (await tx.withholding.findFirst({ where: { salesDocumentId: doc.id, kind: input.kind, status: 'CONFIRMED' } })) throw new BusinessRuleException(`La factura ya tiene una retención de ${input.kind}`, 'ALREADY_WITHHELD');
    const applied = await this.applyToEntry('receivable', entry.id, amountBs, 1);
    const date = new Date(input.voucherDate ?? caracasToday());
    const number = await this.seq.next('WITHHOLDING_RECEIVED');
    const row = await tx.withholding.create({
      data: {
        companyId: this.prisma.companyId, direction: 'RECEIVED', kind: input.kind, number, externalNumber: input.externalNumber, voucherDate: date, period: this.period(date), customerId: customer.id,
        salesDocumentId: doc.id, receivableEntryId: entry.id, concept: input.concept ?? null, baseBs: baseBs.toFixed(4), percentage: pct.toFixed(4), amountBs: amountBs.toFixed(2), appliedAmount: applied.toFixed(4), notes: input.notes ?? null, createdBy: this.prisma.userId,
      },
    });
    await this.audit.log('withholding', row.id, 'CREATE', input);
    return this.get(row.id);
  }

  // ═════════════════════════ consulta / anulación / PDF ═════════════════════════

  async get(id: string) {
    const tx = this.prisma.tx;
    const w = await tx.withholding.findFirst({ where: { id } });
    if (!w) throw new NotFoundError('Retención', id);
    const [supplier, customer, purchase, sale] = await Promise.all([
      w.supplierId ? tx.supplier.findFirst({ where: { id: w.supplierId }, select: { id: true, rif: true, legalName: true } }) : null,
      w.customerId ? tx.customer.findFirst({ where: { id: w.customerId }, select: { id: true, rif: true, legalName: true } }) : null,
      w.purchaseDocumentId ? tx.purchaseDocument.findFirst({ where: { id: w.purchaseDocumentId }, select: { id: true, number: true, supplierDocNo: true, docDate: true } }) : null,
      w.salesDocumentId ? tx.salesDocument.findFirst({ where: { id: w.salesDocumentId }, select: { id: true, number: true, controlNo: true, docDate: true } }) : null,
    ]);
    return { ...w, supplier, customer, purchase, sale };
  }

  async list(q: z.infer<typeof withholdingListSchema>) {
    const tx = this.prisma.tx;
    const where: Prisma.WithholdingWhereInput = {};
    if (q.direction) where.direction = q.direction;
    if (q.kind) where.kind = q.kind;
    if (q.status) where.status = { in: q.status.split(',') };
    if (q.dateFrom || q.dateTo) where.voucherDate = { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) };
    if (q.search) where.OR = [{ number: { contains: q.search, mode: 'insensitive' } }, { externalNumber: { contains: q.search, mode: 'insensitive' } }];
    const [rows, total] = await Promise.all([
      tx.withholding.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      tx.withholding.count({ where }),
    ]);
    const sup = new Map((await tx.supplier.findMany({ where: { id: { in: rows.map(r => r.supplierId).filter(Boolean) as string[] } }, select: { id: true, legalName: true } })).map(s => [s.id, s.legalName]));
    const cus = new Map((await tx.customer.findMany({ where: { id: { in: rows.map(r => r.customerId).filter(Boolean) as string[] } }, select: { id: true, legalName: true } })).map(s => [s.id, s.legalName]));
    return Paged.of(rows.map(r => ({ ...r, partyName: (r.supplierId ? sup.get(r.supplierId) : r.customerId ? cus.get(r.customerId) : null) ?? null })), total, q.page, q.limit);
  }

  /** Documentos del tercero sobre los que se puede retener (con saldo abierto y sin retención de ese tipo). */
  async eligible(direction: 'ISSUED' | 'RECEIVED', partyId: string) {
    const tx = this.prisma.tx;
    if (direction === 'ISSUED') {
      const entries = await tx.payableEntry.findMany({ where: { supplierId: partyId, entryType: 'INVOICE', status: { in: ['OPEN', 'PARTIALLY_PAID'] }, balance: { gt: 0 } }, orderBy: { dueDate: 'asc' } });
      const docs = await tx.purchaseDocument.findMany({ where: { id: { in: entries.map(e => e.purchaseDocumentId).filter(Boolean) as string[] } } });
      const done = await tx.withholding.findMany({ where: { purchaseDocumentId: { in: docs.map(d => d.id) }, status: 'CONFIRMED' }, select: { purchaseDocumentId: true, kind: true } });
      return docs.map(d => { const e = entries.find(x => x.purchaseDocumentId === d.id)!; return { documentId: d.id, number: d.number, ref: d.supplierDocNo, date: d.docDate, taxBs: round(D(d.taxTotal.toString()).mul(D(d.exchangeRate.toString())), 2).toString(), balance: e.balance.toString(), withheld: done.filter(x => x.purchaseDocumentId === d.id).map(x => x.kind) }; });
    }
    const entries = await tx.receivableEntry.findMany({ where: { customerId: partyId, entryType: 'INVOICE', status: { in: ['OPEN', 'PARTIALLY_PAID'] }, balance: { gt: 0 } }, orderBy: { dueDate: 'asc' } });
    const docs = await tx.salesDocument.findMany({ where: { id: { in: entries.map(e => e.sourceId).filter(Boolean) as string[] } } });
    const done = await tx.withholding.findMany({ where: { salesDocumentId: { in: docs.map(d => d.id) }, status: 'CONFIRMED' }, select: { salesDocumentId: true, kind: true } });
    return docs.map(d => { const e = entries.find(x => x.sourceId === d.id)!; return { documentId: d.id, number: d.number, ref: d.controlNo, date: d.docDate, taxBs: round(D(d.taxTotal.toString()).mul(D(d.exchangeRate.toString())), 2).toString(), balance: e.balance.toString(), withheld: done.filter(x => x.salesDocumentId === d.id).map(x => x.kind) }; });
  }

  async cancel(id: string, reason: string) {
    const tx = this.prisma.tx;
    const w = await tx.withholding.findFirst({ where: { id } });
    if (!w) throw new NotFoundError('Retención', id);
    if (w.status === 'CANCELLED') throw new BusinessRuleException('La retención ya está anulada', 'INVALID_STATE');
    if (w.direction === 'ISSUED') await this.restore('payable', w.payableEntryId!, D(w.appliedAmount.toString()));
    else await this.restore('receivable', w.receivableEntryId!, D(w.appliedAmount.toString()));
    await tx.withholding.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: this.prisma.userId, cancelReason: reason } });
    await this.audit.log('withholding', id, 'CANCEL', { reason });
    return this.get(id);
  }

  private async restore(kind: 'payable' | 'receivable', entryId: string, applied: Decimal) {
    const tx = this.prisma.tx;
    await tx.$queryRaw`SELECT id FROM ${Prisma.raw(kind === 'payable' ? 'payable_entries' : 'receivable_entries')} WHERE id = ${entryId}::uuid AND company_id = ${this.prisma.companyId}::uuid FOR UPDATE`;
    const e = kind === 'payable' ? await tx.payableEntry.findFirstOrThrow({ where: { id: entryId } }) : await tx.receivableEntry.findFirstOrThrow({ where: { id: entryId } });
    if (e.status === 'CANCELLED') throw new BusinessRuleException('El documento retenido fue anulado; no se puede revertir la retención', 'ENTRY_CANCELLED');
    const next = D(e.balance.toString()).plus(applied);
    const data = { balance: next.toFixed(4), status: entryStatus(next, D(e.amount.toString())) };
    if (kind === 'payable') await tx.payableEntry.update({ where: { id: entryId }, data }); else await tx.receivableEntry.update({ where: { id: entryId }, data });
  }

  async pdf(id: string) {
    const tx = this.prisma.tx;
    const w = await this.get(id);
    const company = await tx.company.findUniqueOrThrow({ where: { id: this.prisma.companyId } });
    const me = { rif: company.rif, legalName: company.legalName, address: company.fiscalAddress };
    const other = w.supplier ?? w.customer!;
    const full = w.supplierId ? await tx.supplier.findFirst({ where: { id: w.supplierId } }) : await tx.customer.findFirst({ where: { id: w.customerId! } });
    const party = { rif: other.rif, legalName: other.legalName, address: full?.address ?? null };
    const isIssued = w.direction === 'ISSUED';
    const doc = isIssued
      ? { kind: 'Factura de compra', number: w.purchase?.number ?? '', date: w.purchase?.docDate.toISOString().slice(0, 10) ?? '', ref: w.purchase?.supplierDocNo }
      : { kind: 'Factura de venta', number: w.sale?.number ?? '', date: w.sale?.docDate.toISOString().slice(0, 10) ?? '', ref: w.sale?.controlNo };
    const buffer = await withholdingPdf({
      number: w.number, kind: w.kind as 'IVA' | 'ISLR', direction: w.direction as 'ISSUED' | 'RECEIVED', externalNumber: w.externalNumber, voucherDate: w.voucherDate.toISOString().slice(0, 10), period: w.period, status: w.status,
      agent: isIssued ? me : party, subject: isIssued ? party : me, document: doc, concept: w.concept, baseBs: w.baseBs.toString(), percentage: w.percentage.toString(), amountBs: w.amountBs.toString(), legend: env.INVOICE_LEGEND,
    });
    return { buffer, filename: `retencion-${w.kind.toLowerCase()}-${w.number}.pdf` };
  }
}
