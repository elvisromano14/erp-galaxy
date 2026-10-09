import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, PASSWORD } from './helpers';

describe('Cuentas por cobrar y cobros', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let customerId: string; let bankVes: string; let bankUsd: string;
  let cash: string; let withholding: string; let credit: string;
  const iso = (n = 0) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Cobranza'); api = client(ctx, t.token); b = await seedBasics(api);
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: iso(-60) });
    customerId = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Deudor', creditDays: 30 })).body.data.id;
    const bank = (await api.get('/banks?limit=5')).body.data[0].id;
    bankVes = (await api.post('/bank-accounts', { bankId: bank, name: 'Bs', number: '01020000000000000011', currencyId: b.ves, openingBalance: '0' })).body.data.id;
    bankUsd = (await api.post('/bank-accounts', { bankId: bank, name: 'USD', number: '01020000000000000012', currencyId: b.usd, openingBalance: '0' })).body.data.id;
    cash = (await api.post('/payment-methods', { code: 'TRF', name: 'Transferencia', type: 'TRANSFER' })).body.data.id;
    withholding = (await api.post('/payment-methods', { code: 'RET', name: 'Retención IVA', type: 'WITHHOLDING' })).body.data.id;
    credit = (await api.post('/payment-methods', { code: 'CRD', name: 'Crédito', type: 'CREDIT' })).body.data.id;
  });
  afterAll(async () => { await ctx.close(); });

  const opening = async (documentNo: string, amount: string, extra: object = {}) => {
    const r = await api.post('/treasury/receivables/opening', { customerId, documentNo, issueDate: iso(-45), currencyId: b.ves, amount, ...extra });
    expect(r.status).toBe(201);
    return r.body.data;
  };
  const balance = async (acc: string) => Number((await api.get('/treasury/accounts/balances')).body.data.find((x: any) => x.id === acc).balance);
  const receipt = (apps: object[], extra: object = {}) => api.post('/treasury/receipts', { customerId, paymentMethodId: cash, bankAccountId: bankVes, currencyId: b.ves, applications: apps, ...extra });
  const open = async () => (await api.get(`/treasury/receivables/open?customerId=${customerId}`)).body.data as any[];

  it('saldo inicial, cobro parcial y total con ingreso al banco', async () => {
    const e = await opening('SI-001', '1000');
    expect(e).toMatchObject({ entryType: 'OPENING', status: 'OPEN' }); expect(e.dueDate.slice(0, 10)).toBe(iso(-15)); // emisión −45 + 30 días de crédito
    expect((await api.post('/treasury/receivables/opening', { customerId, documentNo: 'SI-001', issueDate: iso(-45), currencyId: b.ves, amount: '5' })).body.error).toBe('DUPLICATE_DOCUMENT');
    const r1 = await receipt([{ receivableEntryId: e.id, amount: '400' }], { reference: 'TRF-1' });
    expect(r1.status).toBe(201); expect(r1.body.data).toMatchObject({ status: 'CONFIRMED', number: expect.stringMatching(/^REC-\d{6}$/) });
    expect(await balance(bankVes)).toBe(400);
    expect((await open()).find(x => x.id === e.id)).toMatchObject({ status: 'PARTIALLY_PAID' });
    expect((await receipt([{ receivableEntryId: e.id, amount: '600.01' }])).body.error).toBe('EXCEEDS_BALANCE');
    expect((await receipt([{ receivableEntryId: e.id, amount: '600' }])).status).toBe(201);
    expect(await balance(bankVes)).toBe(1000);
    expect((await open()).find(x => x.id === e.id)).toBeUndefined();
    expect((await api.post(`/treasury/receivables/${e.id}/cancel`, { reason: 'carga errónea' })).body.error).toBe('HAS_APPLICATIONS');
  });

  it('anular un cobro restituye el saldo y contra-asienta el banco', async () => {
    const e = await opening('SI-002', '300');
    const before = await balance(bankVes);
    const r = (await receipt([{ receivableEntryId: e.id, amount: '300' }])).body.data;
    expect(await balance(bankVes)).toBe(before + 300);
    expect((await api.post(`/treasury/receipts/${r.id}/cancel`, { reason: 'error' })).body.data.status).toBe('CANCELLED');
    expect(await balance(bankVes)).toBe(before);
    expect((await open()).find(x => x.id === e.id)).toMatchObject({ status: 'OPEN', balance: '300' });
    expect((await api.post(`/treasury/receipts/${r.id}/cancel`, { reason: 'otra' })).status).toBe(422);
    // un saldo inicial sin cobros sí se anula
    expect((await api.post(`/treasury/receivables/${e.id}/cancel`, { reason: 'carga errónea' })).body.data.status).toBe('CANCELLED');
  });

  it('retención del cliente no mueve banco; moneda distinta convierte; validaciones', async () => {
    const e = await opening('SI-003', '800');
    const before = await balance(bankVes);
    expect((await receipt([{ receivableEntryId: e.id, amount: '100' }], { paymentMethodId: withholding })).body.error).toBe('REFERENCE_REQUIRED');
    const w = await receipt([{ receivableEntryId: e.id, amount: '100' }], { paymentMethodId: withholding, bankAccountId: null, reference: 'COMP-RET-1' });
    expect(w.status).toBe(201); expect(Number(w.body.data.amount)).toBe(100);
    expect(await balance(bankVes)).toBe(before);
    // cobro en USD de una deuda en Bs: 5 USD × 40 = 200 Bs
    await api.post('/treasury/movements', { bankAccountId: bankUsd, kind: 'DEPOSIT', amount: '0.01' }); // cuenta con movimiento (no necesario, solo prueba el libro)
    const usd = await receipt([{ receivableEntryId: e.id, amount: '200' }], { currencyId: b.usd, bankAccountId: bankUsd });
    expect(usd.status).toBe(201); expect(Number(usd.body.data.amount)).toBe(5);
    expect(await balance(bankUsd)).toBeCloseTo(5.01, 2);
    expect((await receipt([{ receivableEntryId: e.id, amount: '10' }], { bankAccountId: bankUsd })).body.error).toBe('BANK_CURRENCY_MISMATCH');
    expect((await receipt([{ receivableEntryId: e.id, amount: '10' }], { paymentMethodId: credit })).body.error).toBe('PAYMENT_METHOD_INVALID');
    expect((await receipt([{ receivableEntryId: e.id, amount: '10' }], { bankAccountId: null })).body.error).toBe('BANK_ACCOUNT_REQUIRED');
  });

  it('una nota de crédito (saldo a favor) se compensa en el cobro', async () => {
    const inv = await opening('SI-004', '500'); const nc = await opening('SI-NC', '-200');
    const before = await balance(bankVes);
    const r = await receipt([{ receivableEntryId: inv.id, amount: '500' }, { receivableEntryId: nc.id, amount: '-200' }]);
    expect(r.status).toBe(201); expect(Number(r.body.data.amount)).toBe(300);
    expect(await balance(bankVes)).toBe(before + 300);
    expect((await receipt([{ receivableEntryId: nc.id, amount: '-1' }])).status).toBe(422);
  });

  it('reportes de cuentas por cobrar y el límite de crédito considera la deuda abierta', async () => {
    const cid = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Limite', creditLimit: '1000', creditDays: 10 })).body.data.id;
    const r = await api.post('/treasury/receivables/opening', { customerId: cid, documentNo: 'SI-L1', issueDate: iso(-100), currencyId: b.ves, amount: '900' });
    expect(r.status).toBe(201);
    const p = await b.product('CX-1');
    const order = (await api.post('/sales/orders', { customerId: cid, currencyId: b.ves, paymentCondition: 'CREDIT', lines: [{ productId: p, quantity: '1', unitPrice: '100' }] })).body.data.id; // 116 → 900 + 116 > 1000
    const ex = await api.post(`/sales/orders/${order}/confirm`);
    expect(ex.status).toBe(422); expect(ex.body.error).toBe('CREDIT_LIMIT_EXCEEDED');

    const rows = (x: any) => x.body.data.rows as Record<string, any>[];
    const recv = rows(await api.get(`/reports/customers/receivables?customerId=${cid}`));
    expect(recv).toHaveLength(1); expect(recv[0]).toMatchObject({ document_no: 'SI-L1', type: 'Saldo inicial' }); expect(Number(recv[0].days_overdue)).toBe(90); // vence a los 10 días de −100
    const aging = rows(await api.get(`/reports/customers/aging?customerId=${cid}`))[0];
    expect(Number(aging.d61_90)).toBe(900); expect(Number(aging.d90)).toBe(0); // 90 días de atraso → tramo 61–90
    const exposure = rows(await api.get('/reports/customers/credit-exposure')).find(x => x.customer === 'Cliente Limite')!;
    expect(Number(exposure.receivable_bs)).toBe(900); expect(Number(exposure.available)).toBe(100);
    // estado de cuenta con cobro: saldo final cuadra con lo abierto
    const rc = await api.post('/treasury/receipts', { customerId: cid, paymentMethodId: cash, bankAccountId: bankVes, currencyId: b.ves, applications: [{ receivableEntryId: r.body.data.id, amount: '400' }] });
    expect(rc.status).toBe(201);
    const st = (await api.get(`/reports/customers/statement?customerId=${cid}`)).body.data;
    expect(st.rows.map((x: any) => x.type)).toEqual(['Saldo inicial', 'Cobro']);
    expect(Number(st.totals.balance_bs)).toBe(500);
  });

  it('permisos: el vendedor no ve cobros; el contador solo consulta', async () => {
    const mk = async (role: string) => {
      const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@test.local`;
      expect((await api.post('/users', { email, fullName: `Usuario ${role}`, password: PASSWORD, roleCodes: [role] })).status).toBe(201);
      return client(ctx, (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken);
    };
    const vend = await mk('VENDEDOR'); const cont = await mk('CONTADOR');
    expect((await vend.get('/treasury/receipts')).status).toBe(403);
    expect((await cont.get('/treasury/receivables')).status).toBe(200);
    expect((await cont.post('/treasury/receipts', {})).status).toBe(403);
  });
});
