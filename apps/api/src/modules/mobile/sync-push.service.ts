import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { formatRif, isValidRif } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { PermissionsService } from '../../common/auth/permissions.service';
import { AuthUser } from '../../common/auth/decorators';
import { BusinessRuleException } from '../../common/errors/errors';
import { SalesService } from '../sales/sales.service';
import { SalesDocInput, Viewer } from '../sales/sales.types';
import { customerData, customerUpdateData, OpResult, orderCreateData, PushOperation, quoteCreateData, quoteUpdateData, docData } from './mobile.types';

type Ctx = { user: AuthUser; deviceId: string; have: string[]; viewer: Viewer; seller: Awaited<ReturnType<PrismaService['db']['seller']['findFirst']>> };
type Applied = Omit<OpResult, 'clientOpId'>;
class Reject extends Error { constructor(public code: string, message: string) { super(message); } }

/**
 * Recepción de operaciones del móvil. Cada operación se aplica dentro de un SAVEPOINT: si falla, solo se deshace esa
 * operación y el resto del lote sigue. El resultado se guarda por `clientOpId` (exactamente una vez: reenviar devuelve lo mismo).
 */
@Injectable()
export class SyncPushService {
  private readonly log = new Logger(SyncPushService.name);
  constructor(
    private readonly prisma: PrismaService, private readonly sales: SalesService, private readonly audit: AuditService,
    private readonly perms: PermissionsService,
  ) {}

  async push(user: AuthUser, deviceId: string, operations: PushOperation[]) {
    const tx = this.prisma.tx;
    const have = await this.perms.forUser(user.userId, user.companyId!);
    const seller = await tx.seller.findFirst({ where: { userId: user.userId, deletedAt: null, isActive: true } });
    const ctx: Ctx = { user, deviceId, have, seller, viewer: { userId: user.userId, all: have.includes('sales:documents:read-all'), creditOverride: false } };
    const results: OpResult[] = [];
    for (const op of [...operations].sort((a, b) => a.clientSeq - b.clientSeq)) results.push(await this.one(ctx, op));
    return { results, serverTime: new Date().toISOString() };
  }

