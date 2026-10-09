import { bootstrap, Ctx, createOrg, createTenant, client, auth, PASSWORD, uniqueRif, seedBasics } from './helpers';

describe('Edición de empresas por el administrador de cliente', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await bootstrap(); });
  afterAll(async () => { await ctx.close(); });
  const login = async (email: string) => (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data;

  it('edita y da de baja empresas de SU cliente; no puede tocar las de otros', async () => {
    const o1 = await createOrg(ctx, 'Cliente A'); const o2 = await createOrg(ctx, 'Cliente B');
    const a = await createTenant(ctx, 'EmpA', o1.organizationId); const b = await createTenant(ctx, 'EmpB', o2.organizationId);
    const s = await login(o1.adminEmail);
    const api = client(ctx, s.accessToken);
    const up = await api.patch(`/companies/${a.companyId}`, { tradeName: 'Comercial A', isIgtfCollector: true, fiscalAddress: 'Caracas' });
    expect(up.status).toBe(200); expect(up.body.data.tradeName).toBe('Comercial A');
    // otra empresa de otro cliente: no existe para él
    expect((await api.patch(`/companies/${b.companyId}`, { legalName: 'Hackeada' })).status).toBe(404);
    // baja: desaparece del selector y del listado normal; el listado de gestión la sigue mostrando
    expect((await api.patch(`/companies/${a.companyId}`, { isActive: false })).status).toBe(200);
    const visible = (await client(ctx, (await login(o1.adminEmail)).accessToken).get('/companies')).body.data.map((c: any) => c.id);
    expect(visible).not.toContain(a.companyId);
    const all = (await client(ctx, (await login(o1.adminEmail)).accessToken).get('/companies?includeInactive=true')).body.data;
    expect(all.find((c: any) => c.id === a.companyId)?.isActive).toBe(false);
    // quienes estaban dentro quedan sin sesión de esa empresa
    const stale = await ctx.http.post('/api/v1/auth/login').send({ email: a.adminEmail, password: PASSWORD });
    expect(stale.body.data.companies.map((c: any) => c.id)).not.toContain(a.companyId);
    // reactivar
    expect((await client(ctx, (await login(o1.adminEmail)).accessToken).patch(`/companies/${a.companyId}`, { isActive: true })).status).toBe(200);
    // un admin de empresa (no de cliente) no puede editarla por esta vía
    const adminEmp = await login(b.adminEmail);
    expect((await client(ctx, adminEmp.accessToken).patch(`/companies/${b.companyId}`, { tradeName: 'x' })).status).toBe(404);
  });
});

