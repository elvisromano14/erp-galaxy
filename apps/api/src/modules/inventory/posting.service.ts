import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  applyCostAdjustment, applyEntry, applyExit, applyPurchaseReturn, CostState, COST_DP, D, Decimal, DecimalLike, QTY_DP, round, ZERO,
} from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { BusinessRuleException, ErrorDetailLike } from './inventory.errors';

/**
 * Motor de contabilización del kardex (erp-v3 §7.2 / §21).
 * Orden de bloqueo FIJO por transacción: product_costs → inventory_stock → lotes, siempre ascendente por id
 * ⇒ sin interbloqueos. El bloqueo de product_costs serializa todo movimiento del mismo producto.
 */
export type MoveKind =
  | 'ENTRY'         // compra / cargo / devolución de venta: entrada con costo
  | 'EXIT'          // venta / descargo: salida a costo promedio
  | 'RETURN_OUT'    // devolución / anulación de compra: salida al costo original
  | 'TRANSFER_OUT'  // pata de salida de un traslado
  | 'TRANSFER_IN'   // pata de entrada de un traslado
  | 'ADJUST_TO'     // ajuste: lleva el saldo a `countedQty` (entrada o salida a costo promedio)
  | 'COST_ADJ';     // ajuste de costo (movimiento de valor, qty = 0)

export interface MoveRequest {
  kind: MoveKind;
  productId: string;
  warehouseId: string;
  quantity?: DecimalLike;     // positiva; no aplica a ADJUST_TO / COST_ADJ
  unitCost?: DecimalLike;     // ENTRY (obligatorio) / RETURN_OUT (costo original)
  countedQty?: DecimalLike;   // ADJUST_TO
  newAvgCost?: DecimalLike;   // COST_ADJ
  lotNo?: string | null;      // entradas con lote; salidas: lote concreto (si no, FEFO)
  expiryDate?: string | null;
  lotId?: string | null;      // lote explícito (reversos)
  docLineId?: string | null;
  reversalOf?: string | null;
  ref?: unknown;              // dato opaco del llamador devuelto en el resultado
}

