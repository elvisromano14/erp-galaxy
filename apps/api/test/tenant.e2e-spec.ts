import { bootstrap, Ctx, createTenant, client, PASSWORD, seedBasics, uniqueRif, auth } from './helpers';

describe('Multiempresa (RLS + FK compuestas) y catálogos', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await bootstrap(); });
  afterAll(async () => { await ctx.close(); });

  it('toda tabla con company_id (salvo las exentas) tiene RLS habilitado y forzado', async () => {
    const rows = await ctx.prisma.$queryRaw<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
      JOIN information_schema.columns k ON k.table_name = c.relname AND k.column_name = 'company_id' AND k.table_schema = 'public'
      WHERE c.relkind = 'r'`;
    const exempt = new Set(['user_companies', 'refresh_tokens']);
    const bad = rows.filter(r => !exempt.has(r.relname) && !(r.relrowsecurity && r.relforcerowsecurity)).map(r => r.relname);
    expect(bad).toEqual([]);
    expect(rows.length).toBeGreaterThan(30);
  });

  it('el rol de la aplicación no es superusuario ni BYPASSRLS', async () => {
    const [r] = await ctx.prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(r.rolsuper).toBe(false);
    expect(r.rolbypassrls).toBe(false);
  });

  it('sin contexto de empresa no se ve ninguna fila (falla cerrada)', async () => {
    const t = await createTenant(ctx, 'Cerrada');
    const api = client(ctx, t.token);
    const { unitId } = await seedBasics(api);
    await api.post('/products', { sku: 'RLS-1', name: 'x', unitId });
    const [{ n }] = await ctx.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM products`;
    expect(Number(n)).toBe(0);
  });

  it('una empresa no ve, edita ni referencia datos de otra', async () => {
    const a = await createTenant(ctx, 'A'); const b = await createTenant(ctx, 'B');
    const A = client(ctx, a.token), B = client(ctx, b.token);
    const sa = await seedBasics(A), sb = await seedBasics(B);
    const pa = await sa.product('AISLADO-1');
    expect((await B.get(`/products/${pa}`)).status).toBe(404);
    expect((await B.patch(`/products/${pa}`, { name: 'hack' })).status).toBe(404);
    expect((await B.del(`/products/${pa}`)).status).toBe(404);
    expect((await B.get('/products?search=AISLADO')).body.data).toHaveLength(0);
    // referencias cruzadas: la FK compuesta (company_id, id) lo impide aunque RLS no lo vea
    const cross = await B.post('/products', { sku: 'CRUZ', name: 'x', unitId: sa.unitId });
    expect(cross.status).toBe(409);
    expect(cross.body.error).toBe('FOREIGN_KEY_VIOLATION');
    const crossCat = await A.post('/categories', { code: 'C1', name: 'cat A' });
    const crossProd = await B.post('/products', { sku: 'CRUZ2', name: 'x', unitId: sb.unitId, categoryId: crossCat.body.data.id });
    expect(crossProd.status).toBe(409);
    // mismo SKU permitido en empresas distintas; duplicado dentro de la misma → 409
    expect((await sb.product('AISLADO-1').then(() => 'ok'))).toBe('ok');
    const dup = await A.post('/products', { sku: 'AISLADO-1', name: 'otra', unitId: sa.unitId });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('UNIQUE_VIOLATION');
  });

  it('una empresa con rol de solo lectura no puede crear; el administrador sí', async () => {
    const t = await createTenant(ctx, 'Roles');
    const api = client(ctx, t.token);
    const { unitId } = await seedBasics(api);
    const u = await api.post('/users', { email: `vend-${Date.now()}@test.local`, fullName: 'Vendedor', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    expect(u.status).toBe(201);
    const login = await ctx.http.post('/api/v1/auth/login').send({ email: u.body.data.email, password: PASSWORD });
    const vend = client(ctx, login.body.data.accessToken);
    expect((await vend.get('/products')).status).toBe(200);
    expect((await vend.post('/products', { sku: 'V1', name: 'x', unitId })).status).toBe(403);
    expect((await vend.get('/inventory/kardex')).status).toBe(403);
  });

  it('valida RIF, normaliza el formato y rechaza duplicados', async () => {
    const t = await createTenant(ctx, 'Terceros');
    const api = client(ctx, t.token);
    const bad = await api.post('/suppliers', { rif: 'J-12345678-0', legalName: 'Proveedor malo' });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('INVALID_RIF');
    const rif = uniqueRif();
    const ok = await api.post('/suppliers', { rif: rif.replace(/-/g, ''), legalName: 'Proveedor bueno', creditDays: 30 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.rif).toBe(rif);
    expect((await api.post('/suppliers', { rif, legalName: 'Repetido' })).status).toBe(409);
    expect((await api.post('/customers', { rif, legalName: 'Mismo RIF como cliente' })).status).toBe(201);
  });

  it('los listados paginan, ordenan y filtran con listas blancas', async () => {
    const t = await createTenant(ctx, 'Listas');
    const api = client(ctx, t.token);
    for (const c of ['B', 'A', 'C']) await api.post('/zones', { code: `Z${c}`, name: `Zona ${c}` });
    const page = await api.get('/zones?limit=2&page=1&sort=-code');
    expect(page.body.data.map((z: any) => z.code)).toEqual(['ZC', 'ZB']);
    expect(page.body.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect((await api.get('/zones?sort=hack')).status).toBe(400);
    expect((await api.get('/zones?filter[hack]=1')).status).toBe(400);
    expect((await api.get('/zones?search=zona a')).body.data).toHaveLength(1);
  });

  it('baja lógica y restauración', async () => {
    const t = await createTenant(ctx, 'Soft');
    const api = client(ctx, t.token);
    const z = (await api.post('/zones', { code: 'Z1', name: 'Zona 1' })).body.data;
    expect((await api.del(`/zones/${z.id}`)).status).toBe(200);
    expect((await api.get('/zones')).body.data).toHaveLength(0);
    expect((await api.get('/zones?includeDeleted=true')).body.data).toHaveLength(1);
    expect((await api.post(`/zones/${z.id}/restore`)).status).toBe(201);
    expect((await api.get('/zones')).body.data).toHaveLength(1);
  });

  it('lotes/seriales/vencimiento desactivados por defecto: la API los rechaza; al activar el flag se permiten', async () => {
    const t = await createTenant(ctx, 'Flags');
    const api = client(ctx, t.token);
    const { unitId } = await seedBasics(api);
    const r1 = await api.post('/products', { sku: 'L1', name: 'x', unitId, trackingMode: 'LOT' });
    expect(r1.status).toBe(422); expect(r1.body.error).toBe('FEATURE_DISABLED');
    expect((await api.patch('/companies/current', { features: { expiry: true } })).status).toBe(422); // requiere lotes
    expect((await api.patch('/companies/current', { features: { lots: true, expiry: true } })).status).toBe(200);
    expect((await api.post('/products', { sku: 'L2', name: 'x', unitId, trackingMode: 'LOT', hasExpiry: true })).status).toBe(201);
    expect((await api.post('/products', { sku: 'L3', name: 'x', unitId, trackingMode: 'SERIAL' })).status).toBe(422); // seriales desactivados
  });

  it('productos: búsqueda por OEM/código de barras, precios con historial y control de versión', async () => {
    const t = await createTenant(ctx, 'Prod');
    const api = client(ctx, t.token);
    const { unitId } = await seedBasics(api);
    const list = (await api.get('/price-lists')).body.data[0];
    const p = await api.post('/products', {
      sku: 'PAS-9', name: 'Pastillas', unitId, barcodes: ['7591234567890'],
      references: [{ refType: 'OEM', code: '04465-0K290', brand: 'Toyota' }], prices: [{ priceListId: list.id, price: '25.5' }],
    });
    expect(p.status).toBe(201);
    const id = p.body.data.id;
    expect((await api.get('/products?search=04465')).body.data.map((x: any) => x.id)).toContain(id);
    expect((await api.get('/products?search=7591234567890')).body.data.map((x: any) => x.id)).toContain(id);
    await api.post(`/products/${id}/prices`, { priceListId: list.id, price: '30', validFrom: '2030-01-01' });
    const hist = (await api.get(`/products/${id}/price-history`)).body.data;
    expect(hist.map((h: any) => h.price)).toEqual(['30', '25.5']);
    expect((await api.get(`/products/${id}`)).body.data.prices[0].price).toBe('25.5'); // el de 2030 aún no rige
    const v = p.body.data.version;
    expect((await api.patch(`/products/${id}`, { name: 'Nuevo', version: v })).status).toBe(200);
    const stale = await api.patch(`/products/${id}`, { name: 'Viejo', version: v });
    expect(stale.status).toBe(422); expect(stale.body.error).toBe('VERSION_CONFLICT');
  });

  it('tasas de cambio: historial inmutable y la última de la fecha prevalece', async () => {
    const t = await createTenant(ctx, 'FX');
    const api = client(ctx, t.token);
    const { usd, ves } = await seedBasics(api);
    expect((await api.post('/exchange-rates', { currencyId: ves, rate: '1', date: '2026-10-01' })).status).toBe(422);
    await api.post('/exchange-rates', { currencyId: usd, rate: '36.00', date: '2026-10-01' });
    await api.post('/exchange-rates', { currencyId: usd, rate: '36.52', date: '2026-10-01' });
    const latest = await api.get(`/exchange-rates/latest?currencyId=${usd}&date=2026-10-05`);
    expect(latest.body.data.rate).toBe('36.52');
    const [{ n }] = await ctx.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${t.companyId}, true)`;
      return tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM exchange_rates WHERE date = '2026-10-01'`;
    });
    expect(Number(n)).toBeGreaterThanOrEqual(2);
    await expect(ctx.prisma.$executeRaw`UPDATE exchange_rates SET rate = 1`).rejects.toThrow();
    await expect(ctx.prisma.$executeRaw`DELETE FROM exchange_rates`).rejects.toThrow();
    void auth;
  });
});