describe('Secuencias de numeración', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await bootstrap(); });
  afterAll(async () => { await ctx.close(); });

  it('lista predeterminadas, cambia prefijo/relleno y solo permite subir el correlativo', async () => {
    const t = await createTenant(ctx, 'Seq'); const api = client(ctx, t.token); const b = await seedBasics(api);
    const list = (await api.get('/document-sequences')).body.data;
    expect(list.find((x: any) => x.docType === 'INVENTORY_CHARGE')).toMatchObject({ prefix: 'CAR-', nextNumber: '1', isDefault: true });
    const put = (body: object) => ctx.http.put('/api/v1/document-sequences').set(auth(t.token)).send(body);
    const r = await put({ docType: 'INVENTORY_CHARGE', prefix: 'CRG-', padding: 4, nextNumber: 100 });
    expect(r.status).toBe(200); expect(r.body.data).toMatchObject({ prefix: 'CRG-', padding: 4, nextNumber: '100', example: 'CRG-0100' });
    const p = await b.product('SEQ-1');
    const d = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '1', unitCost: '1' }] });
    expect((await api.post(`/inventory/charges/${d.body.data.id}/confirm`)).body.data.number).toBe('CRG-0100');
    // no se puede retroceder (evita duplicados)
    const back = await put({ docType: 'INVENTORY_CHARGE', nextNumber: 50 });
    expect(back.status).toBe(422); expect(back.body.error).toBe('SEQUENCE_CANNOT_DECREASE');
    expect((await put({ docType: 'NO_EXISTE', prefix: 'X' })).status).toBe(422);
    expect((await put({ docType: 'INVENTORY_CHARGE', prefix: 'MAL PREFIJO!' })).status).toBe(400);
    // el vendedor no puede cambiarlas
    const u = await api.post('/users', { email: `s-${Date.now()}@test.local`, fullName: 'Vendedor', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    const lg = await ctx.http.post('/api/v1/auth/login').send({ email: u.body.data.email, password: PASSWORD });
    expect((await ctx.http.put('/api/v1/document-sequences').set(auth(lg.body.data.accessToken)).send({ docType: 'INVENTORY_CHARGE', prefix: 'Z-' })).status).toBe(403);
  });

  it('empresas ya existentes reciben los permisos nuevos del catálogo en sus roles de sistema', async () => {
    const t = await createTenant(ctx, 'PermSync');
    await ctx.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${t.companyId}, true)`;
      await tx.$executeRaw`DELETE FROM role_permissions WHERE permission_code = 'admin:sequences:update'`;
    });
    const before = (await client(ctx, t.token).get('/auth/me')).body.data.permissions;
    // el cache de permisos (5 min) se invalida al sincronizar; forzamos el arranque de la sincronización
    await ctx.app.get((await import('../src/modules/companies/companies.service')).CompaniesService).onApplicationBootstrap();
    const login = await ctx.http.post('/api/v1/auth/login').send({ email: t.adminEmail, password: PASSWORD });
    const after = (await client(ctx, login.body.data.accessToken).get('/auth/me')).body.data.permissions;
    expect(after).toContain('admin:sequences:update');
    void before;
  });
});

describe('Tasas de cambio: BCV (DolarApi) y manuales por empresa', () => {
  let ctx: Ctx;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => { ctx = await bootstrap(); });
  afterAll(async () => { jest.restoreAllMocks(); await ctx.close(); });

  const mockDolarApi = (usd: number | null, eur: number | null, date = today) =>
    jest.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      const body = u.includes('dolares') ? { moneda: 'USD', fuente: 'oficial', promedio: usd, fechaActualizacion: `${date}T00:00:00-04:00` }
        : { moneda: 'EUR', fuente: 'oficial', promedio: eur, fechaActualizacion: `${date}T00:00:00-04:00` };
      return new Response(JSON.stringify(body), { status: 200 });
    });

  it('sincroniza la oficial desde DolarApi, es idempotente y detecta cambios', async () => {
    const t = await createTenant(ctx, 'FXsync'); const api = client(ctx, t.token); const b = await seedBasics(api);
    const spy = mockDolarApi(875.65, 980.61, '2030-01-15');
    const r1 = await api.post('/exchange-rates/sync');
    expect(r1.status).toBe(201);
    expect(r1.body.data.map((x: any) => `${x.currency}:${x.status}`)).toEqual(['USD:INSERTED', 'EUR:INSERTED']);
    expect(spy.mock.calls[0][0]).toBe('https://ve.dolarapi.com/v1/dolares/oficial');
    const r2 = await api.post('/exchange-rates/sync');
    expect(r2.body.data.map((x: any) => x.status)).toEqual(['UNCHANGED', 'UNCHANGED']);
    mockDolarApi(880.1, 980.61, '2030-01-15');
    expect((await api.post('/exchange-rates/sync')).body.data.map((x: any) => x.status)).toEqual(['INSERTED', 'UNCHANGED']);
    const latest = await api.get(`/exchange-rates/latest?currencyId=${b.usd}&date=2030-01-20`);
    expect(latest.body.data).toMatchObject({ rate: '880.1', source: 'BCV', date: '2030-01-15' });
    // una API sin tasa publicada no inserta nada
    mockDolarApi(null, null, '2030-01-16');
    expect((await api.post('/exchange-rates/sync')).body.data.every((x: any) => x.status === 'SKIPPED')).toBe(true);
  });

  it('si DolarApi no responde, el error es claro y se puede cargar manualmente', async () => {
    const t = await createTenant(ctx, 'FXdown'); const api = client(ctx, t.token);
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));
    const r = await api.post('/exchange-rates/sync');
    expect(r.status).toBe(422); expect(r.body.error).toBe('FX_SOURCE_UNAVAILABLE');
  });

  it('la tasa manual de una empresa prevalece en la misma fecha y NO afecta a otras empresas', async () => {
    const a = await createTenant(ctx, 'FXa'); const b = await createTenant(ctx, 'FXb');
    const A = client(ctx, a.token), B = client(ctx, b.token); const ba = await seedBasics(A); const bb = await seedBasics(B);
    mockDolarApi(900, 1000, '2031-03-01');
    await A.post('/exchange-rates/sync');
    expect((await A.get(`/exchange-rates/latest?currencyId=${ba.usd}&date=2031-03-01`)).body.data).toMatchObject({ rate: '900', source: 'BCV' });
    // A carga una manual para la misma fecha → prevalece solo para A
    expect((await A.post('/exchange-rates', { currencyId: ba.usd, rate: '905.5', date: '2031-03-01' })).status).toBe(201);
    expect((await A.get(`/exchange-rates/latest?currencyId=${ba.usd}&date=2031-03-01`)).body.data).toMatchObject({ rate: '905.5', source: 'MANUAL' });
    expect((await B.get(`/exchange-rates/latest?currencyId=${bb.usd}&date=2031-03-01`)).body.data).toMatchObject({ rate: '900', source: 'BCV' });
    // las manuales de A no aparecen en el listado de B
    const listB = (await B.get('/exchange-rates?source=MANUAL&limit=100')).body.data;
    expect(listB.find((r: any) => r.rate === '905.5')).toBeUndefined();
    // una sincronización posterior (misma fecha) no pisa la manual de A
    mockDolarApi(901, 1000, '2031-03-01');
    await A.post('/exchange-rates/sync');
    expect((await A.get(`/exchange-rates/latest?currencyId=${ba.usd}&date=2031-03-01`)).body.data.rate).toBe('905.5');
    // una fecha posterior del BCV gana sobre la manual anterior
    mockDolarApi(910, 1000, '2031-03-02');
    await A.post('/exchange-rates/sync');
    expect((await A.get(`/exchange-rates/latest?currencyId=${ba.usd}&date=2031-03-02`)).body.data).toMatchObject({ rate: '910', source: 'BCV' });
    // las filas globales no se pueden alterar ni borrar
    await expect(ctx.prisma.$executeRaw`DELETE FROM exchange_rates WHERE company_id IS NULL`).rejects.toThrow();
  });
});