export interface PostedMove {
  id: string; seq: bigint; productId: string; warehouseId: string; lotId: string | null;
  quantity: Decimal; unitCost: Decimal; totalCost: Decimal; avgCostAfter: Decimal;
  docLineId: string | null; kind: MoveKind; systemQty?: Decimal; ref?: unknown;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class PostingService {
  constructor(private readonly prisma: PrismaService) {}

  async post(p: { docType: string; docId: string; moves: MoveRequest[] }): Promise<PostedMove[]> {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const userId = this.prisma.userId ?? null;
    if (!p.moves.length) return [];

    const productIds = [...new Set(p.moves.map(m => m.productId))].sort();
    const products = new Map((await tx.product.findMany({ where: { id: { in: productIds } } })).map(x => [x.id, x]));
    for (const id of productIds) if (!products.has(id)) throw new BusinessRuleException('Producto inexistente', 'PRODUCT_NOT_FOUND', [{ code: 'PRODUCT_NOT_FOUND', message: id }]);
    const moves = p.moves.filter(m => !products.get(m.productId)!.isService);
    if (!moves.length) return [];

    const warehouseIds = [...new Set(moves.map(m => m.warehouseId))];
    const warehouses = new Map((await tx.warehouse.findMany({ where: { id: { in: warehouseIds } } })).map(w => [w.id, w]));
    for (const id of warehouseIds) if (!warehouses.has(id)) throw new BusinessRuleException('Depósito inexistente', 'WAREHOUSE_NOT_FOUND');

    await this.assertPeriodOpen(tx, companyId);

    // 1) bloqueo de costos (ordenado por producto)
    const lockedIds = [...new Set(moves.map(m => m.productId))].sort();
    await tx.$executeRaw`
      INSERT INTO product_costs (company_id, product_id)
      SELECT ${companyId}::uuid, x FROM unnest(${lockedIds}::uuid[]) AS x
      ON CONFLICT (company_id, product_id) DO NOTHING`;
    const costRows = await tx.$queryRaw<{ product_id: string; avg_cost: Prisma.Decimal }[]>`
      SELECT product_id, avg_cost FROM product_costs
      WHERE company_id = ${companyId}::uuid AND product_id = ANY(${lockedIds}::uuid[])
      ORDER BY product_id FOR UPDATE`;

    // 2) bloqueo de saldos por (producto, depósito) ordenados
    const pairs = [...new Map(moves.map(m => [`${m.productId}|${m.warehouseId}`, [m.productId, m.warehouseId] as const])).values()]
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    await tx.$executeRaw`
      INSERT INTO inventory_stock (company_id, product_id, warehouse_id)
      SELECT ${companyId}::uuid, p, w FROM unnest(${pairs.map(x => x[0])}::uuid[], ${pairs.map(x => x[1])}::uuid[]) AS t(p, w)
      ON CONFLICT (company_id, product_id, warehouse_id) DO NOTHING`;
    const stockRows = await tx.$queryRaw<{ product_id: string; warehouse_id: string; quantity: Prisma.Decimal }[]>`
      SELECT s.product_id, s.warehouse_id, s.quantity FROM inventory_stock s
      JOIN unnest(${pairs.map(x => x[0])}::uuid[], ${pairs.map(x => x[1])}::uuid[]) AS t(p, w) ON t.p = s.product_id AND t.w = s.warehouse_id
      WHERE s.company_id = ${companyId}::uuid
      ORDER BY s.product_id, s.warehouse_id FOR UPDATE OF s`;
    const totals = await tx.$queryRaw<{ product_id: string; q: Prisma.Decimal }[]>`
      SELECT product_id, COALESCE(SUM(quantity), 0) AS q FROM inventory_stock
      WHERE company_id = ${companyId}::uuid AND product_id = ANY(${lockedIds}::uuid[]) GROUP BY product_id`;

    const cost = new Map<string, CostState>();
    for (const r of costRows) cost.set(r.product_id, { qty: ZERO, avgCost: D(r.avg_cost.toString()) });
    for (const t of totals) cost.get(t.product_id)!.qty = D(t.q.toString());
    const whQty = new Map(stockRows.map(r => [`${r.product_id}|${r.warehouse_id}`, D(r.quantity.toString())]));
    const costPending = new Set<string>();

    // 3) procesamiento en memoria + lotes
    interface Row { req: MoveRequest; qty: Decimal; unitCost: Decimal; total: Decimal; qtyAfter: Decimal; whAfter: Decimal; avgAfter: Decimal; lotId: string | null; systemQty?: Decimal }
    const rows: Row[] = [];
    const lotBalanceDelta: { productId: string; warehouseId: string; lotId: string; delta: Decimal }[] = [];

    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const product = products.get(m.productId)!;
      const wh = warehouses.get(m.warehouseId)!;
      const key = `${m.productId}|${m.warehouseId}`;
      const st = cost.get(m.productId)!;
      const lots = product.trackingMode === 'LOT';
      const fail = (code: string, message: string, extra?: ErrorDetailLike) =>
        new BusinessRuleException(message, code, [{ field: `lines[${i}]`, code, message: extra?.message ?? m.productId }]);

      const emit = (qtySigned: Decimal, unitCost: Decimal, newState: CostState, whNew: Decimal, lotId: string | null, systemQty?: Decimal, req: MoveRequest = m) => {
        rows.push({
          req, qty: qtySigned, unitCost, total: round(qtySigned.mul(unitCost), 4),
          qtyAfter: newState.qty, whAfter: whNew, avgAfter: newState.avgCost, lotId, systemQty,
        });
        cost.set(m.productId, newState);
        whQty.set(key, whNew);
      };
      const assertStock = (resulting: Decimal) => {
        if (resulting.isNegative() && !wh.allowNegativeStock) {
          throw fail('INSUFFICIENT_STOCK', `Stock insuficiente para el producto ${product.sku} en el depósito ${wh.code}`);
        }
      };

      switch (m.kind) {
        case 'ENTRY': {
          const q = D(m.quantity!);
          if (m.unitCost === undefined) throw fail('COST_REQUIRED', 'La entrada requiere costo unitario');
          const r = applyEntry(st, q, m.unitCost);
          const lotId = lots ? await this.resolveLot(tx, companyId, product, m, true) : null;
          if (lotId) lotBalanceDelta.push({ productId: m.productId, warehouseId: m.warehouseId, lotId, delta: q });
          emit(q, r.unitCost, r.state, whQty.get(key)!.plus(q), lotId);
          break;
        }
        case 'EXIT':
        case 'RETURN_OUT':
        case 'TRANSFER_OUT': {
          const q = D(m.quantity!);
          const base = whQty.get(key)!;
          assertStock(base.minus(q));
          // Reparto por lote (FEFO o lote indicado)
          const parts = lots ? await this.allocateLots(tx, companyId, product, m, q, fail) : [{ lotId: null as string | null, qty: q }];
          for (const part of parts) {
            const cur = cost.get(m.productId)!;
            const wNow = whQty.get(key)!;
            let r;
            if (m.kind === 'EXIT') r = applyExit(cur, part.qty);
            else if (m.kind === 'RETURN_OUT') r = applyPurchaseReturn(cur, part.qty, m.unitCost ?? cur.avgCost);
            else r = { state: { qty: cur.qty, avgCost: cur.avgCost }, unitCost: cur.avgCost }; // traslado: C y Q globales no cambian
            if (m.kind === 'EXIT' && cur.avgCost.isZero() && cur.qty.lte(0)) costPending.add(m.productId);
            if (part.lotId) lotBalanceDelta.push({ productId: m.productId, warehouseId: m.warehouseId, lotId: part.lotId, delta: part.qty.neg() });
            emit(part.qty.neg(), r.unitCost, r.state, wNow.minus(part.qty), part.lotId);
          }
          break;
        }
        case 'TRANSFER_IN': {
          const q = D(m.quantity!);
          const cur = st;
          const lotId = lots ? await this.resolveLot(tx, companyId, product, m, false) : null;
          if (lotId) lotBalanceDelta.push({ productId: m.productId, warehouseId: m.warehouseId, lotId, delta: q });
          emit(q, cur.avgCost, { qty: cur.qty, avgCost: cur.avgCost }, whQty.get(key)!.plus(q), lotId);
          break;
        }
        case 'ADJUST_TO': {
          const counted = D(m.countedQty!);
          let system: Decimal;
          let lotId: string | null = null;
          if (lots) {
            if (!m.lotNo && !m.lotId) throw fail('LOT_REQUIRED', `El producto ${product.sku} se controla por lotes: indique el lote`);
            lotId = await this.resolveLot(tx, companyId, product, m, false, true);
            const bal = await tx.inventoryLotBalance.findFirst({ where: { productId: m.productId, warehouseId: m.warehouseId, lotId: lotId! } });
            system = D(bal?.quantity.toString() ?? 0);
          } else system = whQty.get(key)!;
          const diff = counted.minus(system);
          if (diff.isZero()) { rows.push({ req: m, qty: ZERO, unitCost: st.avgCost, total: ZERO, qtyAfter: st.qty, whAfter: whQty.get(key)!, avgAfter: st.avgCost, lotId, systemQty: system }); break; }
          if (diff.gt(0)) {
            const r = applyEntry(st, diff, st.avgCost);
            if (lotId) lotBalanceDelta.push({ productId: m.productId, warehouseId: m.warehouseId, lotId, delta: diff });
            emit(diff, st.avgCost, r.state, whQty.get(key)!.plus(diff), lotId, system);
          } else {
            const q = diff.abs();
            assertStock(whQty.get(key)!.minus(q));
            const r = applyExit(st, q);
            if (lotId) lotBalanceDelta.push({ productId: m.productId, warehouseId: m.warehouseId, lotId, delta: q.neg() });
            emit(q.neg(), r.unitCost, r.state, whQty.get(key)!.minus(q), lotId, system);
          }
          break;
        }
        case 'COST_ADJ': {
          const r = applyCostAdjustment(st, m.newAvgCost!);
          rows.push({ req: m, qty: ZERO, unitCost: r.state.avgCost, total: r.valueDelta, qtyAfter: r.state.qty, whAfter: whQty.get(key)!, avgAfter: r.state.avgCost, lotId: null, systemQty: st.qty });
          cost.set(m.productId, r.state);
          break;
        }
      }
    }

    // 4) persistir: kardex, saldos, costos, lotes
    const created = await tx.inventoryMovement.createManyAndReturn({
      data: rows.map(r => ({
        companyId, productId: r.req.productId, warehouseId: r.req.warehouseId, lotId: r.lotId,
        quantity: r.qty.toFixed(QTY_DP), unitCost: r.unitCost.toFixed(COST_DP), totalCost: r.total.toFixed(4),
        qtyAfter: r.qtyAfter.toFixed(QTY_DP), warehouseQtyAfter: r.whAfter.toFixed(QTY_DP), avgCostAfter: r.avgAfter.toFixed(COST_DP),
        docType: p.docType, docId: p.docId, docLineId: r.req.docLineId ?? null, reversalOf: r.req.reversalOf ?? null, createdBy: userId,
      })),
    });
    // createManyAndReturn conserva el orden de inserción; aseguramos por seq
    created.sort((a, b) => (a.seq < b.seq ? -1 : 1));

    for (const [key, qty] of whQty) {
      const [productId, warehouseId] = key.split('|');
      await tx.inventoryStock.update({ where: { companyId_productId_warehouseId: { companyId, productId, warehouseId } }, data: { quantity: qty.toFixed(QTY_DP), updatedAt: new Date() } });
    }
    for (const [productId, st] of cost) {
      await tx.productCost.update({
        where: { companyId_productId: { companyId, productId } },
        data: { avgCost: st.avgCost.toFixed(COST_DP), costPending: costPending.has(productId) ? true : undefined, updatedAt: new Date() },
      });
    }
    // Una entrada con costo resuelve el "costo pendiente"
    const entryProducts = [...new Set(rows.filter(r => r.req.kind === 'ENTRY' && r.unitCost.gt(0)).map(r => r.req.productId))];
    if (entryProducts.length) await tx.productCost.updateMany({ where: { companyId, productId: { in: entryProducts } }, data: { costPending: false } });

    for (const d of lotBalanceDelta) {
      await tx.inventoryLotBalance.upsert({
        where: { companyId_productId_warehouseId_lotId: { companyId, productId: d.productId, warehouseId: d.warehouseId, lotId: d.lotId } },
        update: { quantity: { increment: d.delta.toFixed(QTY_DP) } },
        create: { companyId, productId: d.productId, warehouseId: d.warehouseId, lotId: d.lotId, quantity: d.delta.toFixed(QTY_DP) },
      });
    }
    const negLot = await tx.inventoryLotBalance.findFirst({ where: { companyId, productId: { in: lockedIds }, quantity: { lt: 0 } } });
    if (negLot) throw new BusinessRuleException('El saldo de un lote quedaría negativo', 'INSUFFICIENT_LOT_STOCK');

    return created.map((c, idx) => ({
      id: c.id, seq: c.seq, productId: c.productId, warehouseId: c.warehouseId, lotId: c.lotId,
      quantity: D(c.quantity.toString()), unitCost: D(c.unitCost.toString()), totalCost: D(c.totalCost.toString()),
      avgCostAfter: D(c.avgCostAfter.toString()), docLineId: c.docLineId, kind: rows[idx].req.kind,
      systemQty: rows[idx].systemQty, ref: rows[idx].req.ref,
    }));
  }

