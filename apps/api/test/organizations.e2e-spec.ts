import { bootstrap, Ctx, createOrg, createTenant, client, auth, PASSWORD, uniqueRif } from './helpers';

/**
 * Escenario del negocio: clientes aislados entre sí.
 *  - Cliente 1: KTSU y JAC · Cliente 2: SIN0CARS y ELECTRICOS DEL SUR · Cliente 3: Ayagba Glam.
 */
describe('Clientes (organizaciones): visibilidad y creación de empresas', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await bootstrap(); });
  afterAll(async () => { await ctx.close(); });

  const login = async (email: string) => (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data;
  const names = (list: any[]) => list.map(c => c.legalName.replace(' C.A.', '')).sort();

  async function world() {
    const c1 = await createOrg(ctx, 'Cliente KTSU-JAC'); const c2 = await createOrg(ctx, 'Cliente Sinocars'); const c3 = await createOrg(ctx, 'Cliente Ayagba');
    const ktsu = await createTenant(ctx, 'KTSU', c1.organizationId); const jac = await createTenant(ctx, 'JAC', c1.organizationId);
    const sin = await createTenant(ctx, 'SIN0CARS', c2.organizationId); const ele = await createTenant(ctx, 'ELECTRICOS DEL SUR', c2.organizationId);
    const aya = await createTenant(ctx, 'Ayagba Glam', c3.organizationId);
    return { c1, c2, c3, ktsu, jac, sin, ele, aya };
  }

  it('el administrador global ve todas las empresas de todos los clientes', async () => {
    const w = await world();
    const me = await client(ctx, ctx.super).get('/companies');
    expect(me.status).toBe(200);
    const all = names(me.body.data);
    for (const n of ['KTSU', 'JAC', 'SIN0CARS', 'ELECTRICOS DEL SUR', 'Ayagba Glam']) expect(all).toContain(n);
    void w;
  });

  it('el administrador de un cliente ve SOLO las empresas de su cliente (aunque no esté asignado una a una)', async () => {
    const w = await world();
    const s1 = await login(w.c1.adminEmail);
    // sin asignación explícita: ve KTSU y JAC, no las de otros clientes
    expect(names(s1.companies).filter(n => ['KTSU', 'JAC', 'SIN0CARS', 'ELECTRICOS DEL SUR', 'Ayagba Glam'].includes(n))).toEqual(['JAC', 'KTSU']);
    const s2 = await login(w.c2.adminEmail);
    expect(names(s2.companies)).toEqual(['ELECTRICOS DEL SUR', 'SIN0CARS']);
    const s3 = await login(w.c3.adminEmail);
    expect(names(s3.companies)).toEqual(['Ayagba Glam']);
    // /companies devuelve lo mismo que el login
    expect(names((await client(ctx, s3.accessToken).get('/companies')).body.data)).toEqual(['Ayagba Glam']);
  });

  it('no puede entrar a empresas de otro cliente (403), pero sí a las de su cliente', async () => {
    const w = await world();
    const s0 = await login(w.c1.adminEmail);
    const ok = await ctx.http.post('/api/v1/auth/select-company').set(auth(s0.accessToken)).send({ companyId: w.jac.companyId });
    expect(ok.status).toBe(200);
    // y al entrar recibe el rol ADMIN en la empresa (no tenía asignación previa)
    const me = await client(ctx, ok.body.data.accessToken).get('/auth/me');
    expect(me.body.data.permissions).toContain('admin:products:create');
    for (const other of [w.sin, w.ele, w.aya]) {
      const s1 = await login(w.c1.adminEmail); // select-company revoca el token anterior: login nuevo en cada intento
      const bad = await ctx.http.post('/api/v1/auth/select-company').set(auth(s1.accessToken)).send({ companyId: other.companyId });
      expect(bad.status).toBe(403);
    }
  });

  it('un usuario normal ve solo las empresas a las que lo asignaron, no todas las del cliente', async () => {
    const w = await world();
    const adminKtsu = client(ctx, w.ktsu.token);
    const u = await adminKtsu.post('/users', { email: `vend-${Date.now()}@test.local`, fullName: 'Vendedor', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    expect(u.status).toBe(201);
    const s = await login(u.body.data.email);
    expect(names(s.companies)).toEqual(['KTSU']); // JAC es del mismo cliente pero no se le asignó
    const jac = await ctx.http.post('/api/v1/auth/select-company').set(auth(s.accessToken)).send({ companyId: w.jac.companyId });
    expect(jac.status).toBe(403);
    // un usuario normal no puede crear empresas ni ver clientes
    const mk = await ctx.http.post('/api/v1/companies').set(auth(s.accessToken)).send({ rif: uniqueRif(), legalName: 'Nueva' });
    expect(mk.status).toBe(403);
  });

  it('crear una empresa con otra ya seleccionada en la sesión no viola llaves foráneas (regresión)', async () => {
    const t = await createTenant(ctx, 'Sesion activa');
    // sesión propia del administrador global (select-company revoca el token con el que se llama)
    const own = (await ctx.http.post('/api/v1/auth/login').send({ email: 'superadmin@erp.local', password: PASSWORD })).body.data.accessToken;
    const sel = await ctx.http.post('/api/v1/auth/select-company').set(auth(own)).send({ companyId: t.companyId });
    const sup = await client(ctx, sel.body.data.accessToken)
      .post('/companies', { organizationId: t.organizationId, rif: uniqueRif(), legalName: 'Tercera empresa' });
    expect(sup.status).toBe(201);
  });

  it('solo el administrador global crea empresas; cada una nace con su propio cliente, teléfono y correo', async () => {
    const w = await world();
    const s1 = await login(w.c1.adminEmail);
    const denied = await client(ctx, s1.accessToken).post('/companies', { rif: uniqueRif(), legalName: 'Intrusa' });
    expect(denied.status).toBe(403);
    const mk = await ctx.http.post('/api/v1/companies').set(auth(ctx.super))
      .send({ rif: uniqueRif(), legalName: 'Razón Social Nueva C.A.', tradeName: 'Nueva', phone: '0414-1234567', email: 'contacto@nueva.test' });
    expect(mk.status).toBe(201);
    expect(mk.body.data.phone).toBe('0414-1234567'); expect(mk.body.data.email).toBe('contacto@nueva.test');
    const orgs = (await client(ctx, ctx.super).get('/organizations')).body.data;
    expect(orgs.find((o: any) => o.id === mk.body.data.organizationId)?.name).toBe('Nueva');
    // los demás clientes no la ven
    expect(names((await login(w.c2.adminEmail)).companies)).not.toContain('Razón Social Nueva');
  });

  it('Clientes (administradores de empresa): el global crea uno asignado a una empresa; entra solo a esa empresa', async () => {
    const w = await world();
    const email = `cliente-${Date.now()}@test.local`;
    const api = client(ctx, ctx.super);
    const created = await api.post('/clients', { fullName: 'Admin Ayagba', email, password: PASSWORD, companyId: w.aya.companyId });
    expect(created.status).toBe(201);
    const s = await login(email);
    expect(names(s.companies)).toEqual(['Ayagba Glam']);
    const list = (await api.get('/clients')).body.data.find((c: any) => c.email === email);
    expect(list.companies.map((c: any) => c.id)).toEqual([w.aya.companyId]);
    // un administrador de cliente no ve ni crea clientes
    const other = client(ctx, (await login(w.c1.adminEmail)).accessToken);
    expect((await other.get('/clients')).status).toBe(403);
    expect((await other.post('/clients', { fullName: 'X Y', email: `x-${Date.now()}@test.local`, password: PASSWORD, companyId: w.ktsu.companyId })).status).toBe(403);
    // baja: ya no puede entrar
    expect((await api.patch(`/clients/${created.body.data.id}`, { isActive: false })).status).toBe(200);
    expect((await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
  });

  it('no se puede asignar un usuario de otro cliente a una empresa (sin revelar que existe)', async () => {
    const w = await world();
    const api = client(ctx, w.sin.token);
    const r = await api.post('/users', { email: w.aya.adminEmail, fullName: 'Intruso', roleCodes: ['VENDEDOR'] });
    expect(r.status).toBe(422); expect(r.body.error).toBe('USER_NOT_ASSIGNABLE');
    // un correo inexistente produce otro resultado solo si falta la contraseña (no confirma existencia)
    const neu = await api.post('/users', { email: `nuevo-${Date.now()}@test.local`, fullName: 'Nuevo', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    expect(neu.status).toBe(201);
  });

  it('solo el administrador global crea y lista todos los clientes; el de cliente solo ve el suyo', async () => {
    const w = await world();
    const s1 = await login(w.c1.adminEmail);
    const mine = await client(ctx, s1.accessToken).get('/organizations');
    expect(mine.body.data.map((o: any) => o.name)).toEqual(['Cliente KTSU-JAC']);
    expect((await client(ctx, s1.accessToken).post('/organizations', { name: 'Otro cliente' })).status).toBe(403);
    const all = await client(ctx, ctx.super).get('/organizations');
    const nm = all.body.data.map((o: any) => o.name);
    expect(nm).toEqual(expect.arrayContaining(['Cliente KTSU-JAC', 'Cliente Sinocars', 'Cliente Ayagba']));
    // un usuario normal no ve clientes
    const u = await client(ctx, w.ktsu.token).post('/users', { email: `n-${Date.now()}@test.local`, fullName: 'Normal', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    expect(u.status).toBe(201);
    const sn = await login(u.body.data.email);
    expect((await client(ctx, sn.accessToken).get('/organizations')).body.data).toEqual([]);
  });

  it('si le quitan el acceso a la empresa, el refresh ya no conserva esa empresa', async () => {
    const t = await createTenant(ctx, 'Revocable');
    const api = client(ctx, t.token);
    const u = await api.post('/users', { email: `rev-${Date.now()}@test.local`, fullName: 'Rev', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    const s = await ctx.http.post('/api/v1/auth/login').send({ email: u.body.data.email, password: PASSWORD });
    expect(s.body.data.companyId).toBe(t.companyId);
    await api.patch(`/users/${u.body.data.id}`, { isActive: false });
    const r = await ctx.http.post('/api/v1/auth/refresh').send({ refreshToken: s.body.data.refreshToken });
    // sesión revocada al desactivarlo
    expect(r.status).toBe(401);
  });
});
