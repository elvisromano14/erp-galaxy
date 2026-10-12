import { randomUUID } from 'node:crypto';
import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, PASSWORD, auth } from './helpers';

/** App móvil: dispositivos, lectura incremental (pull) y envío idempotente (push). */
describe('Móvil: dispositivos, sync/pull y sync/push', () => {
  let ctx: Ctx; let admin: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let tenant: Awaited<ReturnType<typeof createTenant>>;
  let vendorToken: string; let deviceId: string; let sellerId: string; let priceListId: string; let ownCustomer: string; let p1: string; let p2: string;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  const hdr = (token: string, dev?: string, version = '1.0.0') => ({ ...auth(token), ...(dev ? { 'x-device-id': dev } : {}), 'x-app-version': version });
  const pull = (entity: string, q: Record<string, string | number> = {}, token = vendorToken, dev = deviceId) =>
    ctx.http.get('/api/v1/sync/pull').set(hdr(token, dev)).query({ entity, ...q });
  const push = (operations: object[], token = vendorToken, dev = deviceId) => ctx.http.post('/api/v1/sync/push').set(hdr(token, dev)).send({ operations });
  let seq = 0;
  const op = (entity: string, action: string, data: object, entityId = randomUUID(), clientOpId = randomUUID()) => ({ clientOpId, clientSeq: ++seq, entity, action, entityId, data });

  beforeAll(async () => {
    ctx = await bootstrap();
    tenant = await createTenant(ctx, 'Movil'); admin = client(ctx, tenant.token); b = await seedBasics(admin);
    await admin.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today() });
    priceListId = (await admin.post('/price-lists', { code: 'MAY', name: 'Mayorista', currencyId: b.usd, isDefault: true })).body.data.id;
    const mk = async (sku: string, price: string) => {
      const p = await b.product(sku, { barcodes: [`750${sku.replace(/\D/g, '')}`] });
      const d = await admin.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '10', unitCost: '5' }] });
      await admin.post(`/inventory/charges/${d.body.data.id}/confirm`);
      await admin.post(`/products/${p}/prices`, { priceListId, price });
      return p;
    };
    p1 = await mk('M-001', '20'); p2 = await mk('M-002', '10');
    // vendedor con su usuario
    const u = await admin.post('/users', { email: `vend-${Date.now()}@test.local`, fullName: 'Vendedor Móvil', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    expect(u.status).toBe(201);
    const s = await admin.post('/sellers', { code: 'V01', name: 'Vendedor Móvil', userId: u.body.data.id, maxDiscountPct: '10', allowCustomerCreate: true });
    expect(s.status).toBe(201); sellerId = s.body.data.id;
    ownCustomer = (await admin.post('/customers', { rif: uniqueRif('J'), legalName: 'Cliente Propio', sellerId, creditDays: 15 })).body.data.id;
    await admin.post('/customers', { rif: uniqueRif('J'), legalName: 'Cliente de otro vendedor' });
    const login = await ctx.http.post('/api/v1/auth/login').send({ email: u.body.data.email, password: PASSWORD });
    vendorToken = login.body.data.accessToken;
  });
  afterAll(async () => { await ctx.close(); });

  it('app/config es público y la versión mínima se exige con 426', async () => {
    const cfg = await ctx.http.get('/api/v1/app/config');
    expect(cfg.status).toBe(200); expect(cfg.body.data).toMatchObject({ minAppVersion: expect.any(String), schemaVersion: expect.any(Number) });
    const old = await ctx.http.get('/api/v1/sync/pull').set(hdr(vendorToken, undefined, '0.0.1')).query({ entity: 'taxes' });
    expect(old.status).toBe(426); expect(old.body.error).toBe('UPGRADE_REQUIRED');
  });

  it('registro de dispositivo: idempotente por deviceKey, un dispositivo activo por usuario y revocación', async () => {
    const key = `key-${randomUUID()}`;
    const reg = await ctx.http.post('/api/v1/devices/register').set(auth(vendorToken)).send({ deviceKey: key, name: 'Samsung A14', appVersion: '1.0.0' });
    expect(reg.status).toBe(201); expect(reg.body.data).toMatchObject({ deviceCode: 'D01', name: 'Samsung A14' });
    deviceId = reg.body.data.id;
    const again = await ctx.http.post('/api/v1/devices/register').set(auth(vendorToken)).send({ deviceKey: key, name: 'Samsung A14 (renombrado)' });
    expect(again.body.data.id).toBe(deviceId);
    const second = await ctx.http.post('/api/v1/devices/register').set(auth(vendorToken)).send({ deviceKey: `key-${randomUUID()}`, name: 'Otro teléfono' });
    expect(second.status).toBe(409); expect(second.body.error).toBe('DEVICE_LIMIT_REACHED');
    // sin cabecera de dispositivo no se sincroniza
    expect((await ctx.http.get('/api/v1/sync/pull').set(auth(vendorToken)).query({ entity: 'taxes' })).body.error).toBe('DEVICE_REQUIRED');
    // el administrador lista y revoca; la app queda bloqueada y puede restaurarse
    const list = (await admin.get('/devices')).body.data;
    expect(list.find((d: any) => d.id === deviceId)).toMatchObject({ deviceCode: 'D01', user: { fullName: 'Vendedor Móvil' } });
    expect((await admin.post(`/devices/${deviceId}/revoke`)).status).toBe(201);
    const blocked = await pull('taxes');
    expect(blocked.status).toBe(403); expect(blocked.body.error).toBe('DEVICE_REVOKED');
    expect((await admin.post(`/devices/${deviceId}/restore`)).status).toBe(201);
    expect((await pull('taxes')).status).toBe(200);
  });

  it('pull: ajustes del vendedor, catálogos, clientes solo propios, productos con códigos y precios', async () => {
    const set = (await pull('app_settings')).body.data.items[0];
    expect(set).toMatchObject({ sellerScope: 'OWN', allowCustomerCreate: true, allowPriceEdit: false, pricePolicy: 'SERVER_LIST' });
    expect(Number(set.maxDiscountPct)).toBe(10); expect(set.seller.code).toBe('V01');
    expect((await pull('taxes')).body.data.items.map((t: any) => t.code)).toContain('IVA_GENERAL');
    const customers = (await pull('customers')).body.data.items;
    expect(customers.map((c: any) => c.legalName)).toEqual(['Cliente Propio']); // el de otro vendedor no baja
    expect(customers[0]).toMatchObject({ validationStatus: 'VALIDATED', balanceSnapshot: '0' });
    const prods = (await pull('products')).body.data.items;
    expect(prods.map((p: any) => p.sku).sort()).toEqual(['M-001', 'M-002']);
    expect(prods.find((p: any) => p.sku === 'M-001').barcodes).toEqual(['750001']);
    const prices = (await pull('product_prices')).body.data.items;
    expect(prices.map((p: any) => Number(p.price)).sort()).toEqual([10, 20]);
    const stock = (await pull('stock_snapshots')).body.data.items;
    expect(stock.every((s: any) => Number(s.quantity) === 10)).toBe(true);
    // monedas (para mostrar precios)
    expect((await pull('currencies')).body.data.items.map((c: any) => c.code)).toEqual(expect.arrayContaining(['USD', 'VES']));
    // existencia en vivo: por depósito y SIN costos
    const live = await ctx.http.get(`/api/v1/sync/stock/${p1}`).set(hdr(vendorToken, deviceId));
    expect(live.status).toBe(200);
    expect(live.body.data.warehouses[0]).toMatchObject({ code: expect.any(String), quantity: '10', reserved: '0', available: '10' });
    expect(JSON.stringify(live.body)).not.toMatch(/cost/i);
    expect((await ctx.http.get(`/api/v1/sync/stock/${randomUUID()}`).set(hdr(vendorToken, deviceId))).status).toBe(404);
    expect((await ctx.http.get(`/api/v1/sync/stock/${p1}`).set(auth(vendorToken))).body.error).toBe('DEVICE_REQUIRED');
  });

  it('pull incremental: paginación por cursor, cambios posteriores y lápidas', async () => {
    for (let i = 0; i < 4; i++) await admin.post('/customers', { rif: uniqueRif('V'), legalName: `Paginado ${i}`, sellerId });
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = (await pull('customers', { limit: 2, ...(cursor ? { cursor } : {}) })).body.data;
      seen.push(...r.items.map((c: any) => c.legalName)); cursor = r.hasMore ? r.nextCursor : undefined; pages++;
      if (!r.hasMore) var last = r.nextCursor as string;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(5); expect(new Set(seen).size).toBe(5); expect(pages).toBeGreaterThanOrEqual(3);
    // sin cambios: nada nuevo
    expect((await pull('customers', { cursor: last! })).body.data.items).toHaveLength(0);
    // un cambio posterior aparece una sola vez
    await admin.patch(`/customers/${ownCustomer}`, { phone: '0414-5551234', version: (await admin.get(`/customers/${ownCustomer}`)).body.data.version });
    const delta = (await pull('customers', { cursor: last! })).body.data.items;
    expect(delta.map((c: any) => c.id)).toEqual([ownCustomer]); expect(delta[0].phone).toBe('0414-5551234');
    // baja lógica: llega como lápida (deletedAt)
    await admin.del(`/customers/${ownCustomer}`);
    const tomb = (await pull('customers', { cursor: last! })).body.data.items.find((c: any) => c.id === ownCustomer);
    expect(tomb.deletedAt).not.toBeNull();
    // la ventana de solape relee filas recientes
    expect((await pull('customers', { cursor: last!, overlapSeconds: 600 })).body.data.items.length).toBeGreaterThan(0);
  });

  it('push de clientes: queda pendiente de validación, es idempotente y vincula por RIF existente', async () => {
    const rif = uniqueRif('V'); const localId = randomUUID(); const opId = randomUUID();
    const r1 = await push([op('customer', 'create', { rif, legalName: 'Taller El Sol', phone: '0412-0000000' }, localId, opId)]);
    expect(r1.status).toBe(201);
    expect(r1.body.data.results[0]).toMatchObject({ clientOpId: opId, status: 'APPLIED', serverStatus: 'PENDING' });
    const serverId = r1.body.data.results[0].serverId;
    // reenviar la misma operación no duplica
    const r2 = await push([{ ...op('customer', 'create', { rif, legalName: 'Taller El Sol' }, localId, opId), clientSeq: 1 }]);
    expect(r2.body.data.results[0]).toMatchObject({ status: 'DUPLICATE', serverId });
    // mismo RIF desde otra operación: se vincula al existente
    const r3 = await push([op('customer', 'create', { rif, legalName: 'Taller El Sol (otra vez)' })]);
    expect(r3.body.data.results[0]).toMatchObject({ status: 'APPLIED', serverId, linked: true });
    expect(await admin.get(`/customers?search=${encodeURIComponent('Taller El Sol')}`).then(r => r.body.data.length)).toBe(1);
    // RIF inválido → rechazo con código
    const bad = await push([op('customer', 'create', { rif: 'V-12345678-0', legalName: 'RIF malo' })]);
    expect(bad.body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'INVALID_RIF' });
    // no se puede facturar a un cliente pendiente de validación hasta que administración lo valida
    const inv = await admin.post('/sales/invoices', { customerId: serverId, warehouseId: b.w1, currencyId: b.ves, paymentCondition: 'CREDIT', creditDays: 5, lines: [{ productId: p1, quantity: '1', unitPrice: '100' }] });
    expect(inv.status).toBe(422); expect(inv.body.error).toBe('CUSTOMER_PENDING_VALIDATION');
    expect((await admin.patch(`/customers/${serverId}`, { validationStatus: 'VALIDATED', version: (await admin.get(`/customers/${serverId}`)).body.data.version })).status).toBe(200);
    expect((await admin.post('/sales/invoices', { customerId: serverId, warehouseId: b.w1, currencyId: b.ves, paymentCondition: 'CREDIT', creditDays: 5, lines: [{ productId: p1, quantity: '1', unitPrice: '100' }] })).status).toBe(201);
  });

  it('push de cotizaciones y pedidos: cliente creado sin conexión, políticas, conversión y revisión por crédito', async () => {
    // 1) cliente nuevo + cotización que lo referencia por su id local, en el mismo lote
    const localCustomer = randomUUID(); const localQuote = randomUUID();
    const batch = await push([
      op('customer', 'create', { rif: uniqueRif('J'), legalName: 'Cliente Offline' }, localCustomer),
      op('sales_quote', 'create', { customerId: localCustomer, send: true, lines: [{ productId: p1, quantity: '2', discountPct: '5' }, { productId: p2, quantity: '3' }] }, localQuote),
    ]);
    const [c, q] = batch.body.data.results;
    expect(c.status).toBe('APPLIED');
    expect(q).toMatchObject({ status: 'APPLIED', serverStatus: 'SENT', serverNumber: expect.stringMatching(/^COT-V-\d{6}$/) });
    // el servidor fija el precio (lista MAY): 2×20 −5 % = 38; 3×10 = 30; IVA 16 % → 78,88
    const quote = (await admin.get(`/sales/quotes/${q.serverId}`)).body.data;
    expect(Number(quote.subtotal)).toBe(68); expect(Number(quote.total)).toBeCloseTo(78.88, 2); expect(quote.sellerId).toBe(sellerId);
    // 2) descuento mayor al permitido → rechazo; precio enviado sin permiso → se ignora
    const disc = await push([op('sales_quote', 'create', { customerId: c.serverId, lines: [{ productId: p1, quantity: '1', discountPct: '15' }] })]);
    expect(disc.body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'DISCOUNT_NOT_ALLOWED' });
    const cheat = await push([op('sales_quote', 'create', { customerId: c.serverId, lines: [{ productId: p1, quantity: '1', unitPrice: '1' }] })]);
    expect(Number((await admin.get(`/sales/quotes/${cheat.body.data.results[0].serverId}`)).body.data.subtotal)).toBe(20);
    // 3) pedido desde la cotización (acepta, convierte y confirma con reserva)
    const order = await push([op('sales_order', 'create', { customerId: c.serverId, sourceQuoteId: localQuote, lines: [{ productId: p1, quantity: '2', discountPct: '5' }, { productId: p2, quantity: '3' }] })]);
    expect(order.body.data.results[0]).toMatchObject({ status: 'APPLIED', serverStatus: 'CONFIRMED', serverNumber: expect.stringMatching(/^PED-\d{6}$/) });
    expect((await admin.get(`/sales/quotes/${q.serverId}`)).body.data.status).toBe('ACCEPTED');
    // 4) pedido sin cotización que excede el límite de crédito → queda en borrador y en revisión
    await admin.patch(`/customers/${c.serverId}`, { creditLimit: '10', validationStatus: 'VALIDATED', version: (await admin.get(`/customers/${c.serverId}`)).body.data.version });
    const over = await push([op('sales_order', 'create', { customerId: c.serverId, paymentCondition: 'CREDIT', creditDays: 15, lines: [{ productId: p1, quantity: '5' }] })]);
    expect(over.body.data.results[0]).toMatchObject({ status: 'NEEDS_REVIEW', errorCode: 'CREDIT_LIMIT_EXCEEDED', serverStatus: 'DRAFT' });
    // 5) un lote parcial: la operación mala no frena a la buena, y las dependientes de una rechazada quedan bloqueadas
    const lostCustomer = randomUUID();
    const mixed = await push([
      op('customer', 'create', { rif: 'V-00000000-0', legalName: 'Inválido' }, lostCustomer),
      op('sales_quote', 'create', { customerId: lostCustomer, lines: [{ productId: p1, quantity: '1' }] }),
      op('sales_quote', 'create', { customerId: c.serverId, lines: [{ productId: p2, quantity: '1' }] }),
    ]);
    expect(mixed.body.data.results.map((r: any) => r.status)).toEqual(['REJECTED', 'BLOCKED', 'APPLIED']);
    // 6) mis documentos: los ve el vendedor con su estado
    const docs = (await pull('my_documents')).body.data.items;
    expect(docs.find((d: any) => d.id === q.serverId)).toMatchObject({ docType: 'QUOTE', status: 'ACCEPTED', number: q.serverNumber });
    expect(docs.find((d: any) => d.id === q.serverId).lines).toHaveLength(2);
    expect(docs.find((d: any) => d.id === order.body.data.results[0].serverId)).toMatchObject({ docType: 'ORDER', status: 'CONFIRMED' });
  });

  it('seguridad: otro usuario no puede usar un dispositivo ajeno ni operar sin permiso móvil', async () => {
    const other = await admin.post('/users', { email: `compras-${Date.now()}@test.local`, fullName: 'Sin móvil', password: PASSWORD, roleCodes: ['ALMACENISTA'] });
    const tk = (await ctx.http.post('/api/v1/auth/login').send({ email: other.body.data.email, password: PASSWORD })).body.data.accessToken;
    expect((await ctx.http.get('/api/v1/sync/pull').set(hdr(tk, deviceId)).query({ entity: 'taxes' })).status).toBe(403); // sin permiso mobile:sync:use
    expect((await ctx.http.get('/api/v1/devices').set(auth(vendorToken))).status).toBe(403); // el vendedor no lista dispositivos
    const adminToken = tenant.token;
    expect((await ctx.http.get('/api/v1/sync/pull').set(hdr(adminToken, deviceId)).query({ entity: 'taxes' })).body.error).toBe('DEVICE_UNKNOWN'); // dispositivo de otro usuario
  });
});
