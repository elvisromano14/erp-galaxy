import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, PASSWORD } from './helpers';
import { HousekeepingService } from '../src/modules/alerts/alerts.service';

describe('Alertas y mantenimiento', () => {
  let ctx: Ctx; let api: Api; let companyId: string; let b: Awaited<ReturnType<typeof seedBasics>>;
  const iso = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Alertas'); companyId = t.companyId; api = client(ctx, t.token); b = await seedBasics(api);
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: iso(-40) });
  });
  afterAll(async () => { await ctx.close(); });
  const find = (alerts: any[], code: string) => alerts.find(a => a.code === code);

  it('existencia bajo el mínimo, cuentas por pagar vencidas/por vencer y cotizaciones por vencer', async () => {
    const low = await b.product('AL-LOW', { minStock: '10' });
    const exempt = (await api.get('/taxes?limit=100')).body.data.find((x: any) => x.code === 'EXENTO').id;
    const sup = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor Alertas' })).body.data.id;
    const buy = async (docDate: string, days: number) => {
      const d = await api.post('/purchases', { supplierId: sup, warehouseId: b.w1, currencyId: b.ves, docDate, supplierDocNo: `F-${docDate}`, paymentCondition: 'CREDIT', creditDays: days, lines: [{ productId: low, quantity: '2', unitCost: '50', taxId: exempt }] });
      expect(d.status).toBe(201); expect((await api.post(`/purchases/${d.body.data.id}/confirm`)).status).toBe(201);
    };
    await buy(iso(-20), 5);  // vence hace 15 días → vencida (100 Bs)
    await buy(iso(0), 3);    // vence en 3 días → por vencer (100 Bs)
    const cust = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Alerta' })).body.data.id;
    const q = (await api.post('/sales/quotes', { customerId: cust, currencyId: b.ves, validUntil: iso(2), lines: [{ productId: low, quantity: '1', unitPrice: '5' }] })).body.data.id;
    await api.post(`/sales/quotes/${q}/send`);

    const alerts = (await api.get('/alerts')).body.data as any[];
    expect(find(alerts, 'LOW_STOCK')).toMatchObject({ count: 1, severity: 'warning' });
    expect(find(alerts, 'LOW_STOCK').sample[0].sku).toBe('AL-LOW');
    expect(find(alerts, 'PAYABLES_OVERDUE')).toMatchObject({ count: 1, severity: 'critical' });
    expect(Number(find(alerts, 'PAYABLES_OVERDUE').amountBase)).toBe(100);
    expect(find(alerts, 'PAYABLES_DUE_SOON')).toMatchObject({ count: 1 });
    expect(find(alerts, 'QUOTES_EXPIRING')).toMatchObject({ count: 1 });
    expect(find(alerts, 'EXPIRING_LOTS')).toBeUndefined(); // función de lotes apagada
  });

  it('cada usuario solo ve las alertas de lo que tiene permiso de consultar', async () => {
    const email = `al-${Math.random().toString(36).slice(2, 7)}@test.local`;
    await api.post('/users', { email, fullName: 'Vendedor Alertas', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    const tok = (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken;
    const codes = ((await client(ctx, tok).get('/alerts')).body.data as any[]).map(a => a.code);
    expect(codes).toContain('LOW_STOCK'); expect(codes).toContain('QUOTES_EXPIRING');
    expect(codes).not.toContain('PAYABLES_OVERDUE');
  });

  it('el mantenimiento vence las cotizaciones enviadas cuya vigencia pasó', async () => {
    const p = await b.product('AL-EXP');
    const cust = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Venc' })).body.data.id;
    const mk = async (validUntil: string) => {
      const id = (await api.post('/sales/quotes', { customerId: cust, currencyId: b.ves, validUntil, lines: [{ productId: p, quantity: '1', unitPrice: '5' }] })).body.data.id;
      await api.post(`/sales/quotes/${id}/send`); return id;
    };
    const old = await mk(iso(10)); const fresh = await mk(iso(10));
    // se atrasa la vigencia directamente en BD (la API no permite fechas vencidas en un documento enviado)
    await ctx.prisma.runWithTenant(companyId, tx => tx.$executeRaw`UPDATE sales_documents SET valid_until = ${iso(-1)}::date WHERE id = ${old}::uuid`);
    const n = await ctx.app.get(HousekeepingService).expireQuotes();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await api.get(`/sales/quotes/${old}`)).body.data.status).toBe('EXPIRED');
    expect((await api.get(`/sales/quotes/${fresh}`)).body.data.status).toBe('SENT');
  });
});
