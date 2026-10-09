import { bootstrap, Ctx, createTenant, client, Api, seedBasics } from './helpers';

describe('Actualización masiva de precios', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let listUsd: string; let listVes: string; let pA: string; let pB: string; let catId: string;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Precios'); api = client(ctx, t.token); b = await seedBasics(api);
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today() });
    listUsd = (await api.post('/price-lists', { code: 'USD', name: 'Lista USD', currencyId: b.usd, isDefault: true })).body.data.id;
    listVes = (await api.post('/price-lists', { code: 'VES', name: 'Lista Bs', currencyId: b.ves })).body.data.id;
    catId = (await api.post('/categories', { code: 'C1', name: 'Cat 1' })).body.data.id;
    pA = await b.product('PR-A', { categoryId: catId }); pB = await b.product('PR-B');
    await api.post(`/products/${pA}/prices`, { priceListId: listUsd, price: '10' });
    const ch = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: pB, quantity: '5', unitCost: '4' }] });
    await api.post(`/inventory/charges/${ch.body.data.id}/confirm`);
  });
  afterAll(async () => { await ctx.close(); });
  const price = async (p: string, list: string) => (await api.get(`/products/${p}`)).body.data.prices.find((x: any) => x.priceListId === list)?.price;
  const bulk = (b2: object) => api.post('/products/prices/bulk', b2);

  it('vista previa sin cambios y aplicación de un % sobre el precio vigente', async () => {
    const prev = await bulk({ priceListId: listUsd, mode: 'PERCENT', value: '10' });
    expect(prev.status).toBe(201);
    expect(prev.body.data).toMatchObject({ dryRun: true, total: 2, changed: 1, skipped: 1 });
    expect(prev.body.data.rows.find((r: any) => r.sku === 'PR-A')).toMatchObject({ oldPrice: '10', newPrice: '11' });
    expect(prev.body.data.rows.find((r: any) => r.sku === 'PR-B').skipped).toBe('SIN_PRECIO_BASE');
    expect(Number(await price(pA, listUsd))).toBe(10); // la vista previa no escribe
    const done = await bulk({ priceListId: listUsd, mode: 'PERCENT', value: '10', dryRun: false });
    expect(done.body.data).toMatchObject({ dryRun: false, changed: 1 });
    expect(Number(await price(pA, listUsd))).toBe(11);
    expect((await api.get(`/products/${pA}/price-history`)).body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('margen sobre costo promedio con conversión a la moneda de la lista', async () => {
    // costo de PR-B: 4 USD → lista en Bs: 4 × 40 × 1,5 = 240
    const r = await bulk({ priceListId: listVes, mode: 'MARGIN', value: '50', dryRun: false, productIds: [pB] });
    expect(r.body.data).toMatchObject({ changed: 1, total: 1 });
    expect(Number(await price(pB, listVes))).toBe(240);
    // misma moneda que la valoración (USD): 4 × 1,25 = 5
    await bulk({ priceListId: listUsd, mode: 'MARGIN', value: '25', dryRun: false, productIds: [pB] });
    expect(Number(await price(pB, listUsd))).toBe(5);
    // PR-A sin costo → se omite
    const skip = await bulk({ priceListId: listUsd, mode: 'MARGIN', value: '25', productIds: [pA] });
    expect(skip.body.data.rows[0].skipped).toBe('SIN_COSTO');
  });

  it('precio fijo por instancia, precio base de otra lista y validaciones', async () => {
    const fixed = await bulk({ priceListId: listVes, mode: 'SET', value: '99.5', categoryId: catId, dryRun: false });
    expect(fixed.body.data).toMatchObject({ total: 1, changed: 1 });
    expect(Number(await price(pA, listVes))).toBe(99.5);
    // tomar como base la lista USD (PR-A = 11 USD) y subir 20 %
    const fromOther = await bulk({ priceListId: listVes, mode: 'PERCENT', value: '20', sourcePriceListId: listUsd, productIds: [pA] });
    expect(Number(fromOther.body.data.rows[0].newPrice)).toBe(13.2);
    expect((await bulk({ priceListId: listVes, mode: 'PERCENT', value: '-100' })).status).toBe(400);
    expect((await bulk({ priceListId: listVes, mode: 'SET', value: '-1' })).status).toBe(400);
    expect((await bulk({ priceListId: listVes, mode: 'SET', value: '1', categoryId: '019a0000-0000-7000-8000-000000000000' })).body.error).toBe('NO_PRODUCTS');
  });
});
