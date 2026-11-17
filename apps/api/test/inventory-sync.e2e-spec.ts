import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrap, Ctx, createTenant, client, Api, auth, seedBasics } from './helpers';

describe('Importar inventario (sincronización recurrente, una hoja por depósito)', () => {
  let ctx: Ctx; let api: Api; let t: Awaited<ReturnType<typeof createTenant>>;
  beforeAll(async () => { ctx = await bootstrap(); t = await createTenant(ctx, 'InvSync'); api = client(ctx, t.token); });
  afterAll(async () => { await ctx.close(); });

  const upload = (file: Buffer, query = '') => ctx.http.post(`/api/v1/imports/inventory-sync${query}`).set(auth(t.token)).attach('file', file, 'INVENTARIO.xlsx');
  /** Imita el archivo del cliente: filas de título antes del encabezado, encabezado con espacios, hojas con columnas distintas. */
  const book = async (sheets: Record<string, { header: string[]; lead: number; rows: (string | number | null)[][] }>) => {
    const wb = new ExcelJS.Workbook();
    for (const [name, s] of Object.entries(sheets)) {
      const ws = wb.addWorksheet(name);
      for (let i = 0; i < s.lead; i++) ws.addRow([]);
      ws.addRow(s.header); s.rows.forEach(r => ws.addRow(r));
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const stockOf = async (sku: string) => {
    const p = (await api.get(`/products?search=${encodeURIComponent(sku)}`)).body.data.find((x: any) => x.sku === sku);
    return p ? (await api.get(`/products/${p.id}/stock`)).body.data : null;
  };
  const H5 = ['CODIGO ', 'DESCRIPCION ', 'MARCA ', 'CANTIDAD ', 'Precio_Vta'];

  it('crea depósitos y productos, suma repetidos, valida sin escribir y es idempotente', async () => {
    const f = await book({
      'PASILLO A': { header: H5, lead: 7, rows: [['69-8317', 'CARBONERA ARRANQUE FORD ', 'MOTTA', 1, 0], ['69-204', 'CARBONERA X', 'SPC', 4, 12.5], ['69-204', 'CARBONERA X', 'SPC', 3, 0], ['E5TE', 'ROTOR', 'MOTTA', null, 0]] },
      'BAÑO': { header: ['CODIGO ', 'DESCRIPCION ', 'MARCA ', 'CANTIDAD '], lead: 2, rows: [[96424027, 'AMORTIGUADOR TRASERO SPARK ', 'KMD ', 4], ['69-204', 'CARBONERA X', 'SPC', 2]] },
    });
    const v = await upload(f);
    expect(v.status).toBe(201);
    expect(v.body.data.summary).toMatchObject({ errors: 0, total: 6 });
    expect(v.body.data.committed).toBe(false);
    expect(await stockOf('69-8317')).toBeNull(); // validar no escribe

    const c = await upload(f, '?mode=commit');
    expect(c.status).toBe(201);
    expect(c.body.data.result.created).toBe(4); // 4 SKU distintos (69-204 está en dos hojas y se crea una vez)
    expect((await stockOf('69-204')).totalQuantity).toBe('9'); // 4+3 en PASILLO A y 2 en BAÑO
    expect((await stockOf('69-8317')).totalQuantity).toBe('1');
    expect((await stockOf('96424027')).totalQuantity).toBe('4');
    const whs = (await api.get('/warehouses')).body.data.map((w: any) => w.code);
    expect(whs).toEqual(expect.arrayContaining(['PASILLO_A', 'BANO']));

    // segunda subida idéntica: nada que hacer
    const again = (await upload(f)).body.data;
    expect(again.summary).toMatchObject({ errors: 0, create: 0, update: 0 });
  });

  it('subida posterior ajusta existencias al nuevo conteo (varias hojas = varios depósitos) y no toca lo que no aparece', async () => {
    const f = await book({
      'PASILLO A': { header: H5, lead: 7, rows: [['69-8317', 'CARBONERA ARRANQUE FORD', 'MOTTA', 6, 0], ['69-204', 'CARBONERA X', 'SPC', 1, 0]] },
      'BAÑO': { header: ['CODIGO ', 'DESCRIPCION ', 'MARCA ', 'CANTIDAD '], lead: 2, rows: [['69-204', 'CARBONERA X', 'SPC', 2]] },
    });
    const v = (await upload(f)).body.data;
    expect(v.summary).toMatchObject({ errors: 0, update: 2, create: 0 });
    const c = await upload(f, '?mode=commit');
    expect(c.status).toBe(201); expect(c.body.data.result.note).toContain('1 ajuste');
    expect((await stockOf('69-8317')).totalQuantity).toBe('6');
    expect((await stockOf('69-204')).totalQuantity).toBe('3'); // 1 en PASILLO A + 2 en BAÑO (intacto)
    expect((await stockOf('96424027')).totalQuantity).toBe('4'); // no aparecía en el archivo
  });

  it('reporta errores por fila y exige la columna CANTIDAD en cada hoja', async () => {
    const bad = await book({ 'PASILLO A': { header: H5, lead: 1, rows: [['', 'sin código', 'X', 1, 0], ['Z-1', 'neg', 'X', -5, 0], ['Z-2', 'precio', 'X', 1, 'abc']] } });
    const v = (await upload(bad)).body.data;
    expect(v.summary.errors).toBe(3);
    expect((await upload(bad, '?mode=commit')).body.error).toBe('IMPORT_HAS_ERRORS');
    const noQty = await book({ 'PASILLO A': { header: ['CODIGO', 'DESCRIPCION'], lead: 0, rows: [['A', 'B']] } });
    const r = await upload(noQty); expect(r.status).toBe(422); expect(r.body.message).toContain('cantidad');
  });

  const REAL = resolve(__dirname, '../../../../../INVENTARIO ELECTRO SUR.xlsx');
  (existsSync(REAL) ? it : it.skip)('archivo real «INVENTARIO ELECTRO SUR.xlsx»: carga completa e idempotente', async () => {
    const buf = readFileSync(REAL);
    const v = (await upload(buf)).body.data;
    expect(v.summary.errors).toBe(0);
    const c = await upload(buf, '?mode=commit');
    expect(c.status).toBe(201);
    const again = (await upload(buf)).body.data;
    expect(again.summary).toMatchObject({ errors: 0, create: 0, update: 0 });
  }, 120_000);
});

describe('Importar inventario: una hoja, Lista 1 en USD y listas 2 y 3 en Bs con % y tasa BCV', () => {
  let ctx: Ctx; let api: Api; let t: Awaited<ReturnType<typeof createTenant>>; let b: Awaited<ReturnType<typeof seedBasics>>; let l1: string; let l2: string; let l3: string;
  beforeAll(async () => {
    ctx = await bootstrap(); t = await createTenant(ctx, 'InvPrecios'); api = client(ctx, t.token); b = await seedBasics(api);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today });
    l1 = (await api.post('/price-lists', { code: 'P1', name: 'Precio 1', currencyId: b.usd, isDefault: true })).body.data.id;
    l2 = (await api.post('/price-lists', { code: 'P2', name: 'Precio 2', currencyId: b.ves, baseListId: l1, markupPercent: '30' })).body.data.id;
    l3 = (await api.post('/price-lists', { code: 'P3', name: 'Precio 3', currencyId: b.ves, baseListId: l1, markupPercent: '50' })).body.data.id;
  });
  afterAll(async () => { await ctx.close(); });
  const upload = async (rows: (string | number)[][], query = '') => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('INVENTARIO');
    ws.addRow([]); ws.addRow(['LISTA GENERAL']); ws.addRow(['CODIGO ', 'DESCRIPCION ', 'MARCA ', 'CANTIDAD ', 'Precio_Vta']); rows.forEach(r => ws.addRow(r));
    return ctx.http.post(`/api/v1/imports/inventory-sync${query}`).set(auth(t.token)).attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'INV.xlsx');
  };
  const priceOf = async (sku: string, list: string) => {
    const p = (await api.get(`/products?search=${sku}`)).body.data.find((x: any) => x.sku === sku);
    const r = (await api.get(`/products/${p.id}`)).body.data.prices.find((x: any) => x.priceListId === list);
    return r ? Number(r.price) : null;
  };

  it('una hoja usa el depósito principal; P1 en USD y P2/P3 = P1 × (1+%) × tasa; reimportar no cambia nada', async () => {
    const rows = [['A-1', 'Producto A', 'KMD', 5, 10], ['A-2', 'Producto B', 'KMD', 2, 0]];
    const c = await upload(rows, '?mode=commit');
    expect(c.status).toBe(201);
    expect(c.body.data.result.note).toContain('P2 1 precio');
    expect(await priceOf('A-1', l1)).toBe(10);
    expect(await priceOf('A-1', l2)).toBe(520);   // 10 × 1,30 × 40
    expect(await priceOf('A-1', l3)).toBe(600);   // 10 × 1,50 × 40
    expect(await priceOf('A-2', l1)).toBeNull();   // precio 0: no se asigna
    expect(await priceOf('A-2', l2)).toBeNull();
    const w = (await api.get('/warehouses')).body.data;
    expect(w.map((x: any) => x.code)).not.toContain('INVENTARIO'); // la hoja no crea depósito
    expect((await api.get(`/products/${(await api.get('/products?search=A-1')).body.data[0].id}/stock`)).body.data.totalQuantity).toBe('5');
    expect((await upload(rows)).body.data.summary).toMatchObject({ errors: 0, create: 0, update: 0 });
  });

  it('cambia solo la Lista 1 desde el Excel, agrega productos nuevos, ajusta cantidad y recalcula Bs con la tasa nueva', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '50', date: today }); // la manual del día prevalece
    const rows = [['A-1', 'Producto A', 'KMD', 8, 12], ['A-2', 'Producto B', 'KMD', 2, 0], ['A-3', 'Producto C', 'KMD', 1, 4]];
    const v = (await upload(rows)).body.data;
    expect(v.summary).toMatchObject({ errors: 0, create: 1, update: 1 }); // A-3 nuevo; A-1 cambia; A-2 sin cambio
    const c = await upload(rows, '?mode=commit');
    expect(c.status).toBe(201);
    expect(await priceOf('A-1', l1)).toBe(12);
    expect(await priceOf('A-1', l2)).toBe(780);   // 12 × 1,30 × 50
    expect(await priceOf('A-3', l3)).toBe(300);   // 4 × 1,50 × 50
    expect((await api.get(`/products/${(await api.get('/products?search=A-1')).body.data[0].id}/stock`)).body.data.totalQuantity).toBe('8');
    // el ajuste deja traza en el kardex
    const adj = (await api.get('/inventory/adjustments?status=CONFIRMED')).body.data;
    expect(adj.length).toBeGreaterThanOrEqual(2);
  });

  it('el recálculo a demanda sigue la tasa y valida la configuración de listas', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '60', date: today });
    const r = await api.post('/products/prices/recalculate', {});
    expect(r.status).toBe(201);
    expect(await priceOf('A-1', l2)).toBe(936);   // 12 × 1,30 × 60
    expect((await api.post('/price-lists', { code: 'X', name: 'X', currencyId: b.ves, baseListId: l1 })).status).toBe(422); // % obligatorio
    expect((await api.post('/price-lists', { code: 'Y', name: 'Y', currencyId: b.ves, baseListId: l2, markupPercent: '5' })).status).toBe(422); // sin cadenas
  });
});