  /** Reversa TODOS los movimientos aún no reversados de un documento (anulación). Nunca borra: inserta contramovimientos. */
  async reverse(docType: string, docId: string, mode: 'STANDARD' | 'TRANSFER' = 'STANDARD') {
    const tx = this.prisma.tx;
    const originals = await tx.inventoryMovement.findMany({
      where: { docType, docId, reversalOf: null }, orderBy: { seq: 'asc' },
    });
    if (!originals.length) return [];
    const done = new Set((await tx.inventoryMovement.findMany({ where: { docType, docId, reversalOf: { not: null } }, select: { reversalOf: true } })).map(x => x.reversalOf!));
    const pending = originals.filter(o => !done.has(o.id));
    // Orden inverso: deshace en sentido contrario al original.
    const moves: MoveRequest[] = [];
    for (const o of pending.reverse()) {
      const q = D(o.quantity.toString());
      if (q.isZero()) {
        if (!D(o.totalCost.toString()).isZero()) throw new BusinessRuleException('Un ajuste de costo no se puede anular', 'COST_ADJUSTMENT_NOT_REVERSIBLE');
        continue;
      }
      const base = { productId: o.productId, warehouseId: o.warehouseId, lotId: o.lotId, docLineId: o.docLineId, reversalOf: o.id, quantity: q.abs().toFixed(QTY_DP), unitCost: o.unitCost.toString() };
      if (mode === 'TRANSFER') moves.push({ ...base, kind: q.gt(0) ? 'TRANSFER_OUT' : 'TRANSFER_IN' });
      else moves.push({ ...base, kind: q.gt(0) ? 'RETURN_OUT' : 'ENTRY' });
    }
    return this.post({ docType, docId, moves });
  }

