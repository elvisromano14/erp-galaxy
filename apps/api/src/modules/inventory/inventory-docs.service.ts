import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { decimalStr, paginationQuery, uuid } from '@erp/contracts';
import { D } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { SequenceService } from '../../common/db/sequence.service';
import { BusinessRuleException, NotFoundError, ConflictError } from '../../common/errors/errors';
import { Paged } from '../../common/http/paged';
import { MoveRequest, PostingService } from './posting.service';

export type InvDocType = 'TRANSFER' | 'CHARGE' | 'DISCHARGE' | 'ADJUSTMENT' | 'COST_ADJUSTMENT';

export const INV_DOC_ROUTES: { path: string; docType: InvDocType; permission: string }[] = [
  { path: 'transfers', docType: 'TRANSFER', permission: 'inventory:transfers' },
  { path: 'charges', docType: 'CHARGE', permission: 'inventory:charges' },
  { path: 'discharges', docType: 'DISCHARGE', permission: 'inventory:discharges' },
  { path: 'adjustments', docType: 'ADJUSTMENT', permission: 'inventory:adjustments' },
  { path: 'cost-adjustments', docType: 'COST_ADJUSTMENT', permission: 'inventory:cost-adjustments' },
];

const line = z.object({
  productId: uuid,
  quantity: decimalStr.optional(),
  unitCost: decimalStr.optional(),
  countedQty: decimalStr.optional(),
  newAvgCost: decimalStr.optional(),
  serials: z.array(z.string().trim().min(1).max(100)).max(5000).optional(),
  lotNo: z.string().trim().min(1).max(60).nullable().optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});
export const invDocSchema = z.object({
  warehouseId: uuid,
  toWarehouseId: uuid.nullable().optional(),
  reasonId: uuid.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  lines: z.array(line).min(1, 'Se requiere al menos una línea'),
});
export const invDocUpdateSchema = invDocSchema.partial().extend({ version: z.number().int().optional() });
export const invDocListSchema = paginationQuery.extend({
  status: z.enum(['DRAFT', 'CONFIRMED', 'CANCELLED']).optional(),
  warehouseId: uuid.optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export const cancelSchema = z.object({ reason: z.string().trim().min(3, 'El motivo es obligatorio').max(500) });

export const caracasToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });

