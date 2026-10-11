import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif } from './helpers';

/** Reglas fiscales acordadas con el negocio: retención de IVA 75 % del contribuyente especial y facturación con impresora fiscal. */
describe('Fiscal: valores por omisión y modo de impresión', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>;
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Reglas fiscales'); api = client(ctx, t.token); b = await seedBasics(api);
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' }) });
  });
  afterAll(async () => { await ctx.close(); });

  it('el contribuyente especial queda con retención de IVA 75 % por omisión y se puede cambiar a 100 %', async () => {
    const c = await api.post('/customers', { rif: uniqueRif('J'), legalName: 'Cliente Especial', isSpecialTaxpayer: true });
    expect(Number(c.body.data.retentionIvaPct)).toBe(75);
    const normal = await api.post('/customers', { rif: uniqueRif('J'), legalName: 'Cliente Ordinario' });
    expect(Number(normal.body.data.retentionIvaPct)).toBe(0);
    // al marcar a un cliente existente como especial se propone 75 %; con un valor explícito se respeta
    const up = await api.patch(`/customers/${normal.body.data.id}`, { isSpecialTaxpayer: true, version: normal.body.data.version });
    expect(Number(up.body.data.retentionIvaPct)).toBe(75);
    const hundred = await api.patch(`/customers/${normal.body.data.id}`, { retentionIvaPct: '100', version: up.body.data.version });
    expect(Number(hundred.body.data.retentionIvaPct)).toBe(100);
    const s = await api.post('/suppliers', { rif: uniqueRif('J'), legalName: 'Proveedor Especial', isSpecialTaxpayer: true, retentionIvaPct: '100' });
    expect(Number(s.body.data.retentionIvaPct)).toBe(100); // valor explícito gana
  });

  it('con impresora fiscal, la factura exige número y serial de la máquina y no consume el control interno', async () => {
    const p = await b.product('FP-1');
    const ch = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '10', unitCost: '5' }] });
    await api.post(`/inventory/charges/${ch.body.data.id}/confirm`);
    const cust = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Fiscal', creditDays: 15, address: 'Caracas' })).body.data.id;
    const mkInvoice = async () => (await api.post('/sales/invoices', { customerId: cust, warehouseId: b.w1, currencyId: b.ves, paymentCondition: 'CREDIT', creditDays: 15, lines: [{ productId: p, quantity: '1', unitPrice: '100' }] })).body.data.id;

    // modo normal (por omisión): numeración interna
    const normalId = await mkInvoice();
    const normal = await api.post(`/sales/invoices/${normalId}/confirm`, {});
    expect(normal.body.data).toMatchObject({ controlNo: expect.stringMatching(/^00-\d{6}$/), fiscalNumber: null, fiscalSerial: null });

    expect((await api.patch('/companies/current', { invoicePrintMode: 'FISCAL_PRINTER', fiscalPrinterModel: 'Máquina de prueba' })).status).toBe(200);
    const id = await mkInvoice();
    const missing = await api.post(`/sales/invoices/${id}/confirm`, {});
    expect(missing.status).toBe(422); expect(missing.body.error).toBe('FISCAL_DATA_REQUIRED');
    const ok = await api.post(`/sales/invoices/${id}/confirm`, { fiscalPrinter: { number: '00012345', serial: 'EQP0001234' } });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ status: 'CONFIRMED', controlNo: null, fiscalNumber: '00012345', fiscalSerial: 'EQP0001234' });

    // nota de débito sobre la factura fiscal también exige los datos de la máquina
    const noDn = await api.post(`/sales/invoices/${id}/debit-note`, { concept: 'Ajuste de precio', amount: '10' });
    expect(noDn.status).toBe(422); expect(noDn.body.error).toBe('FISCAL_DATA_REQUIRED');
    const dn = await api.post(`/sales/invoices/${id}/debit-note`, { concept: 'Ajuste de precio', amount: '10', fiscalPrinter: { number: '00012346', serial: 'EQP0001234' } });
    expect(dn.status).toBe(201); expect(dn.body.data).toMatchObject({ fiscalNumber: '00012346' });
  });
});
