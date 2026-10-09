import { bootstrap, Ctx, createTenant, client, Api, seedBasics } from './helpers';

describe('Inventario: costeo, kardex, anulación y concurrencia', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let t: Awaited<ReturnType<typeof createTenant>>;
  beforeAll(async () => {
    ctx = await bootstrap();
    t = await createTenant(ctx, 'Inv'); api = client(ctx, t.token); b = await seedBasics(api);
  });
  afterAll(async () => { await ctx.close(); });

  const charge = async (productId: string, qty: number, cost: number, warehouseId = b.w1) => {
    const d = await api.post('/inventory/charges', { warehouseId, lines: [{ productId, quantity: String(qty), unitCost: String(cost) }] });
    expect(d.status).toBe(201);
    const c = await api.post(`/inventory/charges/${d.body.data.id}/confirm`);
    expect(c.status).toBe(201);
    return c.body.data;
  };
  const discharge = async (productId: string, qty: number, warehouseId = b.w1) => {
    const d = await api.post('/inventory/discharges', { warehouseId, lines: [{ productId, quantity: String(qty) }] });
    return api.post(`/inventory/discharges/${d.body.data.id}/confirm`);
  };
  const stock = async (productId: string) => (await api.get(`/products/${productId}/stock`)).body.data;

  it('promedio ponderado: compras 10@5 y 10@7 → 6; la salida no cambia el costo', async () => {
    const p = await b.product('COST-1');
    await charge(p, 10, 5); await charge(p, 10, 7);
    let s = await stock(p);
    expect(s.totalQuantity).toBe('20'); expect(s.avgCost).toBe('6');
    const out = await discharge(p, 5);
    expect(out.status).toBe(201);
    s = await stock(p);
    expect(s.totalQuantity).toBe('15'); expect(s.avgCost).toBe('6');
    const k = (await api.get(`/products/${p}/kardex`)).body.data;
    expect(k).toHaveLength(3);
    expect(k[0]).toMatchObject({ quantity: '-5', unitCost: '6', totalCost: '-30', qtyAfter: '15', avgCostAfter: '6' });
    expect(k[0].docType).toBe('DISCHARGE');
  });

  it('numeración correlativa asignada al confirmar (no en borrador)', async () => {
    const p = await b.product('NUM-1');
    const d = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '1', unitCost: '1' }] });
    expect(d.body.data.number).toBeNull();
    const c = await api.post(`/inventory/charges/${d.body.data.id}/confirm`);
    expect(c.body.data.number).toMatch(/^CAR-\d{6}$/);
    expect(c.body.data.status).toBe('CONFIRMED');
    // no se puede confirmar dos veces ni editar un confirmado
    expect((await api.post(`/inventory/charges/${d.body.data.id}/confirm`)).status).toBe(422);
    expect((await api.patch(`/inventory/charges/${d.body.data.id}`, { notes: 'x' })).status).toBe(422);
    expect((await api.del(`/inventory/charges/${d.body.data.id}`)).status).toBe(422);
  });

  it('stock insuficiente → 422 y la transacción no deja efectos parciales', async () => {
    const p1 = await b.product('INS-1'); const p2 = await b.product('INS-2');
    await charge(p1, 10, 2); await charge(p2, 1, 2);
    const d = await api.post('/inventory/discharges', { warehouseId: b.w1, lines: [{ productId: p1, quantity: '4' }, { productId: p2, quantity: '5' }] });
    const r = await api.post(`/inventory/discharges/${d.body.data.id}/confirm`);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('INSUFFICIENT_STOCK');
    expect((await stock(p1)).totalQuantity).toBe('10'); // la línea 1 NO se descontó
    const doc = await api.get(`/inventory/discharges/${d.body.data.id}`);
    expect(doc.body.data.status).toBe('DRAFT'); expect(doc.body.data.number).toBeNull();
  });

  it('traslado atómico entre depósitos, sin cambiar el costo; la anulación lo revierte', async () => {
    const p = await b.product('TR-1');
    await charge(p, 10, 4);
    const tr = await api.post('/inventory/transfers', { warehouseId: b.w1, toWarehouseId: b.w2, lines: [{ productId: p, quantity: '6' }] });
    const c = await api.post(`/inventory/transfers/${tr.body.data.id}/confirm`);
    expect(c.status).toBe(201);
    let s = await stock(p);
    const q = (w: string) => s.warehouses.find((x: any) => x.warehouseId === w).quantity;
    expect(q(b.w1)).toBe('4'); expect(q(b.w2)).toBe('6'); expect(s.totalQuantity).toBe('10'); expect(s.avgCost).toBe('4');
    expect((await api.post('/inventory/transfers', { warehouseId: b.w1, toWarehouseId: b.w1, lines: [{ productId: p, quantity: '1' }] })).status).toBe(422);
    expect((await api.post(`/inventory/transfers/${tr.body.data.id}/cancel`, { reason: 'ab' })).status).toBe(400); // motivo obligatorio
    const cx = await api.post(`/inventory/transfers/${tr.body.data.id}/cancel`, { reason: 'Error de digitación' });
    expect(cx.status).toBe(201); expect(cx.body.data.status).toBe('CANCELLED');
    s = await stock(p);
    expect(q(b.w1)).toBe('10'); expect(q(b.w2)).toBe('0');
    // cancelar dos veces no revierte dos veces
    expect((await api.post(`/inventory/transfers/${tr.body.data.id}/cancel`, { reason: 'otra vez' })).status).toBe(422);
  });

  it('anular un cargo confirmado genera contramovimientos y deja el kardex intacto', async () => {
    const p = await b.product('CX-1');
    await charge(p, 10, 5);
    const doc = await charge(p, 10, 7);
    expect((await stock(p)).avgCost).toBe('6');
    await api.post(`/inventory/charges/${doc.id}/cancel`, { reason: 'Cargo duplicado' });
    const s = await stock(p);
    expect(s.totalQuantity).toBe('10'); expect(s.avgCost).toBe('5'); // el promedio vuelve al costo previo
    const k = (await api.get(`/products/${p}/kardex`)).body.data;
    expect(k).toHaveLength(3); // 2 cargos + 1 reverso: nada se borró
    expect(k[0].reversalOf).not.toBeNull();
  });

  it('el kardex es de solo inserción: UPDATE y DELETE fallan (trigger y permisos)', async () => {
    await expect(ctx.prisma.$executeRaw`UPDATE inventory_movements SET quantity = 0`).rejects.toThrow();
    await expect(ctx.prisma.$executeRaw`DELETE FROM inventory_movements`).rejects.toThrow();
    await expect(ctx.prisma.$executeRaw`UPDATE audit_logs SET action = 'x'`).rejects.toThrow();
  });

  it('ajuste de inventario físico: calcula diferencia contra el sistema al confirmar', async () => {
    const p = await b.product('ADJ-1');
    await charge(p, 10, 3);
    const d = await api.post('/inventory/adjustments', { warehouseId: b.w1, lines: [{ productId: p, countedQty: '12' }] });
    const sheet = await api.get(`/inventory/adjustments/${d.body.data.id}/count-sheet`);
    expect(sheet.body.data.lines[0]).toMatchObject({ sku: 'ADJ-1', systemQty: '10' });
    const c = await api.post(`/inventory/adjustments/${d.body.data.id}/confirm`);
    expect(c.body.data.lines[0]).toMatchObject({ systemQty: '10', difference: '2' });
    let s = await stock(p);
    expect(s.totalQuantity).toBe('12'); expect(s.avgCost).toBe('3');
    const d2 = await api.post('/inventory/adjustments', { warehouseId: b.w1, lines: [{ productId: p, countedQty: '9' }] });
    await api.post(`/inventory/adjustments/${d2.body.data.id}/confirm`);
    s = await stock(p);
    expect(s.totalQuantity).toBe('9');
  });

  it('ajuste de costo: corrige el promedio con un movimiento de valor y no es anulable', async () => {
    const p = await b.product('CA-1');
    await charge(p, 10, 5);
    const d = await api.post('/inventory/cost-adjustments', { warehouseId: b.w1, lines: [{ productId: p, newAvgCost: '8' }] });
    const c = await api.post(`/inventory/cost-adjustments/${d.body.data.id}/confirm`);
    expect(c.status).toBe(201);
    expect((await stock(p)).avgCost).toBe('8');
    const k = (await api.get(`/products/${p}/kardex`)).body.data[0];
    expect(k).toMatchObject({ quantity: '0', totalCost: '30', avgCostAfter: '8' });
    expect((await api.post(`/inventory/cost-adjustments/${d.body.data.id}/cancel`, { reason: 'probando' })).status).toBe(422);
  });

  it('stock negativo solo en depósitos que lo permiten; el costo se mantiene', async () => {
    const neg = (await api.post('/warehouses', { code: 'NEG', name: 'Permite negativo', allowNegativeStock: true })).body.data.id;
    const p = await b.product('NEG-1');
    await charge(p, 1, 5, neg);
    expect((await discharge(p, 3, neg)).status).toBe(201);
    let s = await stock(p);
    expect(s.totalQuantity).toBe('-2'); expect(s.avgCost).toBe('5');
    await charge(p, 10, 8, neg);
    s = await stock(p);
    expect(s.avgCost).toBe('8'); // se reinicia con la entrada porque Q ≤ 0
  });

  it('CONCURRENCIA: dos descargos simultáneos de la última unidad → uno solo se confirma', async () => {
    const p = await b.product('RACE-1');
    await charge(p, 1, 10);
    const drafts = await Promise.all([1, 2].map(() => api.post('/inventory/discharges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '1' }] })));
    const res = await Promise.all(drafts.map(d => api.post(`/inventory/discharges/${d.body.data.id}/confirm`)));
    const codes = res.map(r => r.status).sort();
    expect(codes).toEqual([201, 422]);
    expect((await stock(p)).totalQuantity).toBe('0'); // jamás -1
  });

  it('CONCURRENCIA: 12 confirmaciones simultáneas → numeración sin huecos ni duplicados y kardex consistente', async () => {
    const p = await b.product('RACE-2');
    await charge(p, 100, 10);
    const drafts = await Promise.all(Array.from({ length: 12 }, () => api.post('/inventory/discharges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '2' }] })));
    const res = await Promise.all(drafts.map(d => api.post(`/inventory/discharges/${d.body.data.id}/confirm`)));
    expect(res.map(r => r.status)).toEqual(Array(12).fill(201));
    const numbers = res.map(r => Number(r.body.data.number.replace('DES-', ''))).sort((a, c) => a - c);
    expect(new Set(numbers).size).toBe(12);
    expect(numbers[11] - numbers[0]).toBe(11); // contiguos
    expect((await stock(p)).totalQuantity).toBe('76');
    // invariante: saldo = Σ kardex
    const [r] = await ctx.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${t.companyId}, true)`;
      return tx.$queryRaw<{ s: string }[]>`SELECT sum(quantity)::text AS s FROM inventory_movements WHERE product_id = ${p}::uuid`;
    });
    expect(Number(r.s)).toBe(76);
  });

  it('CONCURRENCIA entre depósitos: costo promedio consistente sin interbloqueos', async () => {
    const p = await b.product('RACE-3');
    await charge(p, 10, 4);
    const ops = [
      ...Array.from({ length: 5 }, () => async () => { const d = await api.post('/inventory/charges', { warehouseId: b.w2, lines: [{ productId: p, quantity: '2', unitCost: '8' }] }); return api.post(`/inventory/charges/${d.body.data.id}/confirm`); }),
      ...Array.from({ length: 5 }, () => async () => { const d = await api.post('/inventory/transfers', { warehouseId: b.w1, toWarehouseId: b.w2, lines: [{ productId: p, quantity: '1' }] }); return api.post(`/inventory/transfers/${d.body.data.id}/confirm`); }),
    ];
    const res = await Promise.all(ops.map(f => f()));
    expect(res.every(r => r.status === 201)).toBe(true);
    const s = await stock(p);
    expect(s.totalQuantity).toBe('20');
    // 10@4 + 10@8 (en cualquier orden) → 6
    expect(s.avgCost).toBe('6');
  });

  it('idempotencia: la misma Idempotency-Key no duplica el documento; otro cuerpo → 409', async () => {
    const p = await b.product('IDEM-1');
    const body = { warehouseId: b.w1, lines: [{ productId: p, quantity: '1', unitCost: '1' }] };
    const key = { 'Idempotency-Key': 'k-' + Date.now() };
    const r1 = await api.post('/inventory/charges', body, key);
    const r2 = await api.post('/inventory/charges', body, key);
    expect(r1.status).toBe(201); expect(r2.status).toBe(201);
    expect(r2.body.data.id).toBe(r1.body.data.id);
    const r3 = await api.post('/inventory/charges', { ...body, notes: 'distinto' }, key);
    expect(r3.status).toBe(409); expect(r3.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await api.get('/inventory/charges?limit=100')).body.data.filter((d: any) => d.id === r1.body.data.id)).toHaveLength(1);
  });

  it('valoración: actual y reconstruida desde el kardex (asOf) coinciden hoy', async () => {
    const p = await b.product('VAL-1');
    await charge(p, 10, 5);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    const now = (await api.get('/inventory/valuation')).body.data;
    const asof = (await api.get(`/inventory/valuation?asOf=${today}`)).body.data;
    expect(now.totalValue).toBe(asof.totalValue);
    const row = now.rows.find((r: any) => r.sku === 'VAL-1');
    expect(row).toMatchObject({ quantity: '10.0000', avgCost: '5.000000', value: '50.0000' });
    const yesterday = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    expect((await api.get(`/inventory/valuation?asOf=${yesterday}`)).body.data.rows.find((r: any) => r.sku === 'VAL-1')).toBeUndefined();
  });

  it('kardex con paginación por cursor', async () => {
    const p = await b.product('KDX-1');
    for (let i = 0; i < 5; i++) await charge(p, 1, 1);
    const page1 = (await api.get(`/products/${p}/kardex?limit=2`)).body;
    expect(page1.data).toHaveLength(2); expect(page1.meta.nextCursor).toBeTruthy();
    const page2 = (await api.get(`/products/${p}/kardex?limit=2&cursor=${page1.meta.nextCursor}`)).body;
    expect(page2.data).toHaveLength(2);
    expect(BigInt(page2.data[0].seq) < BigInt(page1.data[1].seq)).toBe(true);
  });

  it('períodos de inventario: solo meses terminados, en orden, con cierre y reapertura', async () => {
    const now = new Date();
    expect((await api.post('/inventory/periods/close', { year: now.getFullYear(), month: now.getMonth() + 1 })).status).toBe(422);
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const py = prev.getFullYear(), pm = prev.getMonth() + 1;
    const closed = await api.post('/inventory/periods/close', { year: py, month: pm });
    expect(closed.status).toBe(201); expect(closed.body.data.status).toBe('CLOSED');
    expect((await api.post('/inventory/periods/close', { year: py, month: pm })).status).toBe(422);
    expect((await api.post('/inventory/periods/reopen', { year: py, month: pm })).status).toBe(201);
  });

  it('lotes con vencimiento: la salida respeta FEFO (primero en vencer) y reparte entre lotes', async () => {
    const t2 = await createTenant(ctx, 'Lotes'); const a2 = client(ctx, t2.token);
    expect((await a2.patch('/companies/current', { features: { lots: true, expiry: true } })).status).toBe(200);
    const b2 = await seedBasics(a2);
    const p = await b2.product('LOT-1', { trackingMode: 'LOT', hasExpiry: true });
    const ch = (lotNo: string, expiryDate: string, qty: number) => a2.post('/inventory/charges', { warehouseId: b2.w1, lines: [{ productId: p, quantity: String(qty), unitCost: '2', lotNo, expiryDate }] });
    const noLot = await a2.post('/inventory/charges', { warehouseId: b2.w1, lines: [{ productId: p, quantity: '1', unitCost: '2' }] });
    expect(noLot.status).toBe(422); // requiere lote
    for (const [l, e, q] of [['A', '2027-01-10', 5], ['B', '2026-12-01', 5]] as const) {
      const d = await ch(l, e, q); expect((await a2.post(`/inventory/charges/${d.body.data.id}/confirm`)).status).toBe(201);
    }
    const out = await a2.post('/inventory/discharges', { warehouseId: b2.w1, lines: [{ productId: p, quantity: '6' }] });
    expect((await a2.post(`/inventory/discharges/${out.body.data.id}/confirm`)).status).toBe(201);
    const k = (await a2.get(`/products/${p}/kardex?docType=DISCHARGE`)).body.data;
    expect(k).toHaveLength(2); // repartido en 2 lotes
    const lots = await ctx.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${t2.companyId}, true)`;
      return tx.$queryRaw<{ lot_no: string; quantity: string }[]>`SELECT l.lot_no, b.quantity::text FROM inventory_lot_balances b JOIN lots l ON l.id = b.lot_id ORDER BY l.lot_no`;
    });
    expect(lots).toEqual([{ lot_no: 'A', quantity: '4.0000' }, { lot_no: 'B', quantity: '0.0000' }]);
    // el ajuste cancelación del descargo devuelve a los lotes originales
    const over = await a2.post('/inventory/discharges', { warehouseId: b2.w1, lines: [{ productId: p, quantity: '5' }] });
    expect((await a2.post(`/inventory/discharges/${over.body.data.id}/confirm`)).status).toBe(422);
    await a2.post(`/inventory/discharges/${out.body.data.id}/cancel`, { reason: 'Devuelto' });
    const back = await ctx.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${t2.companyId}, true)`;
      return tx.$queryRaw<{ lot_no: string; quantity: string }[]>`SELECT l.lot_no, b.quantity::text FROM inventory_lot_balances b JOIN lots l ON l.id = b.lot_id ORDER BY l.lot_no`;
    });
    expect(back).toEqual([{ lot_no: 'A', quantity: '5.0000' }, { lot_no: 'B', quantity: '5.0000' }]);
  });
});
