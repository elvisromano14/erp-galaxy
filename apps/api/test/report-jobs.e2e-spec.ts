import { bootstrap, Ctx, createTenant, client, Api, seedBasics, PASSWORD, auth } from './helpers';
import { HousekeepingService } from '../src/modules/alerts/alerts.service';

describe('Reportes en segundo plano (BullMQ)', () => {
  let ctx: Ctx; let api: Api; let token: string; let companyId: string; let b: Awaited<ReturnType<typeof seedBasics>>;
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Jobs'); token = t.token; companyId = t.companyId; api = client(ctx, t.token); b = await seedBasics(api);
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }) });
    for (let i = 1; i <= 3; i++) await b.product(`JOB-${i}`);
  });
  afterAll(async () => { await ctx.close(); });

  const buf = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); };
  const waitFor = async (a: Api, id: string, want = 'DONE', ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const j = (await a.get(`/reports/jobs/${id}`)).body.data;
      if (j.status === want || ['FAILED', 'DONE', 'EXPIRED'].includes(j.status) && want !== 'DONE') return j;
      if (j.status === 'FAILED' || Date.now() - t0 > ms) return j;
      await new Promise(r => setTimeout(r, 200));
    }
  };

  it('encola, procesa en el worker y permite descargar un archivo idéntico al síncrono', async () => {
    const c = await api.post('/reports/jobs', { category: 'inventory', report: 'products', format: 'csv', filters: {} });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ status: 'QUEUED', format: 'csv', category: 'inventory', report: 'products' });
    const done = await waitFor(api, c.body.data.id);
    expect(done).toMatchObject({ status: 'DONE', rowCount: 3, truncated: false }); expect(done.sizeBytes).toBeGreaterThan(50);
    const dl = await ctx.http.get(`/api/v1/reports/jobs/${c.body.data.id}/download`).set(auth(token)).buffer(true).parse(buf);
    expect(dl.status).toBe(200); expect(dl.headers['content-disposition']).toContain('inventory-products-'); expect(dl.headers['content-type']).toContain('text/csv');
    const sync = await ctx.http.get('/api/v1/reports/inventory/products?format=csv').set(auth(token)).buffer(true).parse(buf);
    const strip = (s: string) => s.split('\n').filter(l => !l.includes('Generado')).join('\n'); // el pie puede llevar la hora de generación
    expect(strip(dl.body.toString())).toBe(strip(sync.body.toString()));
    // excel y pdf también
    for (const format of ['xlsx', 'pdf']) {
      const j = (await api.post('/reports/jobs', { category: 'inventory', report: 'products', format, filters: {} })).body.data;
      expect((await waitFor(api, j.id)).status).toBe('DONE');
      const f = await ctx.http.get(`/api/v1/reports/jobs/${j.id}/download`).set(auth(token)).buffer(true).parse(buf);
      expect(f.status).toBe(200); expect(f.body.subarray(0, 2).toString()).toBe(format === 'xlsx' ? 'PK' : '%P');
    }
    // aparece en "mis exportaciones" y el log de exportaciones registró la generación
    const list = (await api.get('/reports/jobs')).body;
    expect(list.data.length).toBe(3); expect(list.data[0].title).toBe('Listado de productos');
    expect((await api.get('/reports/inventory/products?format=json')).status).toBe(200);
  });

  it('valida al crear: reporte inexistente, filtros obligatorios y permiso de la categoría', async () => {
    expect((await api.post('/reports/jobs', { category: 'inventory', report: 'nada', format: 'csv' })).status).toBe(404);
    const missing = await api.post('/reports/jobs', { category: 'suppliers', report: 'statement', format: 'csv', filters: {} });
    expect(missing.status).toBe(422); expect(missing.body.error).toBe('FILTER_REQUIRED');
    expect((await api.post('/reports/jobs', { category: 'inventory', report: 'products', format: 'json' })).status).toBe(400);
    const email = `jb-${Math.random().toString(36).slice(2, 7)}@test.local`;
    await api.post('/users', { email, fullName: 'Vendedor Jobs', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    const v = client(ctx, (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken);
    expect((await v.post('/reports/jobs', { category: 'inventory', report: 'products', format: 'csv' })).status).toBe(403);
  });

  it('cada usuario ve y descarga solo sus exportaciones', async () => {
    const mine = (await api.post('/reports/jobs', { category: 'inventory', report: 'products', format: 'csv' })).body.data;
    await waitFor(api, mine.id);
    const email = `jc-${Math.random().toString(36).slice(2, 7)}@test.local`;
    await api.post('/users', { email, fullName: 'Compras Jobs', password: PASSWORD, roleCodes: ['COMPRAS'] });
    const other = client(ctx, (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken);
    expect((await other.get(`/reports/jobs/${mine.id}`)).status).toBe(404);
    expect((await other.get(`/reports/jobs/${mine.id}/download`)).status).toBe(404);
    expect((await other.get('/reports/jobs')).body.data).toHaveLength(0);
    // también hay aislamiento entre empresas
    const t2 = await createTenant(ctx, 'JobsOtra'); const a2 = client(ctx, t2.token);
    expect((await a2.get(`/reports/jobs/${mine.id}`)).status).toBe(404);
  });

  it('un trabajo fallido queda como FAILED con el motivo y la purga borra los archivos vencidos', async () => {
    // se fuerza un fallo: reporte que exige una función desactivada tras encolar (lotes apagados)
    const j = (await api.post('/reports/jobs', { category: 'inventory', report: 'products', format: 'csv' })).body.data;
    expect((await waitFor(api, j.id)).status).toBe('DONE');
    await ctx.prisma.runWithTenant(companyId, tx => tx.reportJob.update({ where: { id: j.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    expect(await ctx.app.get(HousekeepingService).purgeReportFiles()).toBeGreaterThanOrEqual(1);
    const g = (await api.get(`/reports/jobs/${j.id}`)).body.data;
    expect(g.status).toBe('EXPIRED');
    const dl = await api.get(`/reports/jobs/${j.id}/download`);
    expect(dl.status).toBe(422); expect(dl.body.error).toBe('FILE_EXPIRED');
    // fallo real: se rompe la definición del trabajo en BD (categoría de un reporte que ya no existe)
    const bad = (await api.post('/reports/jobs', { category: 'inventory', report: 'products', format: 'csv' })).body.data;
    await ctx.prisma.runWithTenant(companyId, tx => tx.$executeRaw`UPDATE report_jobs SET report = 'ya-no-existe' WHERE id = ${bad.id}::uuid`);
    const f = await waitFor(api, bad.id);
    expect(f.status).toBe('FAILED'); expect(f.error).toContain('no encontrad');
  });
});
