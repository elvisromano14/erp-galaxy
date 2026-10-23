import { createHash, randomUUID } from 'node:crypto';
import { bootstrap, Ctx, createTenant, client, Api, uniqueRif, PASSWORD, auth } from './helpers';

/** A1: cuentas de servicio, lotes idempotentes, referencias externas y eventos de salida (integración con Saint). */
describe('Integración (A1): cuenta de servicio, upsert por lote, referencias y eventos', () => {
  let ctx: Ctx; let admin: Api; let tenant: Awaited<ReturnType<typeof createTenant>>;
  let svc: Api; let svcToken: string; let clientId: string; let clientSecret: string; let accountId: string;
  const CONNECTOR = 'electrosur';

  const serviceToken = (id: string, secret: string) => ctx.http.post('/api/v1/auth/service-token').send({ clientId: id, clientSecret: secret });
  const upsert = (entity: 'customers' | 'suppliers', items: object[], extra: object = {}, idem?: string, who: Api = svc) =>
    who.post(`/integration/${entity}/upsert-batch`, { system: 'SAINT', connector: CONNECTOR, items, ...extra }, idem ? { 'Idempotency-Key': idem } : {});
  const item = (key: string, data: object, over: object = {}) => ({ externalKey: key, origin: 'SAINT', hash: createHash('sha256').update(JSON.stringify([key, data])).digest('hex'), data, ...over });
  const events = (q = '', who: Api = svc) => who.get(`/integration/events${q}`);

  beforeAll(async () => {
    ctx = await bootstrap();
    tenant = await createTenant(ctx, 'Integra'); admin = client(ctx, tenant.token);
  });
  afterAll(async () => { await ctx.close(); });

  describe('cuenta de servicio', () => {
    it('solo quien administra cuentas de servicio puede crearla; el secreto se muestra una sola vez', async () => {
      const gerente = await admin.post('/users', { email: `ger-${Date.now()}@test.local`, fullName: 'Gerente', password: PASSWORD, roleCodes: ['GERENTE'] });
      expect(gerente.status).toBe(201);
      const gToken = (await ctx.http.post('/api/v1/auth/login').send({ email: gerente.body.data.email, password: PASSWORD })).body.data.accessToken;
      const denied = await client(ctx, gToken).post('/integration/service-accounts', { name: 'Intento' });
      expect(denied.status).toBe(403);

      const created = await admin.post('/integration/service-accounts', { name: 'Integrador Saint' });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ name: 'Integrador Saint', active: true, clientId: expect.stringMatching(/^svc_/), clientSecret: expect.stringMatching(/^erpsvc_/) });
      ({ clientId, clientSecret, id: accountId } = created.body.data);
      const list = await admin.get('/integration/service-accounts');
      expect(list.body.data).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(clientSecret);
      expect(list.body.data[0].clientSecret).toBeUndefined();
    });

    it('una empresa tiene una sola cuenta de servicio activa', async () => {
      const again = await admin.post('/integration/service-accounts', { name: 'Otra' });
      expect(again.status).toBe(409); expect(again.body.error).toBe('SERVICE_ACCOUNT_EXISTS');
    });

    it('el token de servicio se obtiene con client_id + secreto; credenciales malas dan 401 sin pistas', async () => {
      const bad = await serviceToken(clientId, 'erpsvc_secreto-incorrecto-xxxxxxxxxxxx');
      expect(bad.status).toBe(401); expect(bad.body.error).toBe('INVALID_CREDENTIALS');
      const unknown = await serviceToken('svc_no-existe-00000', 'erpsvc_secreto-incorrecto-xxxxxxxxxxxx');
      expect(unknown.status).toBe(401); expect(unknown.body.error).toBe('INVALID_CREDENTIALS');
      const ok = await serviceToken(clientId, clientSecret);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ accessToken: expect.any(String), expiresIn: expect.any(Number) });
      expect(ok.body.data.refreshToken).toBeUndefined(); // sin refresh: se pide uno nuevo
      svcToken = ok.body.data.accessToken; svc = client(ctx, svcToken);
    });

    it('el usuario de servicio no entra por clave, no figura entre los usuarios y solo tiene permisos mínimos', async () => {
      const users = (await admin.get('/users')).body.data as Array<{ email: string }>;
      expect(users.some(u => u.email.endsWith('@integration.invalid'))).toBe(false);
      const login = await ctx.http.post('/api/v1/auth/login').send({ email: `${clientId}@integration.invalid`, password: PASSWORD });
      expect(login.status).toBe(401);
      expect((await svc.get('/users')).status).toBe(403);
      expect((await svc.post('/integration/service-accounts', { name: 'Escalada' })).status).toBe(403);
      expect((await svc.post('/integration/enabled', { enabled: false })).status).toBe(403);
      expect((await svc.get('/integration/status')).status).toBe(200);
    });

    it('rotar invalida el secreto anterior; revocar corta el acceso', async () => {
      const rotated = await admin.post(`/integration/service-accounts/${accountId}/rotate`, {});
      expect(rotated.status).toBe(200); expect(rotated.body.data.clientSecret).not.toBe(clientSecret);
      expect((await serviceToken(clientId, clientSecret)).status).toBe(401);
      clientSecret = rotated.body.data.clientSecret;
      expect((await serviceToken(clientId, clientSecret)).status).toBe(200);
      const revoked = await admin.post(`/integration/service-accounts/${accountId}/revoke`, {});
      expect(revoked.body.data).toMatchObject({ active: false });
      expect((await serviceToken(clientId, clientSecret)).status).toBe(401);
      // Tras revocar, la empresa puede crear una nueva cuenta
      const fresh = await admin.post('/integration/service-accounts', { name: 'Integrador Saint (nueva)' });
      expect(fresh.status).toBe(201);
      ({ clientId, clientSecret, id: accountId } = fresh.body.data);
      const t = await serviceToken(clientId, clientSecret);
      svcToken = t.body.data.accessToken; svc = client(ctx, svcToken);
    });
  });

  describe('upsert por lote: clientes', () => {
    const rif1 = uniqueRif('J'); const rif2 = uniqueRif('J'); const rif3 = uniqueRif('J');
    let erpId1: string;

    it('un lote mixto devuelve un resultado por elemento sin tumbarse', async () => {
      const res = await upsert('customers', [
        item('C-001', { rif: rif1, legalName: 'Cliente Uno C.A.', creditDays: 30, isSpecialTaxpayer: true }),
        item('C-001', { rif: rif1, legalName: 'Repetido' }),                         // clave repetida en el lote
        item('C-002', { rif: rif2 }),                                                  // falta legalName
        item('C-003', { rif: 'P0000001', legalName: 'Pasaporte de Prueba', personType: 'NATURAL' }), // RIF no válido → PENDING
        item('C-004', { rif: rif3, legalName: 'Cliente Cuatro', sellerId: randomUUID() }),         // vendedor inexistente
      ]);
      expect(res.status).toBe(200);
      const r = res.body.data.results as any[];
      expect(r.map(x => x.result)).toEqual(['CREATED', 'REJECTED', 'REJECTED', 'CREATED', 'REJECTED']);
      expect(r[1].code).toBe('DUPLICATE_IN_BATCH');
      expect(r[2].code).toBe('VALIDATION_ERROR'); expect(r[2].errors[0].field).toBe('legalName');
      expect(r[3].warnings[0]).toMatch(/PENDING/);
      expect(r[4].code).toBe('INVALID_REFERENCE');
      expect(res.body.data.summary).toEqual({ received: 5, created: 2, updated: 0, unchanged: 0, linked: 0, rejected: 3 });
      erpId1 = r[0].erpId;

      const cust = (await admin.get(`/customers/${erpId1}`)).body.data;
      expect(cust).toMatchObject({ legalName: 'Cliente Uno C.A.', isSpecialTaxpayer: true, retentionIvaPct: '75', validationStatus: 'VALIDATED', version: 1 });
      const pend = (await admin.get('/customers?filter[validationStatus]=PENDING')).body.data;
      expect(pend.map((c: any) => c.legalName)).toContain('Pasaporte de Prueba');
      expect(pend.find((c: any) => c.legalName === 'Pasaporte de Prueba').rif).toBe('P0000001');
      // lo rechazado no dejó nada
      expect((await admin.get('/customers?search=Cuatro')).body.data).toHaveLength(0);
    });

    it('mismo hash → UNCHANGED; contenido distinto → UPDATED con versión nueva; expectedVersion desfasada → VERSION_CONFLICT', async () => {
      const same = (await upsert('customers', [item('C-001', { rif: rif1, legalName: 'Cliente Uno C.A.', creditDays: 30, isSpecialTaxpayer: true })])).body.data.results[0];
      expect(same).toMatchObject({ result: 'UNCHANGED', erpId: erpId1, version: 1 });
      const changed = (await upsert('customers', [item('C-001', { rif: rif1, legalName: 'Cliente Uno, C.A. (nuevo nombre)', creditDays: 45 })])).body.data.results[0];
      expect(changed).toMatchObject({ result: 'UPDATED', erpId: erpId1, version: 2 });
      expect((await admin.get(`/customers/${erpId1}`)).body.data).toMatchObject({ legalName: 'Cliente Uno, C.A. (nuevo nombre)', creditDays: 45, version: 2 });
      const stale = (await upsert('customers', [item('C-001', { rif: rif1, legalName: 'Otro nombre', creditDays: 1 }, { expectedVersion: 1 })])).body.data.results[0];
      expect(stale).toMatchObject({ result: 'REJECTED', code: 'VERSION_CONFLICT', version: 2 });
      expect((await admin.get(`/customers/${erpId1}`)).body.data.legalName).toBe('Cliente Uno, C.A. (nuevo nombre)');
    });

    it('baja: isActive=false desactiva sin borrar y emite DEACTIVATE', async () => {
      const r = (await upsert('customers', [item('C-001', { rif: rif1, legalName: 'Cliente Uno, C.A. (nuevo nombre)', creditDays: 45, isActive: false })])).body.data.results[0];
      expect(r.result).toBe('UPDATED');
      const row = (await admin.get(`/customers/${erpId1}`)).body.data;
      expect(row.isActive).toBe(false); expect(row.deletedAt).toBeNull();
      const ev = (await events('?includeIntegration=true&entity=customer')).body.data.events as any[];
      expect(ev.filter(e => e.entityId === erpId1).map(e => e.op)).toEqual(['CREATE', 'UPDATE', 'DEACTIVATE']);
    });

    it('Idempotency-Key: misma clave y mismo cuerpo repite la respuesta sin duplicar; otro cuerpo da 409', async () => {
      const key = `batch-${randomUUID()}`;
      const rif = uniqueRif('J');
      const body = [item('C-IDEM', { rif, legalName: 'Cliente Idempotente' })];
      const first = await upsert('customers', body, {}, key);
      const second = await upsert('customers', body, {}, key);
      expect(first.status).toBe(200); expect(second.status).toBe(200);
      expect(second.body.data.results[0].erpId).toBe(first.body.data.results[0].erpId);
      expect((await admin.get('/customers?search=Idempotente')).body.data).toHaveLength(1);
      const other = await upsert('customers', [item('C-IDEM', { rif, legalName: 'Distinto' })], {}, key);
      expect(other.status).toBe(409); expect(other.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('vincula por clave natural (RIF) sin pisar datos y rechaza el RIF ya vinculado a otra clave externa', async () => {
      const rif = uniqueRif('J');
      const own = (await admin.post('/customers', { rif, legalName: 'Nacido en el ERP', creditDays: 10 })).body.data;
      const link = (await upsert('customers', [item('C-LINK', { rif, legalName: 'Nombre de Saint', creditDays: 99 })])).body.data.results[0];
      expect(link).toMatchObject({ result: 'LINKED', erpId: own.id });
      expect((await admin.get(`/customers/${own.id}`)).body.data).toMatchObject({ legalName: 'Nacido en el ERP', creditDays: 10 }); // REF_ONLY: no se tocó
      const dup = (await upsert('customers', [item('C-OTRO-CODIGO', { rif, legalName: 'Mismo RIF, otro código de Saint' })])).body.data.results[0];
      expect(dup).toMatchObject({ result: 'REJECTED', code: 'DUPLICATE_NATURAL_KEY', existingErpId: own.id, otherExternalKey: 'C-LINK' });
      // Ya vinculado, el siguiente envío con otro contenido sí actualiza
      const upd = (await upsert('customers', [item('C-LINK', { rif, legalName: 'Nombre de Saint', creditDays: 99 })])).body.data.results[0];
      expect(upd).toMatchObject({ result: 'UPDATED', erpId: own.id });
      expect((await admin.get(`/customers/${own.id}`)).body.data).toMatchObject({ legalName: 'Nombre de Saint', creditDays: 99 });
      // REF_AND_UPDATE aplica los datos en el mismo paso
      const rif2 = uniqueRif('J');
      const own2 = (await admin.post('/customers', { rif: rif2, legalName: 'Otro del ERP' })).body.data;
      const l2 = (await upsert('customers', [item('C-LINK2', { rif: rif2, legalName: 'Con datos de Saint' })], { linkMode: 'REF_AND_UPDATE' })).body.data.results[0];
      expect(l2).toMatchObject({ result: 'LINKED', erpId: own2.id });
      expect((await admin.get(`/customers/${own2.id}`)).body.data.legalName).toBe('Con datos de Saint');
    });

    it('get-batch y refs devuelven las referencias externas', async () => {
      const g = await svc.post('/integration/customers/get-batch', { system: 'SAINT', externalKeys: ['C-001', 'C-NO-EXISTE'] });
      expect(g.status).toBe(200);
      expect(g.body.data.items).toHaveLength(1);
      expect(g.body.data.items[0]).toMatchObject({ id: erpId1, externalRefs: [{ system: 'SAINT', connector: CONNECTOR, key: 'C-001', origin: 'SAINT' }] });
      expect(g.body.data.notFound).toEqual(['C-NO-EXISTE']);
      const r = await svc.get(`/integration/refs?entity=customers&entityId=${erpId1}`);
      expect(r.body.data).toEqual([expect.objectContaining({ externalKey: 'C-001', connector: CONNECTOR })]);
    });
  });

  describe('upsert por lote: proveedores', () => {
    it('crea, deja PENDING el RIF no válido y se filtra por validación', async () => {
      const rif = uniqueRif('J');
      const res = (await upsert('suppliers', [
        item('P-001', { rif, legalName: 'Proveedor Uno', isIslrSubject: true, creditDays: 15 }),
        item('P-002', { rif: '00000001', legalName: 'Persona Natural Sin Letra', personType: 'NATURAL' }),
      ])).body.data;
      expect(res.results.map((x: any) => x.result)).toEqual(['CREATED', 'CREATED']);
      const s1 = (await admin.get(`/suppliers/${res.results[0].erpId}`)).body.data;
      expect(s1).toMatchObject({ legalName: 'Proveedor Uno', isIslrSubject: true, validationStatus: 'VALIDATED', version: 1 });
      const pend = (await admin.get('/suppliers?filter[validationStatus]=PENDING')).body.data;
      expect(pend.map((s: any) => s.legalName)).toEqual(['Persona Natural Sin Letra']);
    });

    it('el CRUD normal de proveedores sigue funcionando, ahora con versión y validationStatus', async () => {
      const created = await admin.post('/suppliers', { rif: uniqueRif('J'), legalName: 'Proveedor Manual' });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ validationStatus: 'VALIDATED', version: 1 });
      const upd = await admin.patch(`/suppliers/${created.body.data.id}`, { legalName: 'Proveedor Manual 2' });
      expect(upd.body.data.version).toBe(2);
    });
  });

  describe('eventos de salida', () => {
    it('lo que escribe el integrador no vuelve a él; lo que escribe el ERP sí', async () => {
      const before = (await events('')).body.data;
      const rif = uniqueRif('J');
      const mine = (await upsert('customers', [item('C-EVT-INT', { rif, legalName: 'Escrito por el integrador' })])).body.data.results[0];
      const erpBorn = (await admin.post('/customers', { rif: uniqueRif('J'), legalName: 'Escrito por el ERP' })).body.data;
      const after = (await events(`?after=${before.nextCursor}`)).body.data;
      expect(after.events.map((e: any) => e.entityId)).toEqual([erpBorn.id]);
      expect(after.events[0]).toMatchObject({ op: 'CREATE', origin: 'ERP', entity: 'customer', version: 1 });
      expect(after.nextCursor).toBeGreaterThan(before.nextCursor);
      // con includeIntegration se ven los dos
      const all = (await events(`?after=${before.nextCursor}&includeIntegration=true`)).body.data.events as any[];
      expect(all.map(e => e.origin)).toEqual(['INTEGRATION', 'ERP']);
      expect(all[0].entityId).toBe(mine.erpId);
    });

    it('editar y dar de baja desde el ERP emite UPDATE y DEACTIVATE; el cursor no retrocede', async () => {
      const c = (await admin.post('/customers', { rif: uniqueRif('J'), legalName: 'Para editar' })).body.data;
      const mark = (await events('')).body.data.nextCursor;
      await admin.patch(`/customers/${c.id}`, { legalName: 'Editado' });
      await admin.patch(`/customers/${c.id}`, { isActive: false });
      await admin.del(`/customers/${c.id}`);
      const ev = (await events(`?after=${mark}&entity=customer`)).body.data.events as any[];
      expect(ev.map(e => e.op)).toEqual(['UPDATE', 'DEACTIVATE', 'DEACTIVATE']);
      expect(ev[0].version).toBe(2);
      expect((await events(`?after=${ev[ev.length - 1].seq}`)).body.data.events).toEqual([]);
    });

    it('la importación masiva también emite eventos', async () => {
      const mark = (await events('')).body.data.nextCursor;
      const rif = uniqueRif('J');
      const csv = Buffer.from(`rif;razon_social\r\n${rif};Importado por Archivo\r\n`, 'utf8');
      const up = await ctx.http.post('/api/v1/imports/customers?mode=commit&onExisting=skip').set(auth(tenant.token)).attach('file', csv, 'clientes.csv');
      expect(up.status).toBe(201); expect(up.body.data.committed).toBe(true);
      const created = (await admin.get('/customers?search=Importado por Archivo')).body.data[0];
      const ev1 = (await events(`?after=${mark}&entity=customer`)).body.data.events as any[];
      expect(ev1.map(e => [e.entityId, e.op, e.origin])).toEqual([[created.id, 'CREATE', 'ERP']]);
      // y al actualizar por archivo
      const mark2 = (await events('')).body.data.nextCursor;
      const csv2 = Buffer.from(`rif;razon_social;dias_credito\r\n${rif};Importado por Archivo;20\r\n`, 'utf8');
      await ctx.http.post('/api/v1/imports/customers?mode=commit&onExisting=update').set(auth(tenant.token)).attach('file', csv2, 'clientes2.csv');
      const ev2 = (await events(`?after=${mark2}&entity=customer`)).body.data.events as any[];
      expect(ev2.map(e => [e.entityId, e.op, e.version])).toEqual([[created.id, 'UPDATE', 2]]);
    });
  });

  describe('seguridad y aislamiento', () => {
    it('otra empresa no ve las referencias, eventos ni registros de ésta', async () => {
      const other = await createTenant(ctx, 'Ajena'); const otherAdmin = client(ctx, other.token);
      const acc = (await otherAdmin.post('/integration/service-accounts', { name: 'Integrador ajeno' })).body.data;
      const t = (await serviceToken(acc.clientId, acc.clientSecret)).body.data.accessToken;
      const otherSvc = client(ctx, t);
      expect((await otherSvc.get('/integration/events')).body.data.events).toEqual([]);
      expect((await otherSvc.get('/integration/refs?entity=customers&externalKey=C-001')).body.data).toEqual([]);
      const mine = (await svc.post('/integration/customers/get-batch', { system: 'SAINT', externalKeys: ['C-001'] })).body.data.items[0].id;
      const g = await otherSvc.post('/integration/customers/get-batch', { system: 'SAINT', ids: [mine] });
      expect(g.body.data.items).toEqual([]);
      // La misma clave externa puede existir en las dos empresas sin chocar
      const r = await otherSvc.post('/integration/customers/upsert-batch', { system: 'SAINT', connector: 'sinocars', items: [item('C-001', { rif: uniqueRif('J'), legalName: 'Cliente de la otra empresa' })] });
      expect(r.body.data.results[0].result).toBe('CREATED');
    });

    it('interruptor por empresa: pausar corta tokens y llamadas; reanudar lo restablece', async () => {
      expect((await admin.post('/integration/enabled', { enabled: false })).body.data).toEqual({ enabled: false });
      const tok = await serviceToken(clientId, clientSecret);
      expect(tok.status).toBe(403); expect(tok.body.error).toBe('INTEGRATION_DISABLED');
      const call = await svc.get('/integration/events');
      expect(call.status).toBe(422); expect(call.body.error).toBe('INTEGRATION_DISABLED');
      expect((await admin.get('/integration/status')).status).toBe(200);
      expect((await admin.post('/integration/enabled', { enabled: true })).body.data).toEqual({ enabled: true });
      expect((await serviceToken(clientId, clientSecret)).status).toBe(200);
      expect((await svc.get('/integration/events')).status).toBe(200);
    });

    it('status resume referencias, pendientes y cuentas', async () => {
      const st = (await svc.get('/integration/status')).body.data;
      expect(st.enabled).toBe(true);
      expect(st.refs).toEqual(expect.arrayContaining([expect.objectContaining({ entity: 'customer', system: 'SAINT' }), expect.objectContaining({ entity: 'supplier', system: 'SAINT' })]));
      expect(st.pending.customers).toBeGreaterThanOrEqual(1);
      expect(st.serviceAccounts.some((a: any) => a.clientId === clientId)).toBe(true);
      expect(st.lastEvent.seq).toBeGreaterThan(0);
    });

    it('sin token o con un token de usuario sin el permiso, la API de integración responde 401 o 403', async () => {
      expect((await ctx.http.get('/api/v1/integration/status')).status).toBe(401);
      const vend = await admin.post('/users', { email: `v-${Date.now()}@test.local`, fullName: 'Vendedor', password: PASSWORD, roleCodes: ['VENDEDOR'] });
      const vToken = (await ctx.http.post('/api/v1/auth/login').send({ email: vend.body.data.email, password: PASSWORD })).body.data.accessToken;
      expect((await client(ctx, vToken).get('/integration/status')).status).toBe(403);
    });
  });
});