  /** Costo unitario de los movimientos de entrada de líneas de documento (para devoluciones al costo original). */
  async originalCosts(docLineIds: string[]): Promise<Map<string, Decimal>> {
    if (!docLineIds.length) return new Map();
    const rows = await this.prisma.tx.inventoryMovement.findMany({
      where: { docLineId: { in: docLineIds }, quantity: { gt: 0 }, reversalOf: null },
      orderBy: { seq: 'asc' },
    });
    const map = new Map<string, Decimal>();
    for (const r of rows) if (r.docLineId && !map.has(r.docLineId)) map.set(r.docLineId, D(r.unitCost.toString()));
    return map;
  }

  // ───────── lotes ─────────
  private async resolveLot(tx: Tx, companyId: string, product: { id: string; sku: string; hasExpiry: boolean }, m: MoveRequest, create: boolean, mustExist = false): Promise<string> {
    if (m.lotId) return m.lotId;
    if (!m.lotNo) throw new BusinessRuleException(`El producto ${product.sku} se controla por lotes: indique el lote`, 'LOT_REQUIRED');
    const found = await tx.lot.findUnique({ where: { companyId_productId_lotNo: { companyId, productId: product.id, lotNo: m.lotNo } } });
    if (found) return found.id;
    if (!create && !mustExist) {
      // traslado: el lote debe existir (viene del origen)
      throw new BusinessRuleException(`Lote ${m.lotNo} inexistente`, 'LOT_NOT_FOUND');
    }
    if (mustExist) throw new BusinessRuleException(`Lote ${m.lotNo} inexistente`, 'LOT_NOT_FOUND');
    if (product.hasExpiry && !m.expiryDate) throw new BusinessRuleException(`El producto ${product.sku} requiere fecha de vencimiento del lote`, 'EXPIRY_REQUIRED');
    const lot = await tx.lot.create({ data: { companyId, productId: product.id, lotNo: m.lotNo, expiryDate: m.expiryDate ? new Date(m.expiryDate) : null } });
    return lot.id;
  }

