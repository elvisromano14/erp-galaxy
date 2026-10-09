import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { D } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { BusinessRuleException, NotFoundError } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { ExchangeRatesService } from '../catalogs/exchange-rates';
import { openingPayableSchema, payableListSchema } from './treasury.types';

/** Cuentas por pagar: consulta y saldos iniciales (migración de deudas con proveedores). Las compras crean sus propios asientos. */
@Injectable()
export class PayablesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly rates: ExchangeRatesService) {}

  async createOpening(input: z.infer<typeof openingPayableSchema>) {
    const tx = this.prisma.tx;
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, deletedAt: null } });
    if (!supplier) throw new BusinessRuleException('Proveedor inexistente', 'SUPPLIER_NOT_FOUND');
    const issue = new Date(input.issueDate);
    const due = new Date(input.dueDate ?? new Date(issue.getTime() + supplier.creditDays * 86_400_000).toISOString().slice(0, 10));
    if (due < issue) throw new BusinessRuleException('El vencimiento no puede ser anterior a la emisión', 'INVALID_DUE_DATE', [{ field: 'dueDate', code: 'INVALID' }]);
    const cur = await this.prisma.currency.findUnique({ where: { id: input.currencyId } });
    if (!cur) throw new BusinessRuleException('Moneda inexistente', 'CURRENCY_NOT_FOUND');
    let rate = '1';
    if (cur.code !== 'VES') {
      const r = input.exchangeRate ?? (await this.rates.rateFor(input.currencyId, issue))?.rate;
      if (!r) throw new BusinessRuleException('No hay tasa de cambio para la moneda y fecha del documento: indíquela', 'RATE_NOT_FOUND');
      rate = r;
    }
    const dup = await tx.payableEntry.findFirst({ where: { supplierId: input.supplierId, entryType: 'OPENING', documentNo: input.documentNo, status: { not: 'CANCELLED' } } });
    if (dup) throw new BusinessRuleException('Ya existe un saldo inicial con ese número de documento para el proveedor', 'DUPLICATE_DOCUMENT', [{ field: 'documentNo', code: 'DUPLICATE' }]);
    const amount = D(input.amount).toFixed(4);
    const row = await tx.payableEntry.create({
      data: {
        companyId: this.prisma.companyId, supplierId: input.supplierId, entryType: 'OPENING', documentNo: input.documentNo, issueDate: issue, dueDate: due, currencyId: input.currencyId,
        exchangeRate: rate, amount, balance: amount, status: 'OPEN', notes: input.notes ?? null,
      },
    });
    await this.audit.log('payable_entry', row.id, 'CREATE', input);
    return row;
  }

  async cancelOpening(id: string, reason: string) {
    const tx = this.prisma.tx;
    await tx.$queryRaw`SELECT id FROM payable_entries WHERE id = ${id}::uuid AND company_id = ${this.prisma.companyId}::uuid FOR UPDATE`;
    const e = await tx.payableEntry.findFirst({ where: { id } });
    if (!e) throw new NotFoundError('Cuenta por pagar', id);
    if (e.entryType !== 'OPENING') throw new BusinessRuleException('Solo se anulan saldos iniciales; los demás asientos se anulan con su documento', 'INVALID_ENTRY_TYPE');
    if (e.status === 'CANCELLED') throw new BusinessRuleException('El asiento ya está anulado', 'INVALID_STATE');
    if (!D(e.balance.toString()).eq(D(e.amount.toString()))) throw new BusinessRuleException('El asiento tiene pagos aplicados; anule primero los pagos', 'HAS_APPLICATIONS');
    await tx.payableEntry.update({ where: { id }, data: { status: 'CANCELLED', balance: '0', notes: `${e.notes ?? ''}${e.notes ? ' · ' : ''}Anulado: ${reason}` } });
    await this.audit.log('payable_entry', id, 'CANCEL', { reason });
    return tx.payableEntry.findFirstOrThrow({ where: { id } });
  }

  async list(q: z.infer<typeof payableListSchema>) {
    const tx = this.prisma.tx;
    const where: Prisma.PayableEntryWhereInput = {};
    if (q.supplierId) where.supplierId = q.supplierId;
    if (q.onlyOpen) where.status = { in: ['OPEN', 'PARTIALLY_PAID'] }; else if (q.status) where.status = { in: q.status.split(',') };
    const [rows, total] = await Promise.all([
      tx.payableEntry.findMany({ where, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      tx.payableEntry.count({ where }),
    ]);
    const docs = new Map((await tx.purchaseDocument.findMany({ where: { id: { in: rows.map(r => r.purchaseDocumentId).filter(Boolean) as string[] } }, select: { id: true, number: true, supplierDocNo: true } })).map(d => [d.id, d]));
    const sup = new Map((await tx.supplier.findMany({ where: { id: { in: [...new Set(rows.map(r => r.supplierId))] } }, select: { id: true, legalName: true } })).map(s => [s.id, s.legalName]));
    const cur = new Map((await this.prisma.currency.findMany({ where: { id: { in: [...new Set(rows.map(r => r.currencyId))] } } })).map(c => [c.id, c.code]));
    return Paged.of(rows.map(r => {
      const d = r.purchaseDocumentId ? docs.get(r.purchaseDocumentId) : null;
      return { ...r, supplierName: sup.get(r.supplierId) ?? null, currency: cur.get(r.currencyId), documentNo: r.documentNo ?? d?.number ?? null, supplierDocNo: d?.supplierDocNo ?? r.documentNo };
    }), total, q.page, q.limit);
  }
}
