import ExcelJS from 'exceljs';
import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, PASSWORD, auth } from './helpers';

describe('Importación de datos (Excel / CSV)', () => {
  let ctx: Ctx; let api: Api; let t: Awaited<ReturnType<typeof createTenant>>; let b: Awaited<ReturnType<typeof seedBasics>>;
  beforeAll(async () => { ctx = await bootstrap(); t = await createTenant(ctx, 'Import'); api = client(ctx, t.token); b = await seedBasics(api); });
  afterAll(async () => { await ctx.close(); });

  const csv = (header: string[], rows: string[][], delim = ';') => Buffer.from('﻿' + [header, ...rows].map(r => r.join(delim)).join('\r\n'), 'utf8');
  const upload = (type: string, file: Buffer, name: string, query = '') =>
    ctx.http.post(`/api/v1/imports/${type}${query}`).set(auth(t.token)).attach('file', file, name);
  const xlsx = async (header: string[], rows: (string | number)[][]) => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Datos'); ws.addRow(header); rows.forEach(r => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };

  it('catálogo de tipos, plantilla xlsx/csv descargables y permisos', async () => {
    const types = (await api.get('/imports/types')).body.data;
    expect(types.map((x: any) => x.key)).toEqual(expect.arrayContaining(['products', 'suppliers', 'customers', 'categories', 'opening-stock']));
    const tpl = await ctx.http.get('/api/v1/imports/products/template').set(auth(t.token)).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(tpl.status).toBe(200); expect(tpl.headers['content-disposition']).toContain('plantilla-products.xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl.body as any);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Datos', 'Ejemplo', 'Instrucciones']);
    expect((wb.getWorksheet('Datos')!.getRow(1).values as any[]).slice(1)).toContain('codigos_barras');
    const c = await ctx.http.get('/api/v1/imports/suppliers/template?format=csv').set(auth(t.token));
    expect(c.text).toContain('rif;razon_social');
    expect((await ctx.http.get('/api/v1/imports/nada/template').set(auth(t.token))).status).toBe(404);
    // el vendedor no puede importar
    const u = await api.post('/users', { email: `imp-${Date.now()}@test.local`, fullName: 'Vendedor', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    const lg = await ctx.http.post('/api/v1/auth/login').send({ email: u.body.data.email, password: PASSWORD });
    expect((await client(ctx, lg.body.data.accessToken).get('/imports/types')).body.data).toEqual([]);
    const forb = await ctx.http.post('/api/v1/imports/products').set(auth(lg.body.data.accessToken)).attach('file', csv(['sku', 'nombre'], [['A', 'B']]), 'p.csv');
    expect(forb.status).toBe(404);
  });

  it('instancias: jerarquía dentro del mismo archivo y validación sin escribir', async () => {
    const f = csv(['codigo', 'nombre', 'instancia_padre', 'margen'], [['HIJA', 'Hija', 'PADRE', '25'], ['PADRE', 'Padre', '', '30'], ['MALA', 'Mala', 'NOEXISTE', ''], ['PADRE', 'Repetida', '', '']]);
    const v = await upload('categories', f, 'c.csv');
    expect(v.status).toBe(201);
    expect(v.body.data.committed).toBe(false);
    expect(v.body.data.summary).toMatchObject({ total: 4, errors: 2 });
    const errs = v.body.data.rows.filter((r: any) => r.errors.length);
    expect(errs.map((r: any) => r.row)).toEqual([4, 5]);
    expect(errs[0].errors[0]).toContain('NOEXISTE'); expect(errs[1].errors[0]).toContain('repetido');
    expect((await api.get('/categories')).body.data.find((c: any) => c.code === 'PADRE')).toBeUndefined(); // validar no escribe
    // commit con errores: rechazado y no importa nada
    const bad = await upload('categories', f, 'c.csv', '?mode=commit');
    expect(bad.status).toBe(422); expect(bad.body.error).toBe('IMPORT_HAS_ERRORS');
    // archivo correcto
    const ok = await upload('categories', csv(['codigo', 'nombre', 'instancia_padre', 'margen'], [['HIJA', 'Hija', 'PADRE', '25'], ['PADRE', 'Padre', '', '30']]), 'c.csv', '?mode=commit');
    expect(ok.status).toBe(201); expect(ok.body.data.result).toMatchObject({ created: 2, updated: 0 });
    const cats = (await api.get('/categories?limit=100')).body.data;
    const padre = cats.find((c: any) => c.code === 'PADRE'); const hija = cats.find((c: any) => c.code === 'HIJA');
    expect(hija.parentId).toBe(padre.id);
  });

  it('productos desde Excel: crea con códigos de barras, OEM y precio; reimportar omite o actualiza', async () => {
    const header = ['sku', 'nombre', 'instancia', 'unidad', 'impuesto', 'es_servicio', 'stock_minimo', 'codigos_barras', 'codigos_oem', 'precio', 'activo'];
    const f = await xlsx(header, [
      ['IMP-001', 'Pastillas de freno', 'PADRE', 'UND', 'IVA_GENERAL', 'NO', 5, '7591111111111;7591111111112', '04465-0K290', '25,50', 'SI'],
      ['IMP-002', 'Servicio de montaje', '', '', 'EXENTO', 'SI', '', '', '', '10', ''],
    ]);
    const v = await upload('products', f, 'p.xlsx');
    expect(v.body.data.summary).toMatchObject({ total: 2, create: 2, errors: 0 });
    const c = await upload('products', f, 'p.xlsx', '?mode=commit');
    expect(c.status).toBe(201); expect(c.body.data.result.created).toBe(2);
    const prod = (await api.get('/products?search=7591111111112')).body.data[0];
    const full = (await api.get(`/products/${prod.id}`)).body.data;
    expect(full).toMatchObject({ sku: 'IMP-001', unitId: b.unitId, minStock: '5' });
    expect(full.barcodes.sort()).toEqual(['7591111111111', '7591111111112']); expect(full.references[0].code).toBe('04465-0K290');
    expect(full.prices[0].price).toBe('25.5'); // «25,50» con coma decimal
    expect((await api.get('/products?search=IMP-002')).body.data[0].isService).toBe(true);
    // reimportar: por defecto se omite
    const again = await upload('products', f, 'p.xlsx');
    expect(again.body.data.summary).toMatchObject({ create: 0, skip: 2, update: 0 });
    // con onExisting=update: cambia el nombre y el precio, conserva lo que va vacío, y no duplica códigos
    const f2 = await xlsx(['sku', 'nombre', 'codigos_barras', 'precio'], [['IMP-001', 'Pastillas delanteras', '7591111111111;7599999999999', '30']]);
    const up = await upload('products', f2, 'p.xlsx', '?mode=commit&onExisting=update');
    expect(up.body.data.result).toMatchObject({ created: 0, updated: 1 });
    const after = (await api.get(`/products/${prod.id}`)).body.data;
    expect(after.name).toBe('Pastillas delanteras'); expect(after.categoryId).not.toBeNull(); // instancia intacta
    expect(after.barcodes.sort()).toEqual(['7591111111111', '7591111111112', '7599999999999']);
    expect(after.prices[0].price).toBe('30');
  });

  it('productos: errores claros por fila (referencias inexistentes, números, duplicados, códigos ajenos)', async () => {
    const f = csv(['sku', 'nombre', 'instancia', 'unidad', 'impuesto', 'stock_minimo', 'stock_maximo', 'codigos_barras', 'es_servicio'], [
      ['', 'Sin sku', '', '', '', '', '', '', ''],
      ['E-1', 'Instancia mala', 'ZZZ', '', '', '', '', '', ''],
      ['E-2', 'Unidad mala', '', 'XXX', 'NOEXISTE', '', '', '', ''],
      ['E-3', 'Mínimo > máximo', '', '', '', '10', '5', '', ''],
      ['E-4', 'Número malo', '', '', '', 'abc', '', '', 'QUIZAS'],
      ['E-5', 'Barras ajeno', '', '', '', '', '', '7591111111111', ''],
      ['E-6', 'Ok', '', '', '', '', '', '', ''],
      ['E-6', 'Duplicado', '', '', '', '', '', '', ''],
    ]);
    const v = (await upload('products', f, 'e.csv')).body.data;
    expect(v.summary.errors).toBe(7);
    const by = (n: number) => v.rows.find((r: any) => r.row === n).errors.join(' | ');
    expect(by(2)).toContain('SKU es obligatorio'); expect(by(3)).toContain('instancia «ZZZ»'); expect(by(4)).toContain('unidad «XXX»'); expect(by(4)).toContain('impuesto «NOEXISTE»');
    expect(by(5)).toContain('stock_maximo no puede ser menor'); expect(by(6)).toContain('stock_minimo'); expect(by(6)).toContain('es_servicio'); expect(by(7)).toContain('ya pertenece a otro producto'); expect(by(9)).toContain('repetido');
    // columnas obligatorias ausentes y tipos de archivo
    const noCol = await upload('products', csv(['nombre'], [['x']]), 'x.csv'); expect(noCol.status).toBe(422); expect(noCol.body.error).toBe('MISSING_COLUMNS');
    expect((await upload('products', Buffer.from('x'), 'x.pdf')).body.error).toBe('INVALID_FILE');
    expect((await upload('products', csv(['sku', 'nombre'], []), 'v.csv')).body.error).toBe('EMPTY_FILE');
  });

  it('proveedores y clientes: RIF validado y normalizado; coma decimal; actualización por RIF', async () => {
    const rif1 = uniqueRif(), rif2 = uniqueRif();
    const f = csv(['rif', 'razon_social', 'tipo_persona', 'dias_credito', 'retencion_iva', 'correo'], [
      [rif1.replace(/-/g, ''), 'Proveedor A, C.A.', 'JURIDICA', '15', '75', 'a@x.com'], [rif2, 'Proveedor B', 'NATURAL', '0', '100,00', ''], ['J-12345678-0', 'RIF malo', '', '', '', 'mal'],
    ]);
    const v = (await upload('suppliers', f, 's.csv')).body.data;
    expect(v.summary).toMatchObject({ total: 3, errors: 1 });
    expect(v.rows.find((r: any) => r.row === 4).errors.join()).toContain('RIF inválido');
    const ok = await upload('suppliers', csv(['rif', 'razon_social', 'tipo_persona', 'dias_credito', 'retencion_iva'], [[rif1.replace(/-/g, ''), 'Proveedor A, C.A.', 'JURIDICA', '15', '75'], [rif2, 'Proveedor B', 'NATURAL', '0', '100,00']]), 's.csv', '?mode=commit');
    expect(ok.body.data.result.created).toBe(2);
    const sup = (await api.get('/suppliers?limit=100')).body.data.find((s: any) => s.rif === rif1);
    expect(sup).toMatchObject({ legalName: 'Proveedor A, C.A.', creditDays: 15, retentionIvaPct: '75' }); // RIF normalizado con guiones
    const upd = await upload('suppliers', csv(['rif', 'razon_social', 'dias_credito'], [[rif1, 'Proveedor A Renombrado', '30']]), 's.csv', '?mode=commit&onExisting=update');
    expect(upd.body.data.result).toMatchObject({ updated: 1 });
    expect((await api.get(`/suppliers/${sup.id}`)).body.data).toMatchObject({ legalName: 'Proveedor A Renombrado', creditDays: 30, retentionIvaPct: '75' });
    const cus = await upload('customers', csv(['rif', 'razon_social', 'limite_credito', 'lista_precios'], [[uniqueRif(), 'Cliente 1', '1.500,50', 'DETAL']]), 'c.csv', '?mode=commit');
    expect(cus.status).toBe(201);
    expect((await api.get('/customers')).body.data[0]).toMatchObject({ creditLimit: '1500.5' });
  });

  it('existencias iniciales: crea y confirma una carga inicial por depósito con costo promedio y lotes', async () => {
    await api.patch('/companies/current', { features: { lots: true, expiry: true } });
    const lotProd = await b.product('IMP-LOT', { trackingMode: 'LOT', hasExpiry: true });
    const f = csv(['sku', 'deposito', 'cantidad', 'costo_unitario', 'lote', 'vencimiento'], [
      ['IMP-001', 'PRINCIPAL', '10', '5,25', '', ''], ['IMP-001', 'SEC', '4', '5,25', '', ''], ['IMP-LOT', 'PRINCIPAL', '6', '2', 'L1', '2030-01-10'], ['IMP-LOT', 'PRINCIPAL', '6', '2', 'L2', '2029-06-01'],
    ]);
    const v = (await upload('opening-stock', f, 'e.csv')).body.data;
    expect(v.summary).toMatchObject({ errors: 0, total: 4 });
    const c = await upload('opening-stock', f, 'e.csv', '?mode=commit');
    expect(c.status).toBe(201); expect(c.body.data.result.note).toContain('2 documento');
    const s1 = (await api.get(`/products/${(await api.get('/products?search=IMP-001')).body.data[0].id}/stock`)).body.data;
    expect(s1.totalQuantity).toBe('14'); expect(s1.avgCost).toBe('5.25');
    expect((await api.get(`/products/${lotProd}/stock`)).body.data.totalQuantity).toBe('12');
    const charges = (await api.get('/inventory/charges?status=CONFIRMED')).body.data;
    expect(charges).toHaveLength(2); expect(charges[0].notes).toContain('Carga inicial');
    // el producto ya tiene existencias → advertencia, y errores de lote/depósito
    const w = (await upload('opening-stock', csv(['sku', 'deposito', 'cantidad', 'costo_unitario', 'lote', 'vencimiento'], [['IMP-001', 'PRINCIPAL', '1', '1', '', ''], ['IMP-LOT', 'NOPE', '1', '1', '', '']]), 'w.csv')).body.data;
    expect(w.rows.find((r: any) => r.row === 2).warnings.join()).toContain('ya tiene existencias');
    expect(w.rows.find((r: any) => r.row === 3).errors.join()).toContain('depósito «NOPE»');
    const lotErr = (await upload('opening-stock', csv(['sku', 'deposito', 'cantidad', 'costo_unitario'], [['IMP-LOT', 'PRINCIPAL', '1', '1']]), 'l.csv')).body.data;
    expect(lotErr.rows[0].errors.join()).toContain('lotes');
  });

  it('existencias iniciales con seriales; un archivo de otra empresa no ve productos ajenos', async () => {
    await api.patch('/companies/current', { features: { serials: true } });
    await b.product('IMP-SER', { trackingMode: 'SERIAL' });
    const ok = await upload('opening-stock', csv(['sku', 'deposito', 'costo_unitario', 'seriales'], [['IMP-SER', 'PRINCIPAL', '9', 'S1|S2|S3']]), 's.csv', '?mode=commit');
    expect(ok.status).toBe(201);
    const ser = (await api.get('/inventory/serials?status=IN_STOCK')).body.data.map((x: any) => x.serialNo).sort();
    expect(ser).toEqual(['S1', 'S2', 'S3']);
    const dup = (await upload('opening-stock', csv(['sku', 'deposito', 'costo_unitario', 'seriales'], [['IMP-SER', 'PRINCIPAL', '9', 'S3|S4']]), 's.csv')).body.data;
    expect(dup.rows[0].errors.join()).toContain('S3');
    const other = await createTenant(ctx, 'OtraImp');
    const r = await ctx.http.post('/api/v1/imports/opening-stock').set(auth(other.token)).attach('file', csv(['sku', 'deposito', 'costo_unitario', 'cantidad'], [['IMP-001', 'PRINCIPAL', '1', '1']]), 'o.csv');
    expect(r.body.data.rows[0].errors.join()).toContain('«IMP-001» no existe');
  });
});
