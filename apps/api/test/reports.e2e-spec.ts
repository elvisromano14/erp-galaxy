import ExcelJS from 'exceljs';
import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, PASSWORD, auth } from './helpers';

/** «Hoy» como lo ve el sistema (Caracas); con UTC las pruebas fallarían después de las 8 p. m. */
const iso = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
/** Compara campos numéricos ignorando ceros decimales ('232.0000' = 232). */
const eqNum = (obj: Record<string, any>, exp: Record<string, number>) => { for (const [k, v] of Object.entries(exp)) expect(Number(obj[k])).toBe(v); };

describe('Reportes: consulta, exportación y bitácora', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let t: Awaited<ReturnType<typeof createTenant>>;
  let exempt: string; let supplierId: string; let supplier2: string; let pA: string; let pB: string; let catId: string;
  beforeAll(async () => {
    ctx = await bootstrap();
    t = await createTenant(ctx, 'Reportes'); api = client(ctx, t.token); b = await seedBasics(api);
    exempt = (await api.get('/taxes?limit=100')).body.data.find((x: any) => x.code === 'EXENTO').id;
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: '2020-01-01' }); // tasa de la moneda de valoración
    catId = (await api.post('/categories', { code: 'FR', name: 'Frenos' })).body.data.id;
    pA = await b.product('REP-A', { categoryId: catId, minStock: '10', maxStock: '30' });
    pB = await b.product('REP-B', { minStock: '0' });
    supplierId = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor Uno', creditDays: 15 })).body.data.id;
    supplier2 = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor Dos' })).body.data.id;
    const ch = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: pA, quantity: '3', unitCost: '10' }, { productId: pB, quantity: '100', unitCost: '1' }] });
    await api.post(`/inventory/charges/${ch.body.data.id}/confirm`);
  });
  afterAll(async () => { await ctx.close(); });

  const get = (path: string) => api.get(`/reports${path}`);
  const rowsOf = (r: any) => r.body.data.rows as Record<string, any>[];

  /** Compra a crédito en Bs con fecha atrasada (para vencimientos). */
  const purchase = async (supplier: string, docDate: string, qty: number, cost: number, creditDays = 15, product = pB) => {
    const d = await api.post('/purchases', { supplierId: supplier, warehouseId: b.w1, currencyId: b.ves, docDate, supplierDocNo: `F-${docDate}-${qty}`, paymentCondition: 'CREDIT', creditDays, lines: [{ productId: product, quantity: String(qty), unitCost: String(cost), taxId: exempt }] });
    expect(d.status).toBe(201);
    const c = await api.post(`/purchases/${d.body.data.id}/confirm`);
    expect(c.status).toBe(201);
    return c.body.data;
  };

  it('el catálogo respeta permisos y funciones activas (lotes/seriales)', async () => {
    const cat = (await get('')).body.data;
    const ids = cat.map((r: any) => `${r.category}/${r.id}`);
    expect(ids).toEqual(expect.arrayContaining(['inventory/products', 'suppliers/aging', 'purchases/list', 'categories/inventory']));
    expect(ids).not.toContain('inventory/lots-expiry'); expect(ids).not.toContain('inventory/serials');
    expect(cat.find((r: any) => r.id === 'statement').required).toEqual(['supplierId']);
    // un vendedor no tiene reportes; compras ve proveedores/compras pero no clientes
    const mk = async (role: string) => {
      const email = `${role.toLowerCase()}-${Date.now()}@test.local`;
      await api.post('/users', { email, fullName: role, password: PASSWORD, roleCodes: [role] });
      const lg = await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD });
      return client(ctx, lg.body.data.accessToken);
    };
    const v = await mk('VENDEDOR'); const c = await mk('COMPRAS');
    expect((await v.get('/reports')).body.data).toEqual([]);
    expect((await v.get('/reports/inventory/products')).status).toBe(403);
    const cids = (await c.get('/reports')).body.data.map((r: any) => r.category);
    expect(cids).toEqual(expect.arrayContaining(['suppliers', 'purchases'])); expect(cids).not.toContain('customers');
    // activar lotes/seriales hace aparecer sus reportes
    await api.patch('/companies/current', { features: { lots: true, serials: true } });
    const after = (await get('')).body.data.map((r: any) => `${r.category}/${r.id}`);
    expect(after).toEqual(expect.arrayContaining(['inventory/lots-expiry', 'inventory/serials']));
  });

  it('JSON: listado de productos con existencia y filtros; reporte inexistente 404; filtro obligatorio 422', async () => {
    const r = await get('/inventory/products');
    expect(r.status).toBe(200);
    const row = rowsOf(r).find(x => x.sku === 'REP-A')!;
    expect(row.category).toBe('Frenos'); eqNum(row, { min_stock: 10, stock: 3 });
    expect(r.body.data.columns.map((c: any) => c.key)).toContain('avg_cost');
    expect(rowsOf(await get(`/inventory/products?categoryId=${catId}`)).map(x => x.sku)).toEqual(['REP-A']);
    expect(rowsOf(await get('/inventory/products?search=rep-b')).map(x => x.sku)).toEqual(['REP-B']);
    expect((await get('/inventory/nada')).status).toBe(404);
    const miss = await get('/suppliers/statement');
    expect(miss.status).toBe(422); expect(miss.body.error).toBe('FILTER_REQUIRED');
    expect((await get('/inventory/products?dateFrom=hoy')).status).toBe(400);
  });

  it('reposición: sugerido = máximo − (existencia + en tránsito)', async () => {
    let r = rowsOf(await get('/inventory/replenishment')).find(x => x.sku === 'REP-A')!;
    eqNum(r, { stock: 3, in_transit: 0, suggested: 27 }); // 30 − 3
    // una orden confirmada de 20 unidades entra "en tránsito"
    const o = await api.post('/purchases/orders', { supplierId, warehouseId: b.w1, currencyId: b.ves, lines: [{ productId: pA, quantity: '20', unitCost: '10', taxId: exempt }] });
    await api.post(`/purchases/orders/${o.body.data.id}/confirm`);
    r = rowsOf(await get('/inventory/replenishment')).find(x => x.sku === 'REP-A')!;
    eqNum(r, { in_transit: 20, suggested: 7 }); // 30 − (3 + 20)
    expect(rowsOf(await get('/inventory/replenishment')).find(x => x.sku === 'REP-B')).toBeUndefined(); // sin mínimo
  });

  it('CxP: vencimiento por tramos, estado de cuenta con saldo acumulado y pendientes', async () => {
    await purchase(supplierId, daysAgo(100), 1, 1000); // vence hace 85 días → 61–90
    await purchase(supplierId, daysAgo(40), 1, 500);   // vence hace 25 días → 1–30
    await purchase(supplierId, iso(new Date()), 1, 200); // por vencer
    await purchase(supplier2, daysAgo(200), 1, 300, 0); // vence hace 200 días → +90
    const aging = rowsOf(await get('/suppliers/aging'));
    const uno = aging.find(x => x.supplier === 'Proveedor Uno')!; const dos = aging.find(x => x.supplier === 'Proveedor Dos')!;
    eqNum(uno, { current: 200, d1_30: 500, d31_60: 0, d61_90: 1000, d90: 0, total: 1700 });
    eqNum(dos, { d90: 300, total: 300 });
    const agingRes = await get('/suppliers/aging');
    eqNum(agingRes.body.data.totals, { total: 2000, d90: 300 });
    // a una fecha pasada, la deuda de 100 días atrás aún no vencía
    const past = rowsOf(await get(`/suppliers/aging?asOf=${daysAgo(95)}`));
    eqNum(past.find(x => x.supplier === 'Proveedor Uno')!, { current: 1000 });
    // cuentas por pagar con días vencidos
    const pay = rowsOf(await get(`/suppliers/payables?supplierId=${supplierId}`));
    expect(pay).toHaveLength(3); expect(Math.max(...pay.map(x => x.days_overdue))).toBe(85);
    // estado de cuenta: devolución parcial reduce el saldo acumulado
    const stmt0 = rowsOf(await get(`/suppliers/statement?supplierId=${supplierId}`));
    eqNum(stmt0.at(-1)!, { balance_bs: 1700 });
    const first = (await api.get(`/purchases?search=F-${daysAgo(100)}`)).body.data[0];
    const full = (await api.get(`/purchases/${first.id}`)).body.data;
    const ret = await api.post('/purchases/returns', { supplierId, warehouseId: b.w1, currencyId: b.ves, parentId: first.id, lines: [{ productId: pB, quantity: '1', unitCost: '1000', taxId: exempt, parentLineId: full.lines[0].id }] });
    await api.post(`/purchases/returns/${ret.body.data.id}/confirm`);
    const stmt = await get(`/suppliers/statement?supplierId=${supplierId}`);
    expect(rowsOf(stmt).map(x => x.type)).toContain('Devolución');
    eqNum(stmt.body.data.totals, { debit_bs: 1700, credit_bs: 1000, balance_bs: 700 });
    // pendientes: la orden de REP-A, y compras con saldo
    const pend = rowsOf(await get('/suppliers/pending-transactions')).map(x => x.kind);
    expect(pend).toEqual(expect.arrayContaining(['Orden por recibir', 'Compra con saldo']));
  });

  it('compras: relación del período, por proveedor/producto, por instancia y estadísticas', async () => {
    const list = rowsOf(await get(`/purchases/list?dateFrom=${daysAgo(120)}&docType=PURCHASE`));
    expect(list.every(x => x.type === 'Compra')).toBe(true); expect(list.length).toBe(3); // 100d, 40d, hoy (Proveedor Uno); la de 200d queda fuera
    const pp = rowsOf(await get(`/suppliers/product-purchases?supplierId=${supplierId}`));
    expect(pp).toHaveLength(1); expect(pp[0].sku).toBe('REP-B'); eqNum(pp[0], { quantity: 3, amount_bs: 1700 });
    const stats = await get('/suppliers/statistics');
    const share = rowsOf(stats).map(x => Number(x.share_pct)).reduce((a, c) => a + c, 0);
    expect(Math.round(share)).toBe(100);
    expect(rowsOf(await get('/purchases/by-category'))[0]).toHaveProperty('amount_bs');
    expect(rowsOf(await get('/suppliers/analysis')).find(x => x.supplier === 'Proveedor Uno')).toMatchObject({ purchases: 3 });
  });

  it('inventario: valorizado actual = histórico de hoy, ABC, instancias y kardex', async () => {
    const now = await get('/inventory/stock-valuation'); const asof = await get(`/inventory/stock-valuation?asOf=${iso(new Date())}`);
    expect(Number(now.body.data.totals.value)).toBe(Number(asof.body.data.totals.value));
    const abc = rowsOf(await get('/inventory/product-analysis'));
    expect(abc.every(x => ['A', 'B', 'C'].includes(x.abc))).toBe(true);
    eqNum(rowsOf(await get('/categories/inventory')).find(x => x.name === 'Frenos')!, { products: 1, quantity: 3, value: 30 });
    expect(rowsOf(await get('/categories/inventory-consolidated')).length).toBeGreaterThan(0);
    expect(rowsOf(await get('/categories/inventory-statistics')).find(x => x.name === 'Frenos')).toMatchObject({ below_min: 1 });
    const k = rowsOf(await get(`/inventory/kardex?productId=${pA}`));
    expect(k[0].doc_type).toBe('CHARGE'); eqNum(k[0], { quantity: 3, qty_after: 3 });
    const sheet = await get(`/inventory/physical-count?warehouseId=${b.w1}`);
    eqNum(rowsOf(sheet).find(x => x.sku === 'REP-A')!, { system_qty: 3 });
    const lp = rowsOf(await get('/inventory/price-list'));
    expect(lp.length).toBe(2);
  });

  it('exporta a CSV, Excel y PDF; queda registrado en la bitácora', async () => {
    const csv = await ctx.http.get('/api/v1/reports/suppliers/aging?format=csv').set(auth(t.token)).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    expect(csv.status).toBe(200); expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.headers['content-disposition']).toMatch(/aging-\d{8}\.csv/);
    const text = (csv.body as Buffer).toString('utf8');
    // (la devolución de 1000 ya redujo la deuda vieja de Proveedor Uno)
    expect(text.charCodeAt(0)).toBe(0xfeff); expect(text).toContain('Proveedor;Por vencer;1–30');
    expect(text).toMatch(/Proveedor Uno;200(\.0+)?;500(\.0+)?;0(\.0+)?;0(\.0+)?;0(\.0+)?;700(\.0+)?/); expect(text.trim().split('\r\n').at(-1)).toMatch(/^TOTAL;/);

    const bin = (url: string) => ctx.http.get(url).set(auth(t.token)).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    const x = await bin('/api/v1/reports/inventory/products?format=xlsx');
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body as any);
    const ws = wb.getWorksheet('Reporte')!;
    expect(String(ws.getRow(1).getCell(1).value)).toContain(t.rif);
    const headerRow = ws.getRow(4 + 0 + 1); // título, empresa, generado, (sin filtros), vacía → encabezado en fila 5
    const headers = (headerRow.values as any[]).slice(1);
    expect(headers).toContain('Existencia');
    const stockCol = headers.indexOf('Existencia') + 1;
    const rowA = ws.getRows(headerRow.number + 1, 5)!.find(r => r.getCell(1).value === 'REP-A')!;
    expect(rowA.getCell(stockCol).value).toBe(3); // número real, no texto

    const p = await bin('/api/v1/reports/purchases/list?format=pdf');
    expect(p.status).toBe(200); expect(p.headers['content-type']).toBe('application/pdf');
    expect((p.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const runs = await ctx.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${t.companyId}, true)`;
      return tx.$queryRaw<{ report: string; format: string }[]>`SELECT report, format FROM report_runs ORDER BY created_at`;
    });
    expect(runs.map(r => `${r.report}:${r.format}`)).toEqual(['aging:csv', 'products:xlsx', 'list:pdf']);
    await expect(ctx.prisma.$executeRaw`DELETE FROM report_runs`).rejects.toThrow();
  });

  it('aislamiento: otra empresa no ve datos de ésta en ningún reporte', async () => {
    const other = await createTenant(ctx, 'OtraRep'); const o = client(ctx, other.token);
    expect((await o.get('/reports/inventory/products')).body.data.rows).toEqual([]);
    expect((await o.get('/reports/suppliers/aging')).body.data.rows).toEqual([]);
    expect((await o.get('/reports/suppliers/list')).body.data.rows).toEqual([]);
  });
});
