import { createHash, randomUUID } from 'node:crypto';
import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif } from './helpers';

/** A7 y productos: listas de precio de Saint, upsert de productos con precios, historial sin repeticiones y eventos. */
describe('Integración (A7): listas de precio de Saint y productos', () => {
  let ctx: Ctx; let admin: Api; let svc: Api; let b: Awaited<ReturnType<typeof seedBasics>>;
  let lists: Record<string, string> = {};
  const CONNECTOR = 'electrosur';
  const upsert = (items: object[], extra: object = {}) => svc.post('/integration/products/upsert-batch', { system: 'SAINT', connector: CONNECTOR, items, ...extra });
  const item = (key: string, data: object, over: object = {}) => ({ externalKey: key, origin: 'SAINT', hash: createHash('sha256').update(JSON.stringify([key, data])).digest('hex'), data, ...over });
  const events = (q = '') => svc.get(`/integration/events?entity=product${q}`);
  const productData = (sku: string, extra: object = {}) => ({ sku, name: `Producto ${sku}`, unitId: b.unitId, taxId: b.iva, barcodes: [`750${sku.replace(/\D/g, '').padStart(6, '0')}`], ...extra });

  beforeAll(async () => {
    ctx = await bootstrap();
    const tenant = await createTenant(ctx, 'Productos'); admin = client(ctx, tenant.token);
    b = await seedBasics(admin);
    const acc = (await admin.post('/integration/service-accounts', { name: 'Integrador' })).body.data;
    const tok = await ctx.http.post('/api/v1/auth/service-token').send({ clientId: acc.clientId, clientSecret: acc.clientSecret });
    svc = client(ctx, tok.body.data.accessToken);
  });
  afterAll(async () => { await ctx.close(); });

  describe('listas de precio de Saint', () => {
    it('crea Precio 1 a 3 sin tocar la lista predeterminada y deja las referencias', async () => {
      const r = await svc.post('/integration/setup/saint-price-lists', { system: 'SAINT', connector: CONNECTOR });
      expect(r.status).toBe(200);
      expect(r.body.data.lists.map((l: any) => [l.key, l.code, l.status])).toEqual([['P1', 'SAINT-P1', 'CREATED'], ['P2', 'SAINT-P2', 'CREATED'], ['P3', 'SAINT-P3', 'CREATED']]);
      for (const l of r.body.data.lists) lists[l.key] = l.erpId;
      const all = (await admin.get('/price-lists?limit=50')).body.data as any[];
      expect(all.find(l => l.code === 'DETAL').isDefault).toBe(true);        // la predeterminada sigue siendo la misma
      expect(all.filter(l => l.isDefault)).toHaveLength(1);
      expect(all.find(l => l.code === 'SAINT-P1')).toMatchObject({ name: 'Precio 1 (Saint)', isDefault: false });
      const refs = (await svc.get('/integration/refs?entity=price_lists&externalKey=P2')).body.data;
      expect(refs).toEqual([expect.objectContaining({ entityId: lists.P2, externalKey: 'P2', origin: 'ERP' })]);
    });

    it('es idempotente; con empaque agrega las «por unidad»; una lista existente con ese código se vincula; moneda propia', async () => {
      const again = (await svc.post('/integration/setup/saint-price-lists', { system: 'SAINT', connector: CONNECTOR })).body.data;
      expect(again.lists.map((l: any) => l.status)).toEqual(['EXISTING', 'EXISTING', 'EXISTING']);
      expect(again.lists.map((l: any) => l.erpId)).toEqual([lists.P1, lists.P2, lists.P3]);
      // Existe a mano una lista con el código SAINT-P1U: se vincula, no se duplica
      const manual = (await admin.post('/price-lists', { code: 'SAINT-P1U', name: 'Hecha a mano', currencyId: b.ves })).body.data;
      const withUnit = (await svc.post('/integration/setup/saint-price-lists', { system: 'SAINT', connector: CONNECTOR, withUnitLists: true, currencyId: b.usd })).body.data;
      expect(withUnit.lists.map((l: any) => [l.key, l.status])).toEqual([['P1', 'EXISTING'], ['P2', 'EXISTING'], ['P3', 'EXISTING'], ['P1U', 'LINKED'], ['P2U', 'CREATED'], ['P3U', 'CREATED']]);
      expect(withUnit.lists[3]).toMatchObject({ erpId: manual.id, warnings: [expect.stringMatching(/otra moneda/)] });
      expect(withUnit.lists[4].currencyId).toBe(b.usd);
      const count = ((await admin.get('/price-lists?limit=50')).body.data as any[]).filter(l => l.code.startsWith('SAINT-'));
      expect(count).toHaveLength(6);
    });

    it('moneda inexistente se rechaza', async () => {
      const r = await svc.post('/integration/setup/saint-price-lists', { system: 'SAINT', connector: CONNECTOR, currencyId: randomUUID() });
      expect(r.status).toBe(422); expect(r.body.error).toBe('CURRENCY_NOT_FOUND');
    });
  });

  describe('upsert de productos con precios', () => {
    let pid: string;

    it('crea con códigos de barras y precios por lista; la ficha muestra las referencias externas', async () => {
      const prices = [{ priceListId: lists.P1, price: '103' }, { priceListId: lists.P2, price: '121' }, { priceListId: lists.P3, price: '138' }];
      const res = (await upsert([
        item('LUB-001', productData('LUB-001', { prices })),
        item('MAL-001', productData('MAL-001', { unitId: randomUUID() })),            // unidad inexistente
        item('MAL-002', { sku: 'MAL-002' }),                                          // faltan campos
      ])).body.data;
      expect(res.results.map((r: any) => r.result)).toEqual(['CREATED', 'REJECTED', 'REJECTED']);
      expect(res.results[1].code).toBe('INVALID_REFERENCE'); expect(res.results[2].code).toBe('VALIDATION_ERROR');
      pid = res.results[0].erpId;
      const p = (await admin.get(`/products/${pid}`)).body.data;
      expect(p).toMatchObject({ sku: 'LUB-001', version: 1, barcodes: ['750000001'], externalRefs: [{ system: 'SAINT', connector: CONNECTOR, key: 'LUB-001', origin: 'SAINT' }] });
      expect(p.prices.map((x: any) => [x.priceListId, x.price]).sort()).toEqual([[lists.P1, '103'], [lists.P2, '121'], [lists.P3, '138']].sort());
      expect((await admin.get('/products?search=MAL')).body.data).toHaveLength(0);
    });

    it('el historial solo recibe precios que cambiaron', async () => {
      const prices = (p1: string) => [{ priceListId: lists.P1, price: p1 }, { priceListId: lists.P2, price: '121' }, { priceListId: lists.P3, price: '138' }];
      // cambia solo el nombre: no se agregan precios
      const r1 = (await upsert([item('LUB-001', productData('LUB-001', { name: 'Aceite 15W40 (renombrado)', prices: prices('103') }))])).body.data.results[0];
      expect(r1).toMatchObject({ result: 'UPDATED', erpId: pid, version: 2 });
      expect((await admin.get(`/products/${pid}/price-history`)).body.data).toHaveLength(3);
      // cambia el precio 1 (y solo ese)
      const r2 = (await upsert([item('LUB-001', productData('LUB-001', { name: 'Aceite 15W40 (renombrado)', prices: prices('110.5') }))])).body.data.results[0];
      expect(r2).toMatchObject({ result: 'UPDATED', version: 3 });
      const hist = (await admin.get(`/products/${pid}/price-history`)).body.data as any[];
      expect(hist).toHaveLength(3);                  // mismo día: el precio 1 se actualiza en su fila de hoy
      expect(hist.find(h => h.priceListId === lists.P1).price).toBe('110.5');
      expect((await admin.get(`/products/${pid}`)).body.data.name).toBe('Aceite 15W40 (renombrado)');
    });

    it('mismo hash → UNCHANGED; expectedVersion desfasada → VERSION_CONFLICT', async () => {
      const same = (await upsert([item('LUB-001', productData('LUB-001', { name: 'Aceite 15W40 (renombrado)', prices: [{ priceListId: lists.P1, price: '110.5' }, { priceListId: lists.P2, price: '121' }, { priceListId: lists.P3, price: '138' }] }))])).body.data.results[0];
      expect(same.result).toBe('UNCHANGED');
      const stale = (await upsert([item('LUB-001', productData('LUB-001', { name: 'Otro' }), { expectedVersion: 1 })])).body.data.results[0];
      expect(stale).toMatchObject({ result: 'REJECTED', code: 'VERSION_CONFLICT', version: 3 });
    });

    it('vincula por SKU y rechaza el SKU ya vinculado a otra clave externa', async () => {
      const own = (await admin.post('/products', { sku: 'ERP-001', name: 'Nacido en el ERP', unitId: b.unitId, taxId: b.iva })).body.data;
      const link = (await upsert([item('S-ERP-001', productData('ERP-001', { name: 'Nombre de Saint' }))])).body.data.results[0];
      expect(link).toMatchObject({ result: 'LINKED', erpId: own.id });
      expect((await admin.get(`/products/${own.id}`)).body.data.name).toBe('Nacido en el ERP');
      const dup = (await upsert([item('S-OTRO', productData('ERP-001'))])).body.data.results[0];
      expect(dup).toMatchObject({ result: 'REJECTED', code: 'DUPLICATE_NATURAL_KEY', existingErpId: own.id, otherExternalKey: 'S-ERP-001' });
    });

    it('baja por isActive=false emite DEACTIVATE; el integrador no ve sus propios eventos', async () => {
      const mark = (await events()).body.data.nextCursor;
      const r = (await upsert([item('LUB-001', productData('LUB-001', { name: 'Aceite 15W40 (renombrado)', isActive: false }))])).body.data.results[0];
      expect(r.result).toBe('UPDATED');
      expect((await admin.get(`/products/${pid}`)).body.data).toMatchObject({ isActive: false, deletedAt: null });
      expect((await events(`&after=${mark}`)).body.data.events).toEqual([]);
      const all = (await events(`&after=${mark}&includeIntegration=true`)).body.data.events as any[];
      expect(all.map(e => [e.op, e.origin])).toEqual([['DEACTIVATE', 'INTEGRATION']]);
    });
  });

  describe('eventos de productos desde el ERP', () => {
    it('alta, edición, precio suelto y actualización masiva avisan al integrador', async () => {
      const mark = (await events()).body.data.nextCursor;
      const p = (await admin.post('/products', { sku: 'EVT-001', name: 'Producto de eventos', unitId: b.unitId, taxId: b.iva, prices: [{ priceListId: lists.P1, price: '10' }] })).body.data;
      await admin.patch(`/products/${p.id}`, { name: 'Producto de eventos 2' });
      await admin.post(`/products/${p.id}/prices`, { priceListId: lists.P2, price: '12' });
      const bulk = await admin.post('/products/prices/bulk', { priceListId: lists.P1, mode: 'PERCENT', value: '10', productIds: [p.id], dryRun: false });
      expect(bulk.status).toBe(201);
      await admin.del(`/products/${p.id}`);
      const ev = (await events(`&after=${mark}`)).body.data.events as any[];
      expect(ev.map(e => [e.op, e.origin, e.summary?.prices ? 'precios' : ''])).toEqual([
        ['CREATE', 'ERP', ''], ['UPDATE', 'ERP', ''], ['UPDATE', 'ERP', 'precios'], ['UPDATE', 'ERP', 'precios'], ['DEACTIVATE', 'ERP', ''],
      ]);
      expect(ev[0]).toMatchObject({ entity: 'product', entityId: p.id, version: 1 });
      expect(ev[1].version).toBe(2);
    });

    it('get-batch de productos devuelve códigos de barras, precios y referencias', async () => {
      const g = (await svc.post('/integration/products/get-batch', { system: 'SAINT', externalKeys: ['LUB-001'] })).body.data;
      expect(g.items[0]).toMatchObject({ sku: 'LUB-001', barcodes: ['750000001'], externalRefs: [{ key: 'LUB-001' }] });
      expect(g.items[0].prices).toHaveLength(3);
    });
  });

  it('la ficha de un cliente también muestra las referencias externas', async () => {
    const rif = uniqueRif('J');
    const r = (await svc.post('/integration/customers/upsert-batch', { system: 'SAINT', connector: CONNECTOR, items: [item('C-9', { rif, legalName: 'Cliente con referencia' })] })).body.data.results[0];
    const c = (await admin.get(`/customers/${r.erpId}`)).body.data;
    expect(c.externalRefs).toEqual([expect.objectContaining({ system: 'SAINT', key: 'C-9', origin: 'SAINT' })]);
  });
});
