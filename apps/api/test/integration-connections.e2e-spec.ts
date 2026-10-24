import { bootstrap, Ctx, createTenant, client, Api, PASSWORD } from './helpers';

/** Conexiones a Saint configuradas desde el ERP (clave cifrada), prueba de conexión y monitoreo. */
describe('Integración: conexiones a Saint y monitoreo', () => {
  let ctx: Ctx; let admin: Api; let svc: Api; let other: Api;
  let tenant: Awaited<ReturnType<typeof createTenant>>;
  let connId: string;
  const SECRET = 'S3cr3t-Saint-Clave!';
  const body = (over: object = {}) => ({
    connectorId: 'electrosur', name: 'Eléctricos del Sur', host: '100.120.90.60', port: 1433, databaseName: 'ELECTRICOS', username: 'integrador_ro', password: SECRET,
    streams: ['customers', 'products'], ...over,
  });

  beforeAll(async () => {
    ctx = await bootstrap();
    tenant = await createTenant(ctx, 'Conexiones'); admin = client(ctx, tenant.token);
    const acc = (await admin.post('/integration/service-accounts', { name: 'Integrador' })).body.data;
    const tok = (await ctx.http.post('/api/v1/auth/service-token').send({ clientId: acc.clientId, clientSecret: acc.clientSecret })).body.data.accessToken;
    svc = client(ctx, tok);
    const t2 = await createTenant(ctx, 'Otra Conexiones'); other = client(ctx, t2.token);
  });
  afterAll(async () => { await ctx.close(); });

  it('crea la conexión: la clave se guarda cifrada y nunca vuelve por la API ni a la base en claro', async () => {
    const res = await admin.post('/integration/connections', body());
    expect(res.status).toBe(201);
    connId = res.body.data.id;
    expect(res.body.data).toMatchObject({ connectorId: 'electrosur', mode: 'READ_ONLY', hasPassword: true, streams: ['customers', 'products'] });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.data.passwordEnc).toBeUndefined();
    expect(JSON.stringify((await admin.get('/integration/connections')).body)).not.toContain(SECRET);
    const raw = await ctx.prisma.runWithTenant(tenant.companyId, tx => tx.$queryRawUnsafe<Array<{ password_enc: string }>>(`SELECT password_enc FROM integration_connections WHERE id = '${connId}'`));
    expect(raw[0].password_enc).toMatch(/^v1\./); expect(raw[0].password_enc).not.toContain(SECRET);
  });

  it('valida: identificador repetido, host con caracteres raros, escritura sin modo ni base permitida', async () => {
    expect((await admin.post('/integration/connections', body())).status).toBe(409);
    expect((await admin.post('/integration/connections', body({ connectorId: 'x2', host: 'a b;drop' }))).status).toBe(400);
    expect((await admin.post('/integration/connections', body({ connectorId: 'x3', outbound: ['customers'] }))).status).toBe(400);
    expect((await admin.post('/integration/connections', body({ connectorId: 'x4', mode: 'READ_WRITE' }))).status).toBe(400);
    const ok = await admin.post('/integration/connections', body({ connectorId: 'x5', mode: 'READ_WRITE', allowedWriteDatabases: ['ELECTRICOS'], outbound: ['customers'] }));
    expect(ok.status).toBe(201);
    await admin.del(`/integration/connections/${ok.body.data.id}`);
    expect((await admin.get('/integration/connections')).body.data.map((c: any) => c.connectorId)).toEqual(['electrosur']);
  });

  it('solo quien tiene el permiso la administra (un gerente no)', async () => {
    const g = await admin.post('/users', { email: `ger-c-${Date.now()}@test.local`, fullName: 'Gerente', password: PASSWORD, roleCodes: ['GERENTE'] });
    const gTok = (await ctx.http.post('/api/v1/auth/login').send({ email: g.body.data.email, password: PASSWORD })).body.data.accessToken;
    expect((await client(ctx, gTok).get('/integration/connections')).status).toBe(403);
    expect((await client(ctx, gTok).get('/integration/monitor')).status).toBe(403);
    expect((await svc.get('/integration/connections')).status).toBe(403); // la cuenta de servicio no administra
  });

  it('el integrador lee la configuración con la clave descifrada; el modo escritura sigue siendo explícito', async () => {
    const res = await svc.get('/integration/runtime/connections');
    expect(res.status).toBe(200);
    expect(res.body.data.paused).toBe(false);
    expect(res.body.data.connections[0]).toMatchObject({ connectorId: 'electrosur', mode: 'READ_ONLY', outbound: [], saint: { host: '100.120.90.60', database: 'ELECTRICOS', user: 'integrador_ro', password: SECRET } });
    expect((await admin.get('/integration/runtime/connections')).status).toBe(403); // un usuario no obtiene claves
    expect((await admin.get(`/integration/connections/${connId}`)).body.data.lastSeenAt).toBeTruthy();
  });

  it('prueba de conexión: el ERP la solicita, el integrador responde y cambiar el destino la invalida', async () => {
    const req = await admin.post(`/integration/connections/${connId}/test`);
    expect(req.body.data.testPending).toBe(true);
    expect((await svc.get('/integration/runtime/connections')).body.data.connections[0].testRequestedAt).toBeTruthy();
    const r = await svc.post(`/integration/runtime/connections/${connId}/test-result`, { ok: true, message: 'Conectó', latencyMs: 12, databases: ['ELECTRICOS', 'TEST'], schema: { missing: [] } });
    expect(r.status).toBe(200);
    const after = (await admin.get(`/integration/connections/${connId}`)).body.data;
    expect(after).toMatchObject({ testOk: true, testPending: false, testLatencyMs: 12, testDatabases: ['ELECTRICOS', 'TEST'] });
    const upd = await admin.patch(`/integration/connections/${connId}`, { pollIntervalSec: 60 });
    expect(upd.body.data).toMatchObject({ testOk: true, pollIntervalSec: 60, version: 2 }); // intervalo: no invalida
    const upd2 = await admin.patch(`/integration/connections/${connId}`, { host: '100.120.90.61' });
    expect(upd2.body.data).toMatchObject({ testOk: null, host: '100.120.90.61' });
    expect((await admin.patch(`/integration/connections/${connId}`, { name: 'xx', version: 1 })).status).toBe(409);
    const pw = await admin.patch(`/integration/connections/${connId}`, { password: 'Otra-Clave-9' });
    expect(pw.status).toBe(200);
    expect((await svc.get('/integration/runtime/connections')).body.data.connections[0].saint.password).toBe('Otra-Clave-9');
    expect((await admin.patch(`/integration/connections/${connId}`, { mode: 'READ_WRITE' })).status).toBe(422);
  });

  it('informes del integrador: pasadas y conflictos (abrir, repetir sin duplicar, reconocer, resolver)', async () => {
    const run = { stream: 'customers', startedAt: '2026-10-24T10:00:00.000Z', finishedAt: '2026-10-24T10:00:02.000Z', rowsRead: 9, rowsApplied: 9, rowsFailed: 0 };
    const c = { op: 'OPEN', entity: 'customers', saintKey: '19322174', kind: 'MAP_ERROR', detail: { reason: 'sin nombre' } };
    expect((await svc.post('/integration/runtime/report', { connectorId: 'electrosur', runs: [run], conflicts: [c] })).status).toBe(200);
    await svc.post('/integration/runtime/report', { connectorId: 'electrosur', runs: [], conflicts: [{ ...c, detail: { reason: 'otra' } }] });
    const list = (await admin.get('/integration/monitor/conflicts?status=OPEN')).body.data;
    expect(list).toHaveLength(1); expect(list[0].detail).toEqual({ reason: 'otra' });
    const mon = (await admin.get('/integration/monitor')).body.data[0];
    expect(mon).toMatchObject({ connectorId: 'electrosur', openConflicts: 1 });
    expect(mon.streamsStatus[0]).toMatchObject({ stream: 'customers', rowsRead: 9 });
    expect((await admin.get('/integration/monitor/runs')).body.data).toHaveLength(1);
    const ack = await admin.post(`/integration/monitor/conflicts/${list[0].id}/status`, { status: 'ACKNOWLEDGED', note: 'lo reviso' });
    expect(ack.body.data.status).toBe('ACKNOWLEDGED');
    await svc.post('/integration/runtime/report', { connectorId: 'electrosur', conflicts: [c] }); // sigue fallando: queda reconocido
    expect((await admin.get('/integration/monitor/conflicts')).body.data[0].status).toBe('ACKNOWLEDGED');
    await svc.post('/integration/runtime/report', { connectorId: 'electrosur', conflicts: [{ ...c, op: 'RESOLVED' }] });
    expect((await admin.get('/integration/monitor/conflicts')).body.data[0].status).toBe('RESOLVED');
    expect((await admin.post(`/integration/monitor/conflicts/${list[0].id}/status`, { status: 'OPEN' })).status).toBe(422);
    expect((await svc.post('/integration/runtime/report', { connectorId: 'no-existe' })).status).toBe(404);
  });

  it('otra empresa no ve nada y pausar la integración vacía la configuración', async () => {
    expect((await other.get('/integration/connections')).body.data).toEqual([]);
    expect((await other.get(`/integration/connections/${connId}`)).status).toBe(404);
    await admin.post('/integration/enabled', { enabled: false });
    const paused = await svc.get('/integration/runtime/connections');
    expect(paused.status).toBe(200); // el token sigue vigente, pero no entrega conexiones
    await admin.post('/integration/enabled', { enabled: true });
  });
});
