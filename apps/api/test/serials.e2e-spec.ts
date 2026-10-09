import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif } from './helpers';

describe('Control por seriales', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let tenant: Awaited<ReturnType<typeof createTenant>>;
  beforeAll(async () => {
    ctx = await bootstrap();
    tenant = await createTenant(ctx, 'Seriales'); api = client(ctx, tenant.token); b = await seedBasics(api);
  });
  afterAll(async () => { await ctx.close(); });

  const serialRows = (productId: string) => ctx.prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.company_id', ${tenant.companyId}, true)`;
    return tx.$queryRaw<{ serial_no: string; status: string; wh: string | null }[]>`SELECT serial_no, status, warehouse_id AS wh FROM product_serials WHERE product_id = ${productId}::uuid ORDER BY serial_no`;
  });
  const stockQty = async (p: string) => (await api.get(`/products/${p}/stock`)).body.data;
  const doc = async (path: string, body: object) => { const d = await api.post(path, body); expect(d.status).toBe(201); return d.body.data.id as string; };
  const confirm = (path: string, id: string) => api.post(`${path}/${id}/confirm`);

  /** Invariante: existencia por depósito = nº de seriales IN_STOCK en ese depósito. */
  const invariant = async (p: string) => {
    const s = await stockQty(p); const rows = await serialRows(p);
    for (const w of s.warehouses) expect(Number(w.quantity)).toBe(rows.filter(r => r.status === 'IN_STOCK' && r.wh === w.warehouseId).length);
    expect(Number(s.totalQuantity)).toBe(rows.filter(r => r.status === 'IN_STOCK').length);
  };

  it('desactivado por defecto: no se puede crear un producto por seriales hasta habilitarlo', async () => {
    const r = await api.post('/products', { sku: 'S0', name: 'x', unitId: b.unitId, trackingMode: 'SERIAL' });
    expect(r.status).toBe(422); expect(r.body.error).toBe('FEATURE_DISABLED');
    expect((await api.patch('/companies/current', { features: { serials: true } })).status).toBe(200);
  });

  it('cargo con seriales: la cantidad sale de los seriales; no admite repetidos ni existentes', async () => {
    const p = await b.product('SER-1', { trackingMode: 'SERIAL' });
    const noSerials = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '2', unitCost: '10' }] });
    expect(noSerials.status).toBe(422); expect(noSerials.body.details[0].code).toBe('SERIALS_REQUIRED');
    const dup = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, unitCost: '10', serials: ['A1', 'A1'] }] });
    expect(dup.status).toBe(422);
    const id = await doc('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '99', unitCost: '10', serials: ['A1', 'A2', 'A3'] }] });
    const c = await confirm('/inventory/charges', id);
    expect(c.status).toBe(201); expect(c.body.data.lines[0].quantity).toBe('3'); // ignora la cantidad enviada
    expect((await stockQty(p)).totalQuantity).toBe('3'); expect((await stockQty(p)).avgCost).toBe('10');
    expect((await serialRows(p)).map(r => r.status)).toEqual(['IN_STOCK', 'IN_STOCK', 'IN_STOCK']);
    // un serial que ya está en existencia no puede volver a ingresar
    const again = await doc('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, unitCost: '10', serials: ['A3', 'A4'] }] });
    const r = await confirm('/inventory/charges', again);
    expect(r.status).toBe(422); expect(r.body.error).toBe('SERIAL_ALREADY_IN_STOCK');
    expect((await serialRows(p)).map(x => x.serial_no)).toEqual(['A1', 'A2', 'A3']); // nada se creó a medias
    await invariant(p);
  });

  it('descargo, traslado y anulación mueven exactamente los seriales indicados', async () => {
    const p = await b.product('SER-2', { trackingMode: 'SERIAL' });
    await confirm('/inventory/charges', await doc('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, unitCost: '5', serials: ['B1', 'B2', 'B3', 'B4'] }] }));
    // descargo de B1
    const dis = await doc('/inventory/discharges', { warehouseId: b.w1, lines: [{ productId: p, serials: ['B1'] }] });
    expect((await confirm('/inventory/discharges', dis)).status).toBe(201);
    expect((await serialRows(p)).find(r => r.serial_no === 'B1')).toMatchObject({ status: 'SCRAPPED', wh: null });
    // no se puede descargar de nuevo ni uno inexistente
    for (const sn of ['B1', 'ZZZ']) {
      const x = await doc('/inventory/discharges', { warehouseId: b.w1, lines: [{ productId: p, serials: [sn] }] });
      const r = await confirm('/inventory/discharges', x);
      expect(r.status).toBe(422); expect(r.body.error).toBe('SERIAL_NOT_IN_STOCK');
    }
    // traslado de B2 y B3 a otro depósito
    const tr = await doc('/inventory/transfers', { warehouseId: b.w1, toWarehouseId: b.w2, lines: [{ productId: p, serials: ['B2', 'B3'] }] });
    expect((await confirm('/inventory/transfers', tr)).status).toBe(201);
    let rows = await serialRows(p);
    expect(rows.filter(r => r.wh === b.w2).map(r => r.serial_no)).toEqual(['B2', 'B3']);
    await invariant(p);
    // B2 ya no está en el depósito origen
    const bad = await doc('/inventory/discharges', { warehouseId: b.w1, lines: [{ productId: p, serials: ['B2'] }] });
    expect((await confirm('/inventory/discharges', bad)).body.error).toBe('SERIAL_NOT_IN_STOCK');
    // anular el traslado devuelve B2 y B3 al origen; anular el descargo reintegra B1
    expect((await api.post(`/inventory/transfers/${tr}/cancel`, { reason: 'Traslado erróneo' })).status).toBe(201);
    expect((await api.post(`/inventory/discharges/${dis}/cancel`, { reason: 'Descargo erróneo' })).status).toBe(201);
    rows = await serialRows(p);
    expect(rows.every(r => r.status === 'IN_STOCK' && r.wh === b.w1)).toBe(true);
    expect(rows).toHaveLength(4);
    await invariant(p);
    // trazabilidad: historial del serial B2
    const h = await api.get(`/inventory/serials/history?productId=${p}&serialNo=B2`);
    expect(h.status).toBe(200);
    expect(h.body.data.movements.map((m: any) => m.docType)).toEqual(['CHARGE', 'TRANSFER', 'TRANSFER', 'TRANSFER', 'TRANSFER']);
    const list = await api.get(`/inventory/serials?productId=${p}&status=IN_STOCK`);
    expect(list.body.meta.total).toBe(4);
  });

  it('ajuste físico: faltantes pasan a SCRAPPED y sobrantes ingresan al costo promedio', async () => {
    const p = await b.product('SER-3', { trackingMode: 'SERIAL' });
    await confirm('/inventory/charges', await doc('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, unitCost: '8', serials: ['C1', 'C2', 'C3'] }] }));
    // conteo: están C1 y C3, falta C2 y aparece C9 (no registrado)
    const adj = await doc('/inventory/adjustments', { warehouseId: b.w1, lines: [{ productId: p, serials: ['C1', 'C3', 'C9'] }] });
    const c = await confirm('/inventory/adjustments', adj);
    expect(c.status).toBe(201);
    expect(c.body.data.lines[0]).toMatchObject({ systemQty: '3', countedQty: '3', difference: '0' });
    const rows = await serialRows(p);
    expect(rows.map(r => `${r.serial_no}:${r.status}`)).toEqual(['C1:IN_STOCK', 'C2:SCRAPPED', 'C3:IN_STOCK', 'C9:IN_STOCK']);
    await invariant(p);
    // el sobrante entró al costo promedio vigente
    const k = (await api.get(`/products/${p}/kardex?docType=ADJUSTMENT`)).body.data;
    expect(k).toHaveLength(2); expect(k.map((m: any) => m.unitCost)).toEqual(['8', '8']);
    // anular el ajuste lo revierte todo
    await api.post(`/inventory/adjustments/${adj}/cancel`, { reason: 'Conteo repetido' });
    expect((await serialRows(p)).map(r => `${r.serial_no}:${r.status}`)).toEqual(['C1:IN_STOCK', 'C2:IN_STOCK', 'C3:IN_STOCK', 'C9:SCRAPPED']);
    await invariant(p);
  });

  it('CONCURRENCIA: el mismo serial no se puede descargar dos veces a la vez', async () => {
    const p = await b.product('SER-4', { trackingMode: 'SERIAL' });
    await confirm('/inventory/charges', await doc('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, unitCost: '3', serials: ['D1', 'D2'] }] }));
    const ids = await Promise.all([1, 2].map(() => doc('/inventory/discharges', { warehouseId: b.w1, lines: [{ productId: p, serials: ['D1'] }] })));
    const res = await Promise.all(ids.map(id => confirm('/inventory/discharges', id)));
    expect(res.map(r => r.status).sort()).toEqual([201, 422]);
    await invariant(p);
  });

  it('compras: nota de entrega con seriales, devolución de algunos y anulación', async () => {
    const p = await b.product('SER-5', { trackingMode: 'SERIAL' });
    const supplierId = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor Seriales' })).body.data.id;
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }) });
    const base = { supplierId, warehouseId: b.w1, currencyId: b.usd };
    // sin seriales no se puede recibir
    const bad = await api.post('/purchases/delivery-notes', { ...base, lines: [{ productId: p, quantity: '2', unitCost: '50' }] });
    expect(bad.status).toBe(422); expect(bad.body.details[0].code).toBe('SERIALS_REQUIRED');
    const mismatch = await api.post('/purchases/delivery-notes', { ...base, lines: [{ productId: p, quantity: '3', unitCost: '50', serials: ['E1', 'E2'] }] });
    expect(mismatch.status).toBe(422); expect(mismatch.body.details[0].code).toBe('SERIAL_COUNT_MISMATCH');
    const dn = (await api.post('/purchases/delivery-notes', { ...base, lines: [{ productId: p, quantity: '3', unitCost: '50', serials: ['E1', 'E2', 'E3'] }] })).body.data;
    expect((await api.post(`/purchases/delivery-notes/${dn.id}/confirm`)).status).toBe(201);
    expect((await stockQty(p)).totalQuantity).toBe('3');
    // devolución de E2 (debe indicar el serial)
    const noSer = await api.post('/purchases/delivery-note-returns', { ...base, parentId: dn.id, lines: [{ productId: p, quantity: '1', unitCost: '50', parentLineId: dn.lines[0].id }] });
    expect(noSer.status).toBe(422);
    const ret = (await api.post('/purchases/delivery-note-returns', { ...base, parentId: dn.id, lines: [{ productId: p, quantity: '1', unitCost: '50', parentLineId: dn.lines[0].id, serials: ['E2'] }] })).body.data;
    expect((await api.post(`/purchases/delivery-note-returns/${ret.id}/confirm`)).status).toBe(201);
    expect((await serialRows(p)).find(r => r.serial_no === 'E2')).toMatchObject({ status: 'RETURNED', wh: null });
    await invariant(p);
    await api.post(`/purchases/delivery-note-returns/${ret.id}/cancel`, { reason: 'Devolución errónea' });
    await invariant(p);
    expect((await api.post(`/purchases/delivery-notes/${dn.id}/cancel`, { reason: 'No llegó' })).status).toBe(201);
    expect((await stockQty(p)).totalQuantity).toBe('0');
    expect((await serialRows(p)).every(r => r.status === 'RETURNED')).toBe(true); // reversa de entrada = devolución al proveedor
  });
});