  /** Reparte una salida entre lotes: lote indicado o FEFO (primero en vencer, luego el más antiguo). */
  private async allocateLots(tx: Tx, companyId: string, product: { id: string; sku: string }, m: MoveRequest, qty: Decimal, fail: (c: string, msg: string) => Error) {
    if (m.lotId || m.lotNo) {
      const lotId = await this.resolveLot(tx, companyId, product as any, m, false, true);
      const bal = await tx.inventoryLotBalance.findFirst({ where: { productId: product.id, warehouseId: m.warehouseId, lotId } });
      if (D(bal?.quantity.toString() ?? 0).lt(qty)) throw fail('INSUFFICIENT_LOT_STOCK', `Stock insuficiente en el lote para ${product.sku}`);
      return [{ lotId, qty }];
    }
    const balances = await tx.$queryRaw<{ lot_id: string; quantity: Prisma.Decimal }[]>`
      SELECT b.lot_id, b.quantity FROM inventory_lot_balances b JOIN lots l ON l.id = b.lot_id
      WHERE b.company_id = ${companyId}::uuid AND b.product_id = ${product.id}::uuid AND b.warehouse_id = ${m.warehouseId}::uuid AND b.quantity > 0
      ORDER BY l.expiry_date ASC NULLS LAST, l.created_at ASC, b.lot_id FOR UPDATE OF b`;
    const out: { lotId: string | null; qty: Decimal }[] = [];
    let remaining = qty;
    for (const b of balances) {
      if (remaining.lte(0)) break;
      const take = Decimal.min(remaining, D(b.quantity.toString()));
      out.push({ lotId: b.lot_id, qty: take });
      remaining = remaining.minus(take);
    }
    if (remaining.gt(0)) throw fail('INSUFFICIENT_LOT_STOCK', `Stock por lotes insuficiente para ${product.sku}`);
    return out;
  }

  private async assertPeriodOpen(tx: Tx, companyId: string) {
    const now = new Date();
    const closed = await tx.inventoryPeriod.findFirst({ where: { companyId, year: now.getFullYear(), month: now.getMonth() + 1, status: 'CLOSED' } });
    if (closed) throw new BusinessRuleException('El período de inventario está cerrado', 'PERIOD_CLOSED');
  }
}
