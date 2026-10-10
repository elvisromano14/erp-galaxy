import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif } from './helpers';

/**
 * Regresión: cada petición mantiene UNA conexión (su transacción de empresa). Si algún servicio usa el cliente global dentro de la
 * petición, necesita una segunda conexión y con más peticiones simultáneas que conexiones del pool todas se quedan esperando.
 * (El pool de pruebas es de 25 conexiones.)
 */
describe('Concurrencia: peticiones simultáneas por encima del tamaño del pool', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let supplierId: string; let productId: string;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Concurrencia'); api = client(ctx, t.token); b = await seedBasics(api);
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today() });
    supplierId = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor C' })).body.data.id;
    productId = await b.product('CONC-1');
  });
  afterAll(async () => { await ctx.close(); });

  it('80 escrituras y 80 lecturas simultáneas terminan bien y sin esperar el tiempo de espera del pool', async () => {
    const t0 = Date.now();
    const writes = Array.from({ length: 80 }, () => api.post('/purchases/orders', { supplierId, warehouseId: b.w1, currencyId: b.usd, lines: [{ productId, quantity: '1', unitCost: '1' }] }));
    const reads = Array.from({ length: 80 }, () => api.get('/reports/inventory/products?format=json'));
    const res = await Promise.all([...writes, ...reads]);
    expect(res.filter(r => r.status >= 400).map(r => `${r.status} ${r.body?.error}`)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(8000); // el tiempo de espera del pool es de 10 s: si se agota, hubo interbloqueo
  });
});
