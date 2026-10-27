import { randomUUID } from 'node:crypto';
import { bootstrap, Ctx, createTenant, client, Api, seedBasics, PASSWORD, auth } from './helpers';

/** Ubicaciones (catálogo simple) + marca y ubicación opcionales del producto: API, importación y móvil. */
describe('Ubicaciones y marca de producto', () => {
  let ctx: Ctx; let admin: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let tenant: Awaited<ReturnType<typeof createTenant>>;
  let other: Api; let otherLoc: string;
  let mgrToken: string; let mgrDevice: string; let vendToken: string; let vendDevice: string;
  const hdr = (token: string, dev: string) => ({ ...auth(token), 'x-device-id': dev, 'x-app-version': '1.0.0' });
  const pull = (entity: string, token = mgrToken, dev = mgrDevice) => ctx.http.get('/api/v1/sync/pull').set(hdr(token, dev)).query({ entity });
  const push = (operations: object[], token = mgrToken, dev = mgrDevice) => ctx.http.post('/api/v1/sync/push').set(hdr(token, dev)).send({ operations });
  let seq = 0;
  const op = (entity: string, action: string, data: object, entityId = randomUUID(), clientOpId = randomUUID()) => ({ clientOpId, clientSeq: ++seq, entity, action, entityId, data });
  const csv = (header: string[], rows: string[][]) => Buffer.from('﻿' + [header, ...rows].map(r => r.join(';')).join('\r\n'), 'utf8');
  const upload = (type: string, file: Buffer, query = '') => ctx.http.post(`/api/v1/imports/${type}${query}`).set(auth(tenant.token)).attach('file', file, 'x.csv');
  const register = async (token: string) => (await ctx.http.post('/api/v1/devices/register').set(auth(token)).send({ deviceKey: `key-${randomUUID()}`, name: 'Teléfono', appVersion: '1.0.0' })).body.data.id as string;
  const userToken = async (roleCodes: string[], extra: object = {}) => {
    const email = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
    const u = await admin.post('/users', { email, fullName: 'Usuario', password: PASSWORD, roleCodes, ...extra });
    expect(u.status).toBe(201);
    return { id: u.body.data.id as string, token: (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken as string };
  };

  beforeAll(async () => {
    ctx = await bootstrap();
    tenant = await createTenant(ctx, 'Ubic'); admin = client(ctx, tenant.token); b = await seedBasics(admin);
    const t2 = await createTenant(ctx, 'Ubic Otra'); other = client(ctx, t2.token);
    otherLoc = (await other.post('/locations', { code: 'AJENA', name: 'Ubicación de otra empresa' })).body.data.id;
    await admin.post('/price-lists', { code: 'DET', name: 'Detal', currencyId: b.usd, isDefault: true });
    mgrToken = (await userToken(['GERENTE'])).token; mgrDevice = await register(mgrToken);
    const v = await userToken(['VENDEDOR']);
    await admin.post('/sellers', { code: 'V9', name: 'Vendedor', userId: v.id });
    vendToken = v.token; vendDevice = await register(vendToken);
  });
  afterAll(async () => { await ctx.close(); });

  it('ubicaciones: CRUD, código único, borrado lógico y permisos (el vendedor solo lee)', async () => {
    const c = await admin.post('/locations', { code: 'P1-E6-P4', name: 'Pasillo 1, estante 6, piso 4' });
    expect(c.status).toBe(201); expect(c.body.data).toMatchObject({ code: 'P1-E6-P4', isActive: true });
    expect((await admin.post('/locations', { code: 'P1-E6-P4', name: 'Repetida' })).status).toBe(409);
    const id = c.body.data.id;
    expect((await admin.patch(`/locations/${id}`, { name: 'Pasillo 1-6-4' })).body.data.name).toBe('Pasillo 1-6-4');
    expect((await admin.get('/locations')).body.data.map((x: any) => x.code)).toContain('P1-E6-P4');
    // otra empresa no la ve
    expect((await other.get('/locations')).body.data.map((x: any) => x.code)).not.toContain('P1-E6-P4');
    // el vendedor lee pero no crea ni edita
    const vend = client(ctx, vendToken);
    expect((await vend.get('/locations')).status).toBe(200);
    expect((await vend.post('/locations', { code: 'X', name: 'X' })).status).toBe(403);
    expect((await vend.patch(`/locations/${id}`, { name: 'Y' })).status).toBe(403);
    expect((await vend.del(`/locations/${id}`)).status).toBe(403);
    // borrado lógico
    const tmp = (await admin.post('/locations', { code: 'TMP', name: 'Temporal' })).body.data.id;
    expect((await admin.del(`/locations/${tmp}`)).status).toBe(200);
    expect((await admin.get('/locations')).body.data.map((x: any) => x.code)).not.toContain('TMP');
  });

  it('producto: marca y ubicación opcionales (crear, editar, listar, filtrar, buscar) y validaciones', async () => {
    const loc = (await admin.post('/locations', { code: 'VITRINA', name: 'Vitrina' })).body.data.id;
    const plain = await admin.post('/products', { sku: 'SIN-DATOS', name: 'Sin marca ni ubicación', unitId: b.unitId });
    expect(plain.status).toBe(201); expect(plain.body.data).toMatchObject({ brand: null, locationId: null });
    const c = await admin.post('/products', { sku: 'CON-DATOS', name: 'Con marca', unitId: b.unitId, brand: 'MHW', locationId: loc });
    expect(c.status).toBe(201); expect(c.body.data).toMatchObject({ brand: 'MHW', locationId: loc });
    const id = c.body.data.id;
    // listar / filtrar / buscar por marca
    const list = (await admin.get('/products?limit=50')).body.data;
    expect(list.find((p: any) => p.sku === 'CON-DATOS')).toMatchObject({ brand: 'MHW', locationId: loc });
    expect((await admin.get('/products?brand=mhw')).body.data.map((p: any) => p.sku)).toEqual(['CON-DATOS']);
    expect((await admin.get(`/products?locationId=${loc}`)).body.data.map((p: any) => p.sku)).toEqual(['CON-DATOS']);
    expect((await admin.get('/products?search=mhw')).body.data.map((p: any) => p.sku)).toEqual(['CON-DATOS']);
    // editar y quitar (null)
    const cur = (await admin.get(`/products/${id}`)).body.data;
    const up = await admin.patch(`/products/${id}`, { brand: 'HAMMER', locationId: null, version: cur.version });
    expect(up.status).toBe(200); expect(up.body.data).toMatchObject({ brand: 'HAMMER', locationId: null });
    // validaciones: marca demasiado larga, ubicación inexistente, de otra empresa o borrada
    expect((await admin.post('/products', { sku: 'LARGA', name: 'x', unitId: b.unitId, brand: 'M'.repeat(81) })).status).toBe(400);
    const bad = await admin.post('/products', { sku: 'MALA-UBIC', name: 'x', unitId: b.unitId, locationId: randomUUID() });
    expect(bad.status).toBe(422); expect(bad.body.error).toBe('LOCATION_NOT_FOUND');
    expect((await admin.post('/products', { sku: 'AJENA', name: 'x', unitId: b.unitId, locationId: otherLoc })).status).toBe(422);
    const gone = (await admin.post('/locations', { code: 'BORRADA', name: 'Borrada' })).body.data.id;
    await admin.del(`/locations/${gone}`);
    expect((await admin.post('/products', { sku: 'UBIC-BORRADA', name: 'x', unitId: b.unitId, locationId: gone })).status).toBe(422);
  });

  it('importación: ubicaciones y productos con marca y ubicación (vacío al actualizar no modifica)', async () => {
    expect((await admin.get('/imports/types')).body.data.map((x: any) => x.key)).toContain('locations');
    const tpl = await ctx.http.get('/api/v1/imports/products/template?format=csv').set(auth(tenant.token));
    expect(tpl.text).toContain('marca;ubicacion');
    const lf = csv(['codigo', 'nombre', 'activo'], [['IMP-A', 'Importada A', 'SI'], ['IMP-B', 'Importada B', 'NO'], ['IMP-A', 'Repetida', '']]);
    const lv = await upload('locations', lf);
    expect(lv.body.data.summary).toMatchObject({ total: 3, errors: 1 });
    const lok = await upload('locations', csv(['codigo', 'nombre', 'activo'], [['IMP-A', 'Importada A', 'SI'], ['IMP-B', 'Importada B', 'NO']]), '?mode=commit');
    expect(lok.body.data.result).toMatchObject({ created: 2 });
    expect((await admin.get('/locations')).body.data.find((x: any) => x.code === 'IMP-B').isActive).toBe(false);

    const head = ['sku', 'nombre', 'unidad', 'marca', 'ubicacion'];
    const bad = await upload('products', csv(head, [['IMP-1', 'Con ubicación mala', 'UND', 'MHW', 'NOEXISTE'], ['IMP-2', 'Marca larga', 'UND', 'M'.repeat(81), '']]));
    expect(bad.body.data.summary.errors).toBe(2);
    expect(bad.body.data.rows[0].errors[0]).toContain('NOEXISTE');
    const ok = await upload('products', csv(head, [['IMP-1', 'Importado 1', 'UND', 'MHW', 'IMP-A'], ['IMP-2', 'Importado 2', 'UND', '', '']]), '?mode=commit');
    expect(ok.body.data.result).toMatchObject({ created: 2 });
    const rows = (await admin.get('/products?limit=100')).body.data;
    const locA = (await admin.get('/locations')).body.data.find((x: any) => x.code === 'IMP-A').id;
    expect(rows.find((p: any) => p.sku === 'IMP-1')).toMatchObject({ brand: 'MHW', locationId: locA });
    expect(rows.find((p: any) => p.sku === 'IMP-2')).toMatchObject({ brand: null, locationId: null });
    // actualizar con celdas vacías no borra; con datos, sí cambia
    const up1 = await upload('products', csv(head, [['IMP-1', '', '', '', '']]), '?mode=commit&onExisting=update');
    expect(up1.status).toBe(201);
    expect((await admin.get('/products?search=IMP-1')).body.data[0]).toMatchObject({ brand: 'MHW', locationId: locA });
    await upload('products', csv(head, [['IMP-1', '', '', 'HAMMER', '']]), '?mode=commit&onExisting=update');
    expect((await admin.get('/products?search=IMP-1')).body.data[0]).toMatchObject({ brand: 'HAMMER', locationId: locA });
  });

  it('móvil pull: productos con marca/ubicación/ids, catálogos (ubicaciones, unidades, instancias) y banderas de alta de productos', async () => {
    const loc = (await admin.get('/locations')).body.data.find((x: any) => x.code === 'VITRINA');
    const prods = (await pull('products')).body.data.items;
    const withData = prods.find((p: any) => p.sku === 'IMP-1');
    expect(withData).toMatchObject({ brand: 'HAMMER', unitId: b.unitId, categoryId: null, locationId: expect.any(String) });
    expect(prods.find((p: any) => p.sku === 'SIN-DATOS')).toMatchObject({ brand: null, locationId: null });
    const locs = (await pull('locations')).body.data;
    expect(locs.fullRefresh).toBe(true);
    expect(locs.items.find((l: any) => l.id === loc.id)).toMatchObject({ code: 'VITRINA', name: 'Vitrina', isActive: true });
    expect((await pull('units')).body.data.items.map((u: any) => u.code)).toContain('UND');
    expect((await pull('categories')).status).toBe(200);
    expect((await pull('app_settings')).body.data.items[0]).toMatchObject({ allowProductCreate: true, allowProductUpdate: true });
    expect((await pull('app_settings', vendToken, vendDevice)).body.data.items[0]).toMatchObject({ allowProductCreate: false, allowProductUpdate: false });
  });

  it('móvil push product.create: crea con marca, ubicación, códigos de barras y precio inicial; es idempotente', async () => {
    const loc = (await admin.get('/locations')).body.data.find((x: any) => x.code === 'VITRINA').id;
    const data = { sku: 'MOV-001', name: 'Producto desde el móvil', unitId: b.unitId, taxId: b.iva, brand: 'KTO', locationId: loc, minStock: '2', barcodes: ['7599990001'], price: '12.50' };
    const o = op('product', 'create', data);
    const r = await push([o]);
    expect(r.status).toBe(201);
    expect(r.body.data.results[0]).toMatchObject({ status: 'APPLIED', serverNumber: 'MOV-001', serverStatus: 'ACTIVE' });
    const serverId = r.body.data.results[0].serverId;
    const p = (await admin.get(`/products/${serverId}`)).body.data;
    expect(p).toMatchObject({ sku: 'MOV-001', brand: 'KTO', locationId: loc, barcodes: ['7599990001'] });
    expect(p.prices.map((x: any) => Number(x.price))).toEqual([12.5]);
    // reenvío del mismo clientOpId: DUPLICATE, sin duplicar el producto
    const again = await push([o]);
    expect(again.body.data.results[0]).toMatchObject({ status: 'DUPLICATE', serverId });
    // otra operación (otro clientOpId) con el mismo SKU: se vincula al existente
    const linked = await push([op('product', 'create', data)]);
    expect(linked.body.data.results[0]).toMatchObject({ status: 'APPLIED', serverId, linked: true });
    expect((await admin.get('/products?search=MOV-001')).body.data).toHaveLength(1);
    // validación y reglas de negocio → rechazo definitivo
    const val = await push([op('product', 'create', { sku: 'MOV-X', name: 'x', unitId: 'no-es-uuid' })]);
    expect(val.body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'VALIDATION_ERROR' });
    const noLoc = await push([op('product', 'create', { sku: 'MOV-Y', name: 'x', unitId: b.unitId, locationId: randomUUID() })]);
    expect(noLoc.body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'LOCATION_NOT_FOUND' });
    const noPrice = await push([op('product', 'create', { sku: 'MOV-Z', name: 'x', unitId: b.unitId, price: '-1' })]);
    expect(noPrice.body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'VALIDATION_ERROR' });
  });

  it('móvil push product.update: versión optimista, local id → servidor y permisos', async () => {
    const created = await push([op('product', 'create', { sku: 'MOV-UPD', name: 'Para editar', unitId: b.unitId }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]);
    const serverId = created.body.data.results[0].serverId;
    const v1 = (await admin.get(`/products/${serverId}`)).body.data.version;
    // por id local (cola offline) y por id de servidor
    const u1 = await push([op('product', 'update', { name: 'Editado', brand: 'SPC', version: v1, price: '5' }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]);
    expect(u1.body.data.results[0]).toMatchObject({ status: 'APPLIED', serverId });
    const after = (await admin.get(`/products/${serverId}`)).body.data;
    expect(after).toMatchObject({ name: 'Editado', brand: 'SPC', version: v1 + 1 });
    expect(after.prices.map((x: any) => Number(x.price))).toEqual([5]);
    // versión vencida: rechazo con VERSION_CONFLICT
    const stale = await push([op('product', 'update', { name: 'Otra', version: v1 }, serverId)]);
    expect(stale.body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'VERSION_CONFLICT' });
    // sin versión: validación
    expect((await push([op('product', 'update', { name: 'Sin versión' }, serverId)])).body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'VALIDATION_ERROR' });
    // producto inexistente
    expect((await push([op('product', 'update', { name: 'x', version: 1 }, randomUUID())])).body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'PRODUCT_NOT_FOUND' });
    // el vendedor (sin permisos de producto) no puede crear ni editar
    const f1 = await push([op('product', 'create', { sku: 'VEND-1', name: 'x', unitId: b.unitId })], vendToken, vendDevice);
    expect(f1.body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'FORBIDDEN' });
    const f2 = await push([op('product', 'update', { name: 'x', version: after.version }, serverId)], vendToken, vendDevice);
    expect(f2.body.data.results[0]).toMatchObject({ status: 'REJECTED', errorCode: 'FORBIDDEN' });
    expect((await admin.get('/products?search=VEND-1')).body.data).toHaveLength(0);
  });
});
