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
});