  private async one(ctx: Ctx, op: PushOperation): Promise<OpResult> {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const prev = await tx.syncOperation.findUnique({ where: { companyId_clientOpId: { companyId, clientOpId: op.clientOpId } } });
    if (prev) {
      return {
        clientOpId: op.clientOpId, status: prev.status === 'APPLIED' ? 'DUPLICATE' : (prev.status as OpResult['status']), errorCode: prev.errorCode ?? undefined, message: prev.message ?? undefined,
        serverId: prev.serverId ?? undefined, serverNumber: prev.serverNumber, serverStatus: prev.serverStatus ?? undefined,
      };
    }
    await tx.$executeRawUnsafe('SAVEPOINT sync_op');
    try {
      const out = await this.apply(ctx, op);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT sync_op');
      const status = out.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'APPLIED';
      await this.record(ctx, op, { ...out, status });
      return { clientOpId: op.clientOpId, ...out, status };
    } catch (e) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sync_op');
      const known = this.known(e);
      if (known === 'BLOCKED') return { clientOpId: op.clientOpId, status: 'BLOCKED', errorCode: 'DEPENDENCY_REJECTED', message: 'Depende de una operación rechazada: corríjala primero' };
      if (!known) {
        this.log.error(`push ${op.entity}.${op.action} ${op.clientOpId}: ${(e as Error).stack ?? e}`);
        return { clientOpId: op.clientOpId, status: 'RETRY', errorCode: 'INTERNAL', message: 'Error temporal del servidor; se reintentará' };
      }
      await this.record(ctx, op, { status: 'REJECTED', errorCode: known.code, message: known.message });
      return { clientOpId: op.clientOpId, status: 'REJECTED', errorCode: known.code, message: known.message };
    }
  }

  /** Errores de negocio/validación → rechazo definitivo; cualquier otra cosa → reintento. */
  private known(e: unknown): { code: string; message: string } | 'BLOCKED' | null {
    if (e instanceof Reject) return e.code === 'DEPENDENCY_REJECTED' ? 'BLOCKED' : { code: e.code, message: e.message };
    if (e instanceof z.ZodError) return { code: 'VALIDATION_ERROR', message: e.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300) };
    if (e instanceof HttpException && e.getStatus() >= 400 && e.getStatus() < 500) {
      const r = e.getResponse() as { error?: string; message?: string };
      return { code: r?.error ?? 'REJECTED', message: String(r?.message ?? e.message) };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { code: 'CONFLICT', message: 'Ya existe un registro con esos datos' };
    return null;
  }

  private async record(ctx: Ctx, op: PushOperation, r: Omit<OpResult, 'clientOpId'>) {
    await this.prisma.tx.syncOperation.create({
      data: {
        companyId: this.prisma.companyId, deviceId: ctx.deviceId, clientOpId: op.clientOpId, clientSeq: BigInt(op.clientSeq), entity: op.entity, action: op.action, localId: op.entityId,
        status: r.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : r.status === 'APPLIED' ? 'APPLIED' : 'REJECTED', errorCode: r.errorCode ?? null, message: r.message ?? null,
        serverId: r.serverId ?? null, serverNumber: r.serverNumber ?? null, serverStatus: r.serverStatus ?? null,
      },
    });
  }

  private need(ctx: Ctx, ...perms: string[]) {
    for (const p of perms) if (!ctx.have.includes(p)) throw new Reject('FORBIDDEN', `No tiene permiso para esta operación (${p})`);
  }

  private async apply(ctx: Ctx, op: PushOperation): Promise<Applied> {
    switch (`${op.entity}.${op.action}`) {
      case 'customer.create': return this.customerCreate(ctx, op);
      case 'customer.update': return this.customerUpdate(ctx, op);
      case 'sales_quote.create': return this.quoteCreate(ctx, op);
      case 'sales_quote.update': return this.quoteUpdate(ctx, op);
      case 'sales_order.create': return this.orderCreate(ctx, op);
      default: throw new Reject('UNSUPPORTED_OPERATION', `Operación no soportada: ${op.entity}.${op.action}`);
    }
  }

  // ───────────────── ids locales ─────────────────
  /** Id local → id del servidor (si no hay correspondencia se asume que ya es un id del servidor). */
  private async resolve(entity: string, id: string): Promise<string> {
    const m = await this.prisma.tx.syncEntityMap.findUnique({ where: { companyId_entity_localId: { companyId: this.prisma.companyId, entity, localId: id } } });
    return m?.serverId ?? id;
  }

  private async remember(entity: string, localId: string, serverId: string) {
    await this.prisma.tx.syncEntityMap.upsert({
      where: { companyId_entity_localId: { companyId: this.prisma.companyId, entity, localId } }, update: { serverId }, create: { companyId: this.prisma.companyId, entity, localId, serverId },
    });
  }

  /** Cliente de un documento: si es un id local cuyo alta fue rechazada, la operación queda bloqueada hasta resolverla. */
  private async customerRef(localOrServerId: string): Promise<string> {
    const id = await this.resolve('customer', localOrServerId);
    if (await this.prisma.tx.customer.findFirst({ where: { id }, select: { id: true } })) return id;
    const rejected = await this.prisma.tx.syncOperation.findFirst({ where: { entity: 'customer', localId: localOrServerId, status: 'REJECTED' } });
    if (rejected) throw new Reject('DEPENDENCY_REJECTED', 'El alta del cliente fue rechazada');
    throw new Reject('CUSTOMER_NOT_FOUND', 'Cliente inexistente');
  }

  // ───────────────── clientes ─────────────────
  private async customerCreate(ctx: Ctx, op: PushOperation): Promise<Applied> {
    this.need(ctx, 'admin:customers:create');
    if (!ctx.seller?.allowCustomerCreate) throw new Reject('CUSTOMER_CREATE_NOT_ALLOWED', 'No tiene permitido crear clientes desde el móvil');
    const d = customerData.parse(op.data);
    if (!isValidRif(d.rif)) throw new Reject('INVALID_RIF', 'RIF inválido');
    const rif = formatRif(d.rif);
    const tx = this.prisma.tx;
    const existing = await tx.customer.findFirst({ where: { rif, deletedAt: null } });
    if (existing) { await this.remember('customer', op.entityId, existing.id); return { status: 'APPLIED', serverId: existing.id, serverStatus: existing.validationStatus, linked: true }; }
    const created = await tx.customer.create({
      data: {
        companyId: this.prisma.companyId, rif, legalName: d.legalName, tradeName: d.tradeName ?? null, personType: d.personType ?? 'LEGAL', phone: d.phone ?? null, email: d.email ?? null,
        address: d.address ?? null, priceListId: d.priceListId ?? null, sellerId: ctx.seller.id, validationStatus: 'PENDING',
      },
    });
    await this.remember('customer', op.entityId, created.id);
    await this.audit.log('customer', created.id, 'CREATE', { source: 'mobile', rif, device: ctx.deviceId });
    return { status: 'APPLIED', serverId: created.id, serverStatus: created.validationStatus };
  }

  private async customerUpdate(ctx: Ctx, op: PushOperation): Promise<Applied> {
    this.need(ctx, 'admin:customers:update');
    const d = customerUpdateData.parse(op.data);
    const id = await this.customerRef(op.entityId);
    const tx = this.prisma.tx;
    const c = await tx.customer.findFirst({ where: { id, deletedAt: null } });
    // Solo clientes propios y aún sin validar: una vez validados, los cambios se hacen desde la oficina.
    if (!c || c.sellerId !== ctx.seller?.id) throw new Reject('CUSTOMER_NOT_FOUND', 'Cliente inexistente');
    if (c.validationStatus !== 'PENDING') throw new Reject('CUSTOMER_LOCKED', 'El cliente ya fue validado: los cambios se hacen desde la oficina');
    const u = await tx.customer.update({ where: { id }, data: { ...d, version: { increment: 1 } } });
    await this.audit.log('customer', id, 'UPDATE', { source: 'mobile', ...d });
    return { status: 'APPLIED', serverId: u.id, serverStatus: u.validationStatus };
  }

  // ───────────────── documentos ─────────────────
  /** Entrada común: aplica las políticas del vendedor (descuento máximo, precio editable) y completa los valores por omisión. */
  private async docInput(ctx: Ctx, d: z.infer<typeof docData>, defaults: { reservesStock: boolean }): Promise<SalesDocInput> {
    const tx = this.prisma.tx;
    if (!ctx.seller) throw new Reject('SELLER_REQUIRED', 'Su usuario no está ligado a un vendedor');
    const max = Number(ctx.seller.maxDiscountPct);
    for (const l of d.lines) {
      const dp = Number(l.discountPct ?? 0);
      if (dp > max) throw new Reject('DISCOUNT_NOT_ALLOWED', `El descuento ${dp} % excede el máximo permitido (${max} %)`);
    }
    const company = await tx.company.findUniqueOrThrow({ where: { id: this.prisma.companyId }, select: { valuationCurrencyId: true } });
    const warehouseId = d.warehouseId ?? (await tx.warehouse.findFirst({ where: { deletedAt: null, isActive: true }, orderBy: { code: 'asc' }, select: { id: true } }))?.id ?? null;
    return {
      customerId: await this.customerRef(d.customerId), sellerId: ctx.seller.id, warehouseId, priceListId: null, currencyId: d.currencyId ?? company.valuationCurrencyId,
      exchangeRate: d.exchangeRate, validUntil: d.validUntil ?? null, paymentCondition: d.paymentCondition ?? 'CASH', creditDays: d.creditDays ?? 0,
      reservesStock: d.reservesStock ?? defaults.reservesStock, notes: d.notes ?? null,
      // Sin permiso para editar precios, el precio lo fija el servidor (lista vigente).
      lines: d.lines.map(l => ({ productId: l.productId, quantity: l.quantity, description: l.description ?? null, discountPct: l.discountPct, ...(ctx.seller!.allowPriceEdit && l.unitPrice ? { unitPrice: l.unitPrice } : {}) })),
    } as SalesDocInput;
  }

  private async quoteCreate(ctx: Ctx, op: PushOperation): Promise<Applied> {
    this.need(ctx, 'sales:quotes:create');
    const d = quoteCreateData.parse(op.data);
    if (d.send) this.need(ctx, 'sales:quotes:confirm');
    const input = await this.docInput(ctx, d, { reservesStock: false });
    let doc = await this.sales.create('QUOTE', { ...input, reservesStock: false }, ctx.viewer);
    if (d.send) doc = await this.sales.quoteAction(doc.id, 'send', ctx.viewer);
    await this.remember('sales_quote', op.entityId, doc.id);
    return { status: 'APPLIED', serverId: doc.id, serverNumber: doc.number, serverStatus: doc.status };
  }

  private async quoteUpdate(ctx: Ctx, op: PushOperation): Promise<Applied> {
    this.need(ctx, 'sales:quotes:update');
    const d = quoteUpdateData.parse(op.data);
    const id = await this.resolve('sales_quote', op.entityId);
    const current = await this.sales.find('QUOTE', id, ctx.viewer, true).catch(() => null);
    if (!current) throw new Reject('NOT_FOUND', 'Cotización inexistente');
    let doc = current as { id: string; number: string | null; status: string; version: number };
    if (d.customerId !== undefined || d.lines !== undefined) {
      const full = await this.docInput(ctx, { ...(await this.currentAsData(current.id, d)) }, { reservesStock: false });
      doc = await this.sales.update('QUOTE', id, { ...full, version: current.version }, ctx.viewer) as typeof doc;
    }
    if (d.send) { this.need(ctx, 'sales:quotes:confirm'); doc = await this.sales.quoteAction(id, 'send', ctx.viewer) as typeof doc; }
    return { status: 'APPLIED', serverId: id, serverNumber: doc.number, serverStatus: doc.status };
  }

  /** Une los cambios con el documento actual (la app envía el documento completo al editar un borrador). */
  private async currentAsData(id: string, d: Partial<z.infer<typeof docData>>): Promise<z.infer<typeof docData>> {
    const tx = this.prisma.tx;
    const doc = await tx.salesDocument.findFirstOrThrow({ where: { id } });
    const lines = await tx.salesDocumentLine.findMany({ where: { documentId: id }, orderBy: { lineNo: 'asc' } });
    return {
      customerId: d.customerId ?? doc.customerId, warehouseId: d.warehouseId ?? doc.warehouseId, currencyId: d.currencyId ?? doc.currencyId, exchangeRate: d.exchangeRate,
      validUntil: d.validUntil === undefined ? doc.validUntil?.toISOString().slice(0, 10) ?? null : d.validUntil, paymentCondition: d.paymentCondition ?? (doc.paymentCondition as 'CASH' | 'CREDIT'),
      creditDays: d.creditDays ?? doc.creditDays, notes: d.notes === undefined ? doc.notes : d.notes, reservesStock: d.reservesStock ?? doc.reservesStock,
      lines: d.lines ?? lines.map(l => ({ productId: l.productId, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), discountPct: l.discountPct.toString(), description: l.description })),
    };
  }

  private async orderCreate(ctx: Ctx, op: PushOperation): Promise<Applied> {
    this.need(ctx, 'sales:orders:create', 'sales:orders:confirm');
    const d = orderCreateData.parse(op.data);
    const input = await this.docInput(ctx, d, { reservesStock: true });
    let order: { id: string; number: string | null; status: string; version: number };
    if (d.sourceQuoteId) {
      const quoteId = await this.resolve('sales_quote', d.sourceQuoteId);
      let quote = await this.sales.find('QUOTE', quoteId, ctx.viewer, true).catch(() => null);
      if (!quote) throw new Reject('NOT_FOUND', 'Cotización de origen inexistente');
      if (quote.status === 'DRAFT') quote = (await this.sales.quoteAction(quoteId, 'send', ctx.viewer)) as typeof quote;
      if (quote.status === 'SENT') await this.sales.quoteAction(quoteId, 'accept', ctx.viewer);
      order = (await this.sales.convert('QUOTE', 'ORDER', quoteId, ctx.viewer)) as typeof order;
      // Ajustes del vendedor sobre las líneas copiadas (cantidades): se enlazan con la línea de origen por producto.
      const qLines = await this.prisma.tx.salesDocumentLine.findMany({ where: { documentId: quoteId }, orderBy: { lineNo: 'asc' } });
      const pool = [...qLines];
      const lines = input.lines.map(l => {
        const i = pool.findIndex(x => x.productId === l.productId);
        const parent = i >= 0 ? pool.splice(i, 1)[0] : undefined;
        return { ...l, parentLineId: parent?.id ?? null };
      });
      order = (await this.sales.update('ORDER', order.id, { lines, reservesStock: input.reservesStock, paymentCondition: input.paymentCondition, creditDays: input.creditDays, version: order.version }, ctx.viewer)) as typeof order;
    } else {
      order = (await this.sales.create('ORDER', input, ctx.viewer)) as typeof order;
    }
    await this.remember('sales_order', op.entityId, order.id);
    // Confirmar crea la reserva y valida el crédito; si excede el límite, el pedido queda en borrador para que administración decida.
    await this.prisma.tx.$executeRawUnsafe('SAVEPOINT sync_confirm');
    try {
      const confirmed = await this.sales.confirm('ORDER', order.id, ctx.viewer, false);
      await this.prisma.tx.$executeRawUnsafe('RELEASE SAVEPOINT sync_confirm');
      return { status: 'APPLIED', serverId: order.id, serverNumber: confirmed.number, serverStatus: confirmed.status };
    } catch (e) {
      await this.prisma.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sync_confirm');
      if (e instanceof BusinessRuleException && e.code === 'CREDIT_LIMIT_EXCEEDED') {
        return { status: 'NEEDS_REVIEW', serverId: order.id, serverNumber: order.number, serverStatus: 'DRAFT', errorCode: e.code, message: 'Excede el límite de crédito: administración debe autorizarlo' };
      }
      throw e;
    }
  }
}
