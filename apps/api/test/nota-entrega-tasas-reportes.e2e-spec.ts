import { bootstrap, Ctx, createTenant, client, Api, auth, seedBasics, uniqueRif, PASSWORD } from './helpers';

describe('Nota de entrega (compromete), módulo Tasas y reportes de ventas del vendedor', () => {
  let ctx: Ctx; let admin: Api; let token = ''; let b: Awaited<ReturnType<typeof seedBasics>>; let customerId: string;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'NotaEntrega'); token = t.token; admin = client(ctx, t.token); b = await seedBasics(admin);
    customerId = (await admin.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Uno' })).body.data.id;
    await admin.post('/price-lists', { code: 'P1', name: 'Precio 1', currencyId: b.usd, isDefault: true });
    await admin.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today() });
  });
  afterAll(async () => { await ctx.close(); });

  const withStock = async (sku: string, qty: number, extra: object = {}) => {
    const p = await b.product(sku, extra);
    const d = await admin.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: String(qty), unitCost: '5' }] });
    await admin.post(`/inventory/charges/${d.body.data.id}/confirm`);
    return p;
  };
  const reserved = async (p: string) => (await admin.get(`/products/${p}/stock`)).body.data.warehouses.find((w: any) => w.warehouseId === b.w1)?.reservedQty ?? '0';
  const doc = (lines: object[], extra: object = {}) => ({ customerId, warehouseId: b.w1, currencyId: b.usd, lines, ...extra });

  it('la nota de entrega compromete las existencias por defecto al confirmarla y el producto trae su marca', async () => {
    const p = await withStock('NE-1', 10, { brand: 'KMD' });
    const r = await admin.post('/sales/orders', doc([{ productId: p, quantity: '4', unitPrice: '10' }])); // sin indicar reservesStock
    expect(r.status).toBe(201);
    expect(r.body.data.reservesStock).toBe(true);
    expect(r.body.data.lines[0].product).toMatchObject({ sku: 'NE-1', brand: 'KMD' });
    expect(await reserved(p)).toBe('0');                       // el borrador aún no aparta
    expect((await admin.post(`/sales/orders/${r.body.data.id}/confirm`)).status).toBe(201);
    expect(await reserved(p)).toBe('4');                       // confirmada: compromete 4
    // más de lo disponible: no se puede comprometer
    const big = await admin.post('/sales/orders', doc([{ productId: p, quantity: '7', unitPrice: '10' }]));
    const c2 = await admin.post(`/sales/orders/${big.body.data.id}/confirm`);
    expect(c2.status).toBe(422); expect(c2.body.error).toBe('INSUFFICIENT_AVAILABLE_STOCK');
    // sin depósito no hay dónde comprometer: se crea sin reserva
    const nw = await admin.post('/sales/orders', { customerId, currencyId: b.usd, lines: [{ productId: p, quantity: '1', unitPrice: '10' }] });
    expect(nw.status).toBe(201); expect(nw.body.data.reservesStock).toBe(false);
  });

  it('módulo Tasas: resumen con la tasa vigente, origen, serie y estado de la sincronización', async () => {
    const r = await admin.get('/exchange-rates/summary');
    expect(r.status).toBe(200);
    expect(typeof r.body.data.autoSync).toBe('boolean');
    const usd = r.body.data.currencies.find((c: any) => c.code === 'USD');
    expect(usd).toMatchObject({ rate: '40', source: 'MANUAL', date: today() });
    expect(usd.series.at(-1)).toMatchObject({ date: today(), rate: '40' });
    expect(r.body.data.currencies.find((c: any) => c.code === 'VES')).toBeUndefined();
    // una tasa nueva del mismo día prevalece y la variación se calcula contra la anterior
    await admin.post('/exchange-rates', { currencyId: b.usd, rate: '44', date: today() });
    const r2 = (await admin.get('/exchange-rates/summary')).body.data.currencies.find((c: any) => c.code === 'USD');
    expect(r2.rate).toBe('44');
  });

  it('un vendedor saca reportes de ventas solo de lo suyo; sin vendedor ligado no hay reporte', async () => {
    const mk = async (code: string) => {
      const email = `${code.toLowerCase()}-${Date.now()}@test.local`;
      const u = await admin.post('/users', { email, fullName: `Vendedor ${code}`, password: PASSWORD, roleCodes: ['VENDEDOR'] });
      const s = (await admin.post('/sellers', { code, name: `Vendedor ${code}`, userId: u.body.data.id })).body.data.id as string;
      const lg = await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD });
      return { sellerId: s, api: client(ctx, lg.body.data.accessToken) };
    };
    const A = await mk('RA'); const B = await mk('RB');
    const p = await withStock('NE-REP', 50);
    for (const [s, n] of [[A.sellerId, 2], [B.sellerId, 3]] as const)
      for (let i = 0; i < n; i++) expect((await admin.post('/sales/quotes', doc([{ productId: p, quantity: '1', unitPrice: '10' }], { sellerId: s }))).status).toBe(201);
    const rows = (r: any) => r.body.data.rows as Record<string, any>[];
    const ra = await A.api.get('/reports/sales/documents');
    expect(ra.status).toBe(200);
    expect(rows(ra).length).toBe(2); expect(new Set(rows(ra).map(x => x.seller))).toEqual(new Set(['Vendedor RA']));
    expect(rows(await B.api.get('/reports/sales/documents')).length).toBe(3);
    // el administrador ve todo
    expect(rows(await admin.get('/reports/sales/documents')).length).toBeGreaterThanOrEqual(5);
    // los demás reportes de ventas también respetan el alcance
    const order = async (seller: string, qty: string) => {
      const o = await admin.post('/sales/orders', doc([{ productId: p, quantity: qty, unitPrice: '10' }], { sellerId: seller }));
      expect((await admin.post(`/sales/orders/${o.body.data.id}/confirm`)).status).toBe(201);
    };
    await order(A.sellerId, '1'); await order(B.sellerId, '2'); await order(B.sellerId, '3');
    expect(rows(await A.api.get('/reports/sales/by-customer'))[0].orders).toBe(1);
    expect(rows(await B.api.get('/reports/sales/by-customer'))[0].orders).toBe(2);
    expect(rows(await admin.get('/reports/sales/by-customer'))[0].orders).toBe(4); // el administrador ve todo (incluida la nota de entrega de la primera prueba)
    expect(Number(rows(await A.api.get('/reports/sales/by-product'))[0].qty)).toBe(1);
    // y no ve reportes de otras áreas
    expect((await A.api.get('/reports/inventory/products')).status).toBe(403);
    // usuario con rol vendedor pero sin vendedor ligado
    const email = `sinv-${Date.now()}@test.local`;
    await admin.post('/users', { email, fullName: 'Sin vendedor', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    const lg = await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const none = await client(ctx, lg.body.data.accessToken).get('/reports/sales/documents');
    expect(none.status).toBe(403); expect(none.body.error).toBe('SELLER_REQUIRED');
  });

  it('etiquetas QR: PDF del tamaño del rollo, filtros y límites', async () => {
    await withStock('ET-1', 1, { brand: 'MOTTA' }); await withStock('ET-2', 1);
    const buf = (res: any, cb: any) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); };
    const get = (q: string) => ctx.http.get(`/api/v1/products/labels${q}`).set(auth(token)).buffer(true).parse(buf);
    const r = await get('?search=ET-&copies=2&width=50&height=30');
    expect(r.status).toBe(200); expect(r.headers['content-type']).toContain('application/pdf'); expect(r.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(r.headers['x-label-count']).toBe('4');                 // 2 productos × 2 copias
    expect((await ctx.http.get('/api/v1/products/labels?search=NO-EXISTE-XYZ').set(auth(token))).body.error).toBe('NO_PRODUCTS');
    const noServices = await ctx.http.get('/api/v1/products').set(auth(token)).query({ isService: 'false', isActive: 'true', search: 'ET-' });
    expect(noServices.body.data.length).toBe(2);                    // "false" ya no se lee como verdadero
    const pl = (await ctx.http.get('/api/v1/price-lists').set(auth(token))).body.data[0].id;
    const withFields = await get(`?search=ET-&fields=name,brand,category,unit,barcode,location,description,price:${pl}`);
    expect(withFields.status).toBe(200); expect(withFields.headers['x-label-count']).toBe('2');
    const one = await ctx.http.get('/api/v1/products').set(auth(token)).query({ search: 'ET-1' });
    expect((await get(`?ids=${one.body.data[0].id}&fields=name`)).headers['x-label-count']).toBe('1');
    expect((await ctx.http.get('/api/v1/products/labels?fields=hack').set(auth(token))).status).toBe(400);
    expect((await ctx.http.get('/api/v1/products/labels?width=500').set(auth(token))).status).toBe(400);
  });
});
