import { bootstrap, Ctx, createTenant, PASSWORD, client, auth } from './helpers';

describe('Auth y seguridad', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await bootstrap(); });
  afterAll(async () => { await ctx.close(); });

  it('rechaza credenciales inválidas y no revela si el usuario existe', async () => {
    const t = await createTenant(ctx);
    const bad = await ctx.http.post('/api/v1/auth/login').send({ email: t.adminEmail, password: 'incorrecta' });
    const unknown = await ctx.http.post('/api/v1/auth/login').send({ email: 'nadie@test.local', password: 'x' });
    expect(bad.status).toBe(401); expect(unknown.status).toBe(401);
    expect(bad.body.error).toBe('INVALID_CREDENTIALS'); expect(unknown.body.error).toBe('INVALID_CREDENTIALS');
  });

  it('bloquea la cuenta tras intentos fallidos', async () => {
    const t = await createTenant(ctx);
    for (let i = 0; i < 5; i++) await ctx.http.post('/api/v1/auth/login').send({ email: t.adminEmail, password: 'mala-' + i });
    const locked = await ctx.http.post('/api/v1/auth/login').send({ email: t.adminEmail, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.error).toBe('ACCOUNT_LOCKED');
  });

  it('exige token y empresa; /auth/me devuelve permisos', async () => {
    const t = await createTenant(ctx);
    expect((await ctx.http.get('/api/v1/products')).status).toBe(401);
    const me = await client(ctx, t.token).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.permissions).toContain('admin:products:create');
    expect(me.body.data.roles.map((r: any) => r.code)).toContain('ADMIN');
  });

  it('refresh rota el token y detecta reutilización (revoca la familia)', async () => {
    const t = await createTenant(ctx);
    const login = await ctx.http.post('/api/v1/auth/login').send({ email: t.adminEmail, password: PASSWORD });
    const r1 = login.body.data.refreshToken;
    const rot = await ctx.http.post('/api/v1/auth/refresh').send({ refreshToken: r1 });
    expect(rot.status).toBe(200);
    expect(rot.body.data.refreshToken).not.toBe(r1);
    // Dentro de la ventana de gracia (dos pestañas renovando a la vez) NO es robo: se atiende y la sesión sigue.
    const racing = await ctx.http.post('/api/v1/auth/refresh').send({ refreshToken: r1 });
    expect(racing.status).toBe(200);
    // Fuera de la ventana, reutilizar un token ya rotado revoca toda la familia.
    await ctx.prisma.$executeRaw`UPDATE refresh_tokens SET revoked_at = now() - interval '1 hour' WHERE token_hash = encode(sha256(${r1}::bytea), 'hex')`;
    const reuse = await ctx.http.post('/api/v1/auth/refresh').send({ refreshToken: r1 });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe('REFRESH_REUSED');
    // el token nuevo de la misma familia también quedó revocado
    const after = await ctx.http.post('/api/v1/auth/refresh').send({ refreshToken: rot.body.data.refreshToken });
    expect(after.status).toBe(401);
  });

  it('logout revoca el access token (lista de bloqueo)', async () => {
    const t = await createTenant(ctx);
    const login = await ctx.http.post('/api/v1/auth/login').send({ email: t.adminEmail, password: PASSWORD });
    const token = login.body.data.accessToken;
    expect((await ctx.http.get('/api/v1/warehouses').set(auth(token))).status).toBe(200);
    expect((await ctx.http.post('/api/v1/auth/logout').set(auth(token)).send({ refreshToken: login.body.data.refreshToken })).status).toBe(204);
    const after = await ctx.http.get('/api/v1/warehouses').set(auth(token));
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('TOKEN_REVOKED');
  });

  it('usuario multiempresa debe seleccionar empresa; no puede elegir una ajena', async () => {
    const a = await createTenant(ctx, 'A');
    const b = await createTenant(ctx, 'B', a.organizationId); // mismo cliente
    const api = client(ctx, a.token);
    // un usuario de A agregado a B
    await client(ctx, b.token).post('/users', { email: a.adminEmail, fullName: 'Admin', roleCodes: ['VENDEDOR'] });
    const login = await ctx.http.post('/api/v1/auth/login').send({ email: a.adminEmail, password: PASSWORD });
    expect(login.body.data.requiresCompanySelection).toBe(true);
    expect(login.body.data.companies).toHaveLength(2);
    const noCompany = await ctx.http.get('/api/v1/warehouses').set(auth(login.body.data.accessToken));
    expect(noCompany.status).toBe(403);
    expect(noCompany.body.error).toBe('COMPANY_REQUIRED');
    const sel = await ctx.http.post('/api/v1/auth/select-company').set(auth(login.body.data.accessToken)).send({ companyId: b.companyId });
    expect(sel.status).toBe(200);
    // en B solo es VENDEDOR: no puede crear productos
    const create = await ctx.http.post('/api/v1/products').set(auth(sel.body.data.accessToken)).send({ sku: 'X', name: 'X', unitId: '0194b3a2-7c1e-7d3a-9a44-1f2c9b5a0e11' });
    expect(create.status).toBe(403);
    expect(create.body.error).toBe('FORBIDDEN');
    void api;
  });

  it('un usuario sin pertenencia no puede seleccionar la empresa', async () => {
    const a = await createTenant(ctx, 'A2');
    const b = await createTenant(ctx, 'B2');
    const login = await ctx.http.post('/api/v1/auth/login').send({ email: a.adminEmail, password: PASSWORD });
    const sel = await ctx.http.post('/api/v1/auth/select-company').set(auth(login.body.data.accessToken)).send({ companyId: b.companyId });
    expect(sel.status).toBe(403);
  });
});
