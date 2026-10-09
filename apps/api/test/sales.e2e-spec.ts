import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, PASSWORD } from './helpers';

describe('Ventas: cotización → presupuesto → pedido', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let customerId: string; let priceListId: string;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Ventas'); api = client(ctx, t.token); b = await seedBasics(api);
    customerId = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Uno', creditDays: 30 })).body.data.id;
    priceListId = (await api.post('/price-lists', { code: 'MAY', name: 'Mayorista', currencyId: b.usd, isDefault: true })).body.data.id;
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today() });
  });
  afterAll(async () => { await ctx.close(); });

  const withStock = async (sku: string, qty: number, price?: string) => {
    const p = await b.product(sku);
    const d = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: String(qty), unitCost: '5' }] });
    await api.post(`/inventory/charges/${d.body.data.id}/confirm`);
    if (price) expect((await api.post(`/products/${p}/prices`, { priceListId, price })).status).toBe(201);
    return p;
  };
  const reserved = async (p: string) => (await api.get(`/products/${p}/stock`)).body.data.warehouses.find((w: any) => w.warehouseId === b.w1)?.reservedQty ?? '0';
  const doc = (lines: object[], extra: object = {}) => ({ customerId, warehouseId: b.w1, currencyId: b.usd, lines, ...extra });

  it('toma el precio de la lista y calcula totales con IVA congelado', async () => {
    const p = await withStock('S-PRICE', 10, '20');
    const r = await api.post('/sales/quotes', doc([{ productId: p, quantity: '2', discountPct: '10' }]));
    expect(r.status).toBe(201);
    // 2 × 20 − 10 % = 36 · IVA 16 % = 5,76 · total 41,76 · Bs a tasa 40
    expect(r.body.data).toMatchObject({ status: 'DRAFT', number: null, subtotal: '36', taxTotal: '5.76', total: '41.76', exchangeRate: '40', priceListId });
    expect(r.body.data.totalBase).toBe('1670.4');
    expect(r.body.data.lines[0]).toMatchObject({ unitPrice: '20', taxRate: '16' });
    // sin precio en lista y sin precio manual → error claro; con precio manual pasa
    const q = await b.product('S-NOPRICE');
    const bad = await api.post('/sales/quotes', doc([{ productId: q, quantity: '1' }]));
    expect(bad.status).toBe(422); expect(bad.body.error).toBe('PRICE_NOT_FOUND');
    expect((await api.post('/sales/quotes', doc([{ productId: q, quantity: '1', unitPrice: '7.5' }]))).status).toBe(201);
  });

  it('flujo: cotización → presupuesto (reserva) → pedido; anular el pedido reabre el presupuesto', async () => {
    const p = await withStock('S-FLOW', 10, '10');
    const qid = (await api.post('/sales/quotes', doc([{ productId: p, quantity: '6' }], { validUntil: '2099-12-31' }))).body.data.id;
    expect((await api.post(`/sales/quotes/${qid}/convert-to-budget`)).status).toBe(422); // aún no aceptada
    const sent = await api.post(`/sales/quotes/${qid}/send`);
    expect(sent.body.data).toMatchObject({ status: 'SENT', number: expect.stringMatching(/^COT-V-\d{6}$/) });
    expect((await api.post(`/sales/quotes/${qid}/accept`)).body.data.status).toBe('ACCEPTED');
    const budget = (await api.post(`/sales/quotes/${qid}/convert-to-budget`, {})).body.data;
    expect(budget).toMatchObject({ docType: 'BUDGET', status: 'DRAFT' }); expect(budget.links.parents[0]).toEqual({ type: 'QUOTE', id: qid });
    expect((await api.post(`/sales/quotes/${qid}/convert-to-order`)).status).toBe(409); // ya tiene un derivado activo
    // reservar: activar el flag en el borrador
    expect((await api.patch(`/sales/budgets/${budget.id}`, { reservesStock: true })).body.data.reservesStock).toBe(true);
    const conf = await api.post(`/sales/budgets/${budget.id}/confirm`);
    expect(conf.body.data).toMatchObject({ status: 'CONFIRMED', stockReserved: true, number: expect.stringMatching(/^PRE-\d{6}$/) });
    expect(await reserved(p)).toBe('6');
    // otro presupuesto no puede reservar más de lo disponible (10 − 6 = 4)
    const b2 = (await api.post('/sales/budgets', doc([{ productId: p, quantity: '5' }], { reservesStock: true }))).body.data.id;
    const over = await api.post(`/sales/budgets/${b2}/confirm`);
    expect(over.status).toBe(422); expect(over.body.error).toBe('INSUFFICIENT_AVAILABLE_STOCK');
    expect(await reserved(p)).toBe('6');

    // presupuesto → pedido: libera la reserva del presupuesto; el pedido reserva al confirmarse
    const order = (await api.post(`/sales/budgets/${budget.id}/convert-to-order`)).body.data;
    expect(order).toMatchObject({ docType: 'ORDER', status: 'DRAFT', reservesStock: true });
    expect((await api.get(`/sales/budgets/${budget.id}`)).body.data.status).toBe('CONVERTED');
    expect(await reserved(p)).toBe('0');
    const oc = await api.post(`/sales/orders/${order.id}/confirm`);
    expect(oc.body.data).toMatchObject({ status: 'CONFIRMED', stockReserved: true, number: expect.stringMatching(/^PED-\d{6}$/) });
    expect(await reserved(p)).toBe('6');
    // un presupuesto convertido no se anula mientras el pedido viva
    expect((await api.post(`/sales/budgets/${budget.id}/cancel`, { reason: 'prueba' })).status).toBe(422);
    // anular el pedido libera la reserva y reabre el presupuesto
    const can = await api.post(`/sales/orders/${order.id}/cancel`, { reason: 'cliente desistió' });
    expect(can.body.data).toMatchObject({ status: 'CANCELLED', stockReserved: false });
    expect(await reserved(p)).toBe('0');
    expect((await api.get(`/sales/budgets/${budget.id}`)).body.data.status).toBe('CONFIRMED');
    // el stock físico nunca se tocó
    expect((await api.get(`/products/${p}/stock`)).body.data.totalQuantity).toBe('10');
  });

  it('cotización vencida no se acepta y los borradores se editan/eliminan', async () => {
    const p = await b.product('S-EXP');
    const q = (await api.post('/sales/quotes', doc([{ productId: p, quantity: '1', unitPrice: '3' }], { validUntil: '2020-01-01' }))).body.data;
    await api.post(`/sales/quotes/${q.id}/send`);
    const acc = await api.post(`/sales/quotes/${q.id}/accept`);
    expect(acc.status).toBe(422); expect(acc.body.error).toBe('QUOTE_EXPIRED');
    const d = (await api.post('/sales/orders', doc([{ productId: p, quantity: '1', unitPrice: '3' }]))).body.data;
    const up = await api.patch(`/sales/orders/${d.id}`, { lines: [{ productId: p, quantity: '4', unitPrice: '3' }] });
    expect(up.body.data).toMatchObject({ subtotal: '12', version: 2 });
    expect((await api.del(`/sales/orders/${d.id}`)).status).toBe(200);
    expect((await api.get(`/sales/orders/${d.id}`)).status).toBe(404);
  });

  it('reservar exige depósito y las cotizaciones no reservan', async () => {
    const p = await b.product('S-RSV');
    const noWh = await api.post('/sales/orders', { customerId, currencyId: b.usd, reservesStock: true, lines: [{ productId: p, quantity: '1', unitPrice: '1' }] });
    expect(noWh.status).toBe(422); expect(noWh.body.error).toBe('WAREHOUSE_REQUIRED');
    const q = await api.post('/sales/quotes', doc([{ productId: p, quantity: '1', unitPrice: '1' }], { reservesStock: true }));
    expect(q.status).toBe(422); expect(q.body.error).toBe('RESERVE_NOT_ALLOWED');
  });

  it('cada vendedor ve solo sus documentos; quien tiene read-all ve todos', async () => {
    const mk = async (name: string) => {
      const email = `${name}-${Math.random().toString(36).slice(2, 7)}@test.local`;
      const u = await api.post('/users', { email, fullName: name, password: PASSWORD, roleCodes: ['VENDEDOR'] });
      expect(u.status).toBe(201);
      const login = await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD });
      return client(ctx, login.body.data.accessToken);
    };
    const [v1, v2] = [await mk('vend1'), await mk('vend2')];
    const p = await b.product('S-VIS');
    const line = [{ productId: p, quantity: '1', unitPrice: '2' }];
    const d1 = (await v1.post('/sales/orders', doc(line))).body.data;
    const d2 = (await v2.post('/sales/orders', doc(line))).body.data;
    expect((await v1.get('/sales/orders')).body.data.map((x: any) => x.id)).toEqual([d1.id]);
    expect((await v1.get(`/sales/orders/${d2.id}`)).status).toBe(404);
    expect((await v1.post(`/sales/orders/${d2.id}/confirm`)).status).toBe(404);
    expect((await v2.get(`/sales/orders/${d2.id}`)).status).toBe(200);
    const all = (await api.get('/sales/orders?limit=100')).body.data.map((x: any) => x.id);
    expect(all).toEqual(expect.arrayContaining([d1.id, d2.id]));
    // el vendedor no puede ver ni crear documentos de compras
    expect((await v1.get('/purchases/orders')).status).toBe(403);
  });

  it('las reservas bloquean descargos que se comerían lo apartado', async () => {
    const p = await withStock('S-LOCK', 10, '10');
    const o = (await api.post('/sales/orders', doc([{ productId: p, quantity: '8' }], { reservesStock: true }))).body.data.id;
    await api.post(`/sales/orders/${o}/confirm`);
    const dis = async (q: string) => {
      const d = await api.post('/inventory/discharges', { warehouseId: b.w1, lines: [{ productId: p, quantity: q }] });
      return api.post(`/inventory/discharges/${d.body.data.id}/confirm`);
    };
    const bad = await dis('5'); // quedarían 5 < 8 reservados
    expect(bad.status).toBe(422); expect(bad.body.error).toBe('STOCK_RESERVED');
    expect((await dis('2')).status).toBe(201); // quedan 8 = reservado: permitido
    await api.post(`/sales/orders/${o}/cancel`, { reason: 'libera' });
    expect((await dis('8')).status).toBe(201);
  });

  it('límite de crédito: bloquea pedidos a crédito por encima del límite salvo autorización', async () => {
    const cid = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Limitado', creditLimit: '1000', creditDays: 15 })).body.data.id;
    const p = await b.product('S-CRED');
    // cada pedido: 10 × 20 USD × 1,16 = 232 USD = 9.280 Bs (tasa 40) → un pedido ya excede 1.000 Bs
    const mk = async (cust: string) => (await api.post('/sales/orders', { customerId: cust, currencyId: b.ves, paymentCondition: 'CREDIT', lines: [{ productId: p, quantity: '10', unitPrice: '60' }] })).body.data.id;
    const o1 = await mk(cid); // 600 + IVA = 696 Bs
    expect((await api.post(`/sales/orders/${o1}/confirm`)).status).toBe(201);
    const o2 = await mk(cid); // 696 + 696 = 1.392 > 1.000
    const ex = await api.post(`/sales/orders/${o2}/confirm`);
    expect(ex.status).toBe(422); expect(ex.body.error).toBe('CREDIT_LIMIT_EXCEEDED');
    expect((await api.post(`/sales/orders/${o2}/confirm`, { overrideCredit: true })).status).toBe(201); // admin tiene el permiso
    // un pedido de contado no se valida; un cliente sin límite (0) tampoco
    const cash = (await api.post('/sales/orders', { customerId: cid, currencyId: b.ves, lines: [{ productId: p, quantity: '50', unitPrice: '60' }] })).body.data.id;
    expect((await api.post(`/sales/orders/${cash}/confirm`)).status).toBe(201);
    // un vendedor sin el permiso no puede forzar
    const email = `v-${Math.random().toString(36).slice(2, 7)}@test.local`;
    await api.post('/users', { email, fullName: 'Vend', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    const tok = (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
    const v = client(ctx, tok);
    const o3 = (await v.post('/sales/orders', { customerId: cid, currencyId: b.ves, paymentCondition: 'CREDIT', lines: [{ productId: p, quantity: '10', unitPrice: '60' }] })).body.data.id;
    const forced = await v.post(`/sales/orders/${o3}/confirm`, { overrideCredit: true });
    expect(forced.status).toBe(422); expect(forced.body.error).toBe('CREDIT_LIMIT_EXCEEDED');
  });

  it('reportes de ventas: por cliente, por producto, reservas, efectividad y desempeño', async () => {
    const t2 = await createTenant(ctx, 'RepVentas'); const a2 = client(ctx, t2.token); const b2 = await seedBasics(a2);
    await a2.post('/exchange-rates', { currencyId: b2.usd, rate: '40', date: today() });
    const seller = (await a2.post('/sellers', { code: 'V1', name: 'Vendedor Uno', commissionRate: '5', monthlyGoal: '1000' })).body.data.id;
    const c1 = (await a2.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente A' })).body.data.id;
    const c2 = (await a2.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente B' })).body.data.id;
    const p = await b2.product('RS-1');
    const ch = await a2.post('/inventory/charges', { warehouseId: b2.w1, lines: [{ productId: p, quantity: '50', unitCost: '1' }] });
    await a2.post(`/inventory/charges/${ch.body.data.id}/confirm`);
    const order = async (cust: string, qty: string, extra: object = {}) => {
      const rr = await a2.post('/sales/orders', { customerId: cust, sellerId: seller, warehouseId: b2.w1, currencyId: b2.ves, lines: [{ productId: p, quantity: qty, unitPrice: '10' }], ...extra }); if (rr.status !== 201) throw new Error(JSON.stringify(rr.body)); const o = rr.body.data.id;
      expect((await a2.post(`/sales/orders/${o}/confirm`)).status).toBe(201);
    };
    await order(c1, '10', { reservesStock: true }); // 100 + IVA = 116
    await order(c1, '5');                           // 58
    await order(c2, '20');                          // 232
    const q = (await a2.post('/sales/quotes', { customerId: c1, sellerId: seller, currencyId: b2.ves, lines: [{ productId: p, quantity: '1', unitPrice: '10' }] })).body.data.id;
    await a2.post(`/sales/quotes/${q}/send`); await a2.post(`/sales/quotes/${q}/accept`); await a2.post(`/sales/quotes/${q}/convert-to-order`);

    const rows = (r: any) => r.body.data.rows as Record<string, any>[];
    const byC = await a2.get('/reports/sales/by-customer');
    expect(byC.status).toBe(200);
    const A = rows(byC).find(r => r.customer === 'Cliente A')!; const B = rows(byC).find(r => r.customer === 'Cliente B')!;
    expect(A.orders).toBe(2); expect(Number(A.total_base)).toBe(174); expect(Number(B.total_base)).toBe(232);
    const byP = rows(await a2.get('/reports/sales/by-product'));
    expect(byP).toHaveLength(1); expect(Number(byP[0].qty)).toBe(35); expect(Number(byP[0].net_base)).toBe(350);
    const rs = rows(await a2.get('/reports/sales/reserved-stock'));
    expect(rs).toHaveLength(1); expect(Number(rs[0].reserved)).toBe(10); expect(Number(rs[0].available)).toBe(40);
    const eff = rows(await a2.get('/reports/sales/quotes-conversion'))[0];
    expect(eff).toMatchObject({ quotes: 1, accepted: 1, converted: 1 }); expect(Number(eff.conversion_pct)).toBe(100);
    const perf = rows(await a2.get('/reports/sellers/performance')).find(r => r.code === 'V1')!;
    expect(perf.orders).toBe(3); expect(Number(perf.total_base)).toBe(406); expect(Number(perf.commission)).toBe(20.3); expect(Number(perf.goal_pct)).toBeCloseTo(40.6, 1);
    const docs = rows(await a2.get('/reports/sales/documents?docType=QUOTE'));
    expect(docs).toHaveLength(1); expect(docs[0].doc_type).toBe('Cotización');
    expect((await a2.get('/reports/sales/by-customer?format=xlsx')).status).toBe(200);
    // el vendedor (sin permiso de reportes de ventas) no accede
    const email = `r-${Math.random().toString(36).slice(2, 7)}@test.local`;
    await a2.post('/users', { email, fullName: 'Vendedor R', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    const tok = (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
    expect((await client(ctx, tok).get('/reports/sales/by-customer')).status).toBe(403);
  });
});