@Injectable()
export class InventoryDocsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly seq: SequenceService,
    private readonly posting: PostingService,
  ) {}

  // ───────── validación del borrador ─────────
  private async validate(docType: InvDocType, input: z.infer<typeof invDocSchema>) {
    const tx = this.prisma.tx;
    if (docType === 'TRANSFER') {
      if (!input.toWarehouseId) throw new BusinessRuleException('El traslado requiere depósito destino', 'DESTINATION_REQUIRED');
      if (input.toWarehouseId === input.warehouseId) throw new BusinessRuleException('Origen y destino deben ser distintos', 'SAME_WAREHOUSE');
    } else if (input.toWarehouseId) {
      throw new BusinessRuleException('Solo los traslados tienen depósito destino', 'DESTINATION_NOT_ALLOWED');
    }
    const whIds = [input.warehouseId, input.toWarehouseId].filter(Boolean) as string[];
    const whs = await tx.warehouse.findMany({ where: { id: { in: whIds }, deletedAt: null, isActive: true } });
    if (whs.length !== new Set(whIds).size) throw new BusinessRuleException('Depósito inexistente o inactivo', 'WAREHOUSE_NOT_FOUND');
    if (input.reasonId) {
      const reason = await tx.movementReason.findFirst({ where: { id: input.reasonId, deletedAt: null } });
      const expected = docType === 'CHARGE' ? 'CHARGE' : docType === 'DISCHARGE' ? 'DISCHARGE' : docType === 'ADJUSTMENT' ? 'ADJUSTMENT' : null;
      if (!reason || (expected && reason.kind !== expected)) throw new BusinessRuleException('Motivo inválido para este tipo de documento', 'INVALID_REASON');
    }
    const products = new Map((await tx.product.findMany({ where: { id: { in: input.lines.map(l => l.productId) }, deletedAt: null } })).map(p => [p.id, p]));
    const seen = new Set<string>();
    input.lines.forEach((l, i) => {
      const p = products.get(l.productId);
      const bad = (code: string, msg: string) => new BusinessRuleException(msg, code, [{ field: `lines[${i}]`, code }]);
      if (!p) throw bad('PRODUCT_NOT_FOUND', 'Producto inexistente');
      if (!p.isActive) throw bad('PRODUCT_INACTIVE', `El producto ${p.sku} está inactivo`);
      if (p.isService) throw bad('PRODUCT_IS_SERVICE', `El producto ${p.sku} es un servicio y no mueve inventario`);
      const serialProduct = p.trackingMode === 'SERIAL';
      if (!serialProduct && l.serials?.length) throw bad('SERIALS_NOT_ALLOWED', `El producto ${p.sku} no se controla por seriales`);
      if (serialProduct && docType !== 'COST_ADJUSTMENT') {
        const nos = l.serials ?? [];
        if (docType !== 'ADJUSTMENT' && !nos.length) throw bad('SERIALS_REQUIRED', `El producto ${p.sku} se controla por seriales: indique los seriales`);
        if (docType === 'ADJUSTMENT' && l.serials === undefined) throw bad('SERIALS_REQUIRED', `Indique los seriales contados de ${p.sku} (lista vacía si no hay ninguno)`);
        if (new Set(nos.map(x => x.trim())).size !== nos.length) throw bad('DUPLICATE_SERIAL', `Hay seriales repetidos para ${p.sku}`);
      } else if (docType === 'TRANSFER' || docType === 'CHARGE' || docType === 'DISCHARGE') {
        if (l.quantity === undefined || D(l.quantity).lte(0)) throw bad('QUANTITY_REQUIRED', 'La cantidad debe ser mayor que cero');
      }
      if (docType === 'CHARGE' && (l.unitCost === undefined || D(l.unitCost).isNegative())) throw bad('COST_REQUIRED', 'El cargo requiere costo unitario');
      if (docType === 'ADJUSTMENT' && !serialProduct && (l.countedQty === undefined || D(l.countedQty).isNegative())) throw bad('COUNTED_QTY_REQUIRED', 'Indique la cantidad contada');
      if (docType === 'COST_ADJUSTMENT' && (l.newAvgCost === undefined || D(l.newAvgCost).isNegative())) throw bad('NEW_COST_REQUIRED', 'Indique el nuevo costo promedio');
      if (p.trackingMode === 'LOT' && docType !== 'COST_ADJUSTMENT' && !l.lotNo && (docType === 'CHARGE' || docType === 'ADJUSTMENT')) throw bad('LOT_REQUIRED', `El producto ${p.sku} requiere lote`);
      if (p.trackingMode === 'LOT' && docType === 'CHARGE' && p.hasExpiry && !l.expiryDate) throw bad('EXPIRY_REQUIRED', `El producto ${p.sku} requiere vencimiento`);
      if (docType === 'ADJUSTMENT' || docType === 'COST_ADJUSTMENT') {
        const k = `${l.productId}|${l.lotNo ?? ''}`;
        if (seen.has(k)) throw bad('DUPLICATE_LINE', 'Producto/lote repetido en el documento');
        seen.add(k);
      }
    });
  }

  private lineData(companyId: string, documentId: string, l: z.infer<typeof line>, i: number, docTypeOfLine: InvDocType) {
    return {
      companyId, documentId, lineNo: i + 1, productId: l.productId,
      quantity: l.serials ? String(l.serials.length) : l.quantity ?? '0', unitCost: l.unitCost ?? null,
      countedQty: l.serials && docTypeOfLine === 'ADJUSTMENT' ? String(l.serials.length) : l.countedQty ?? null, newAvgCost: l.newAvgCost ?? null,
      serials: l.serials ?? [],
      lotNo: l.lotNo ?? null, expiryDate: l.expiryDate ? new Date(l.expiryDate) : null, notes: l.notes ?? null,
    };
  }

  // ───────── CRUD de borradores ─────────
  async create(docType: InvDocType, input: z.infer<typeof invDocSchema>) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    await this.validate(docType, input);
    const doc = await tx.inventoryDocument.create({
      data: {
        companyId, docType, status: 'DRAFT', docDate: new Date(caracasToday()), warehouseId: input.warehouseId,
        toWarehouseId: input.toWarehouseId ?? null, reasonId: input.reasonId ?? null, notes: input.notes ?? null,
        createdBy: this.prisma.userId, updatedBy: this.prisma.userId,
      },
    });
    await tx.inventoryDocumentLine.createMany({ data: input.lines.map((l, i) => this.lineData(companyId, doc.id, l, i, docType)) });
    await this.audit.log(`inventory_${docType.toLowerCase()}`, doc.id, 'CREATE', input);
    return this.get(docType, doc.id);
  }

  async update(docType: InvDocType, id: string, input: z.infer<typeof invDocUpdateSchema>) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const doc = await this.find(docType, id);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException('Solo se pueden editar documentos en borrador', 'DOCUMENT_NOT_EDITABLE');
    if (input.version !== undefined && input.version !== doc.version) throw new ConflictError('El documento fue modificado por otro usuario', 'VERSION_CONFLICT');
    const existingLines = await tx.inventoryDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    const merged = {
      warehouseId: input.warehouseId ?? doc.warehouseId,
      toWarehouseId: input.toWarehouseId === undefined ? doc.toWarehouseId : input.toWarehouseId,
      reasonId: input.reasonId === undefined ? doc.reasonId : input.reasonId,
      notes: input.notes === undefined ? doc.notes : input.notes,
      lines: input.lines ?? existingLines.map(l => ({
        productId: l.productId, quantity: l.quantity.toString(), unitCost: l.unitCost?.toString(), countedQty: l.countedQty?.toString(),
        newAvgCost: l.newAvgCost?.toString(), lotNo: l.lotNo, expiryDate: l.expiryDate?.toISOString().slice(0, 10) ?? null, notes: l.notes,
        serials: l.serials.length ? l.serials : undefined,
      })),
    };
    await this.validate(docType, merged as z.infer<typeof invDocSchema>);
    await tx.inventoryDocument.update({
      where: { id },
      data: { warehouseId: merged.warehouseId, toWarehouseId: merged.toWarehouseId ?? null, reasonId: merged.reasonId ?? null, notes: merged.notes ?? null, updatedBy: this.prisma.userId, version: { increment: 1 } },
    });
    if (input.lines) {
      await tx.inventoryDocumentLine.deleteMany({ where: { documentId: id } });
      await tx.inventoryDocumentLine.createMany({ data: input.lines.map((l, i) => this.lineData(companyId, id, l, i, docType)) });
    }
    await this.audit.log(`inventory_${docType.toLowerCase()}`, id, 'UPDATE', input);
    return this.get(docType, id);
  }

  async remove(docType: InvDocType, id: string) {
    const doc = await this.find(docType, id);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException('Solo se pueden eliminar borradores; los confirmados se anulan', 'DOCUMENT_NOT_DELETABLE');
    await this.prisma.tx.inventoryDocument.delete({ where: { id } });
    await this.audit.log(`inventory_${docType.toLowerCase()}`, id, 'DELETE');
  }

  private async find(docType: InvDocType, id: string) {
    const doc = await this.prisma.tx.inventoryDocument.findFirst({ where: { id, docType } });
    if (!doc) throw new NotFoundError('Documento', id);
    return doc;
  }

  async get(docType: InvDocType, id: string) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id);
    const lines = await tx.inventoryDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    const products = new Map((await tx.product.findMany({ where: { id: { in: lines.map(l => l.productId) } }, select: { id: true, sku: true, name: true, trackingMode: true } })).map(p => [p.id, p]));
    return { ...doc, lines: lines.map(l => ({ ...l, product: products.get(l.productId) })) };
  }

  async list(docType: InvDocType, q: z.infer<typeof invDocListSchema>) {
    const where: any = { docType };
    if (q.status) where.status = q.status;
    if (q.warehouseId) where.OR = [{ warehouseId: q.warehouseId }, { toWarehouseId: q.warehouseId }];
    if (q.dateFrom || q.dateTo) where.docDate = { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) };
    if (q.search) where.number = { contains: q.search, mode: 'insensitive' };
    const [rows, total] = await Promise.all([
      this.prisma.tx.inventoryDocument.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.tx.inventoryDocument.count({ where }),
    ]);
    return Paged.of(rows, total, q.page, q.limit);
  }

  // ───────── confirmar ─────────
  async confirm(docType: InvDocType, id: string) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id);
    if (doc.status !== 'DRAFT') throw new BusinessRuleException(`El documento ya está ${doc.status}`, 'INVALID_STATE');
    const lines = await tx.inventoryDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    if (!lines.length) throw new BusinessRuleException('El documento no tiene líneas', 'EMPTY_DOCUMENT');
    const serialProductIds = new Set((await tx.product.findMany({ where: { id: { in: lines.map(l => l.productId) }, trackingMode: 'SERIAL' }, select: { id: true } })).map(x => x.id));
    // Revalidar contra el estado actual (producto/depósito pudieron cambiar desde el borrador).
    await this.validate(docType, {
      warehouseId: doc.warehouseId, toWarehouseId: doc.toWarehouseId, reasonId: doc.reasonId, notes: doc.notes,
      lines: lines.map(l => ({ productId: l.productId, quantity: l.quantity.toString(), unitCost: l.unitCost?.toString(), countedQty: l.countedQty?.toString(), newAvgCost: l.newAvgCost?.toString(), lotNo: l.lotNo, expiryDate: l.expiryDate?.toISOString().slice(0, 10) ?? null, serials: l.serials.length || serialProductIds.has(l.productId) ? l.serials : undefined })),
    } as z.infer<typeof invDocSchema>);

    const moves: MoveRequest[] = [];
    for (const l of lines) {
      const base = { productId: l.productId, warehouseId: doc.warehouseId, docLineId: l.id, lotNo: l.lotNo, expiryDate: l.expiryDate?.toISOString().slice(0, 10) ?? null, ref: l.id, ...(l.serials.length || serialProductIds.has(l.productId) ? { serials: l.serials } : {}) };
      switch (docType) {
        case 'TRANSFER':
          moves.push({ ...base, kind: 'TRANSFER_OUT', quantity: l.quantity.toString() });
          moves.push({ ...base, warehouseId: doc.toWarehouseId!, kind: 'TRANSFER_IN', quantity: l.quantity.toString() });
          break;
        case 'CHARGE': moves.push({ ...base, kind: 'ENTRY', quantity: l.quantity.toString(), unitCost: l.unitCost!.toString() }); break;
        case 'DISCHARGE': moves.push({ ...base, kind: 'EXIT', quantity: l.quantity.toString() }); break;
        case 'ADJUSTMENT': moves.push({ ...base, kind: 'ADJUST_TO', countedQty: l.countedQty!.toString() }); break;
        case 'COST_ADJUSTMENT': moves.push({ ...base, kind: 'COST_ADJ', newAvgCost: l.newAvgCost!.toString() }); break;
      }
    }
    const number = await this.seq.next(`INVENTORY_${docType}`);
    const posted = await this.posting.post({ docType, docId: id, moves });

    if (docType === 'ADJUSTMENT') {
      for (const m of posted) {
        const lineId = m.ref as string;
        const counted = lines.find(x => x.id === lineId)!.countedQty!;
        await tx.inventoryDocumentLine.update({
          where: { id: lineId },
          data: { systemQty: m.systemQty!.toFixed(4), difference: D(counted.toString()).minus(m.systemQty!).toFixed(4) },
        });
      }
    }
    await tx.inventoryDocument.update({
      where: { id },
      data: { status: 'CONFIRMED', number, docDate: new Date(caracasToday()), confirmedAt: new Date(), confirmedBy: this.prisma.userId, version: { increment: 1 } },
    });
    await this.audit.log(`inventory_${docType.toLowerCase()}`, id, 'CONFIRM', { number, movements: posted.length });
    return this.get(docType, id);
  }

  // ───────── anular ─────────
  async cancel(docType: InvDocType, id: string, reason: string) {
    const tx = this.prisma.tx;
    const doc = await this.find(docType, id);
    if (doc.status === 'CANCELLED') throw new BusinessRuleException('El documento ya está anulado', 'INVALID_STATE');
    if (doc.status === 'CONFIRMED') {
      if (docType === 'COST_ADJUSTMENT') throw new BusinessRuleException('Un ajuste de costo se corrige con otro ajuste de costo', 'COST_ADJUSTMENT_NOT_REVERSIBLE');
      await this.posting.reverse(docType, id, docType === 'TRANSFER' ? 'TRANSFER' : 'STANDARD');
    }
    await tx.inventoryDocument.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: this.prisma.userId, cancelReason: reason, version: { increment: 1 } },
    });
    await tx.documentCancellation.create({ data: { companyId: this.prisma.companyId, docType: `INVENTORY_${docType}`, docId: id, reason, cancelledBy: this.prisma.userId } });
    await this.audit.log(`inventory_${docType.toLowerCase()}`, id, 'CANCEL', { reason, wasConfirmed: doc.status === 'CONFIRMED' });
    return this.get(docType, id);
  }

  /** Hoja de conteo: existencias del sistema por línea (para imprimir/llenar el físico). */
  async countSheet(id: string) {
    const tx = this.prisma.tx;
    const doc = await this.find('ADJUSTMENT', id);
    const lines = await tx.inventoryDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    const [products, stock] = await Promise.all([
      tx.product.findMany({ where: { id: { in: lines.map(l => l.productId) } }, select: { id: true, sku: true, name: true } }),
      tx.inventoryStock.findMany({ where: { warehouseId: doc.warehouseId, productId: { in: lines.map(l => l.productId) } } }),
    ]);
    const pm = new Map(products.map(p => [p.id, p]));
    const sm = new Map(stock.map(s => [s.productId, s.quantity.toString()]));
    return {
      id: doc.id, warehouseId: doc.warehouseId, status: doc.status, generatedAt: new Date().toISOString(),
      lines: lines.map(l => ({ lineNo: l.lineNo, sku: pm.get(l.productId)?.sku, name: pm.get(l.productId)?.name, lotNo: l.lotNo, systemQty: l.systemQty?.toString() ?? sm.get(l.productId) ?? '0', countedQty: l.countedQty?.toString() ?? null })),
    };
  }
}
