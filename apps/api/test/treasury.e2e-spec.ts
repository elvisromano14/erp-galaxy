import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, PASSWORD } from './helpers';

describe('Tesorería: pagos a proveedores, bancos y conciliación', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let supplierId: string; let product: string; let exempt: string;
  let bankVes: string; let bankUsd: string; let method: string; let methodRef: string; let methodCredit: string;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Tesoreria'); api = client(ctx, t.token); b = await seedBasics(api);
    exempt = (await api.get('/taxes?limit=100')).body.data.find((x: any) => x.code === 'EXENTO').id;
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today() });
    supplierId = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor Pagos', creditDays: 15 })).body.data.id;
    product = await b.product('TES-1');
    const bank = (await api.get('/banks?limit=5')).body.data[0].id;
    bankVes = (await api.post('/bank-accounts', { bankId: bank, name: 'Cuenta Bs', number: '01020000000000000001', currencyId: b.ves, openingBalance: '1000' })).body.data.id;
    bankUsd = (await api.post('/bank-accounts', { bankId: bank, name: 'Cuenta USD', number: '01020000000000000002', currencyId: b.usd, openingBalance: '0' })).body.data.id;
    method = (await api.post('/payment-methods', { code: 'TRF', name: 'Transferencia', type: 'TRANSFER' })).body.data.id;
    methodRef = (await api.post('/payment-methods', { code: 'TRF-R', name: 'Transferencia con ref', type: 'TRANSFER', requiresReference: true })).body.data.id;
    methodCredit = (await api.post('/payment-methods', { code: 'CRD', name: 'Crédito', type: 'CREDIT' })).body.data.id;
  });
  afterAll(async () => { await ctx.close(); });

  /** Compra a crédito exenta (sin IVA) → CxP con ese monto. */
  const purchase = async (qty: number, cost: number, cur = b.ves) => {
    const d = await api.post('/purchases', { supplierId, warehouseId: b.w1, currencyId: cur, supplierDocNo: `F-${Math.random()}`, paymentCondition: 'CREDIT', creditDays: 15, lines: [{ productId: product, quantity: String(qty), unitCost: String(cost), taxId: exempt }] });
    expect(d.status).toBe(201);
    expect((await api.post(`/purchases/${d.body.data.id}/confirm`)).status).toBe(201);
    const open = (await api.get(`/treasury/payables/open?supplierId=${supplierId}`)).body.data as any[];
    return open.find(e => e.purchaseDocumentId === d.body.data.id);
  };
  const balance = async (acc: string) => Number((await api.get('/treasury/accounts/balances')).body.data.find((x: any) => x.id === acc).balance);
  const pay = (apps: object[], extra: object = {}) => api.post('/treasury/payments', { supplierId, paymentMethodId: method, bankAccountId: bankVes, currencyId: b.ves, applications: apps, ...extra });

  it('pago parcial y total de una cuenta por pagar, con movimiento bancario', async () => {
    const e = await purchase(10, 50); // 500 Bs
    expect(Number(e.balance)).toBe(500); expect(e.document.supplierDocNo).toMatch(/^F-/);
    const p1 = await pay([{ payableEntryId: e.id, amount: '200' }], { reference: 'REF-1' });
    expect(p1.status).toBe(201);
    expect(p1.body.data).toMatchObject({ status: 'CONFIRMED', number: expect.stringMatching(/^PAGO-\d{6}$/) });
    expect(Number(p1.body.data.amount)).toBe(200);
    expect(await balance(bankVes)).toBe(800);
    let open = (await api.get(`/treasury/payables/open?supplierId=${supplierId}`)).body.data.find((x: any) => x.id === e.id);
    expect(open).toMatchObject({ status: 'PARTIALLY_PAID' }); expect(Number(open.balance)).toBe(300);
    // no se puede pagar más del saldo
    const over = await pay([{ payableEntryId: e.id, amount: '300.01' }]);
    expect(over.status).toBe(422); expect(over.body.error).toBe('EXCEEDS_BALANCE');
    expect((await pay([{ payableEntryId: e.id, amount: '300' }])).status).toBe(201);
    expect((await api.get(`/treasury/payables/open?supplierId=${supplierId}`)).body.data.find((x: any) => x.id === e.id)).toBeUndefined();
    expect(await balance(bankVes)).toBe(500);
  });

  it('anular un pago devuelve el saldo y contra-asienta el banco', async () => {
    const e = await purchase(2, 100); // 200
    const before = await balance(bankVes);
    const p = (await pay([{ payableEntryId: e.id, amount: '200' }])).body.data;
    expect(await balance(bankVes)).toBe(before - 200);
    const c = await api.post(`/treasury/payments/${p.id}/cancel`, { reason: 'error de captura' });
    expect(c.body.data.status).toBe('CANCELLED');
    expect(await balance(bankVes)).toBe(before);
    const open = (await api.get(`/treasury/payables/open?supplierId=${supplierId}`)).body.data.find((x: any) => x.id === e.id);
    expect(open).toMatchObject({ status: 'OPEN' }); expect(Number(open.balance)).toBe(200);
    expect((await api.post(`/treasury/payments/${p.id}/cancel`, { reason: 'otra vez' })).status).toBe(422);
    // el libro es inmutable: pago + reverso, ambos visibles
    const led = (await api.get(`/treasury/accounts/${bankVes}/movements?limit=100`)).body.data as any[];
    expect(led.filter(m => m.sourceId === p.id).map(m => m.kind).sort()).toEqual(['REVERSAL', 'SUPPLIER_PAYMENT']);
  });

  it('validaciones: moneda de cuenta, referencia, instrumento, proveedor y saldo vacío', async () => {
    const e = await purchase(1, 100);
    const wrongCur = await pay([{ payableEntryId: e.id, amount: '10' }], { bankAccountId: bankUsd });
    expect(wrongCur.status).toBe(422); expect(wrongCur.body.error).toBe('BANK_CURRENCY_MISMATCH');
    expect((await pay([{ payableEntryId: e.id, amount: '10' }], { paymentMethodId: methodRef })).body.error).toBe('REFERENCE_REQUIRED');
    expect((await pay([{ payableEntryId: e.id, amount: '10' }], { paymentMethodId: methodCredit })).body.error).toBe('PAYMENT_METHOD_INVALID');
    expect((await pay([{ payableEntryId: e.id, amount: '10' }, { payableEntryId: e.id, amount: '5' }])).body.error).toBe('DUPLICATE_APPLICATION');
    expect((await pay([{ payableEntryId: e.id, amount: '-10' }])).body.error).toBe('INVALID_APPLICATION_SIGN');
    const other = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Otro' })).body.data.id;
    expect((await pay([{ payableEntryId: e.id, amount: '10' }], { supplierId: other })).body.error).toBe('SUPPLIER_MISMATCH');
  });

  it('paga en moneda distinta a la de la cuenta por pagar usando la tasa del día', async () => {
    const e = await purchase(10, 5, b.usd); // 50 USD
    expect(Number(e.balance)).toBe(50);
    // se pagan 20 USD de la factura desde la cuenta en Bs: 20 × 40 = 800 Bs
    const before = await balance(bankVes);
    const p = await pay([{ payableEntryId: e.id, amount: '20' }]);
    expect(p.status).toBe(201); expect(Number(p.body.data.amount)).toBe(800);
    expect(await balance(bankVes)).toBe(before - 800);
    // y 30 USD desde la cuenta en USD
    await api.post('/treasury/movements', { bankAccountId: bankUsd, kind: 'DEPOSIT', amount: '100' });
    const p2 = await pay([{ payableEntryId: e.id, amount: '30' }], { currencyId: b.usd, bankAccountId: bankUsd });
    expect(p2.status).toBe(201); expect(Number(p2.body.data.amount)).toBe(30);
    expect(await balance(bankUsd)).toBe(70);
  });

  it('un saldo a favor (devolución posterior al pago) se compensa con otra compra, sin mover banco', async () => {
    const e = await purchase(10, 100); // 1000
    expect((await pay([{ payableEntryId: e.id, amount: '1000' }])).status).toBe(201); // pagada del todo
    const doc = (await api.get(`/purchases/${e.purchaseDocumentId}`)).body.data;
    const ret = await api.post('/purchases/returns', { supplierId, warehouseId: b.w1, currencyId: b.ves, parentId: doc.id, lines: [{ productId: product, quantity: '3', unitCost: '100', taxId: exempt, parentLineId: doc.lines[0].id }] });
    expect(ret.status).toBe(201);
    expect((await api.post(`/purchases/returns/${ret.body.data.id}/confirm`)).status).toBe(201);
    const credit = ((await api.get(`/treasury/payables/open?supplierId=${supplierId}`)).body.data as any[]).find(x => Number(x.balance) === -300);
    expect(credit).toBeTruthy(); // saldo a favor de 300
    const e2 = await purchase(3, 100); // 300
    const before = await balance(bankVes);
    const p = await pay([{ payableEntryId: e2.id, amount: '300' }, { payableEntryId: credit.id, amount: '-300' }]);
    expect(p.status).toBe(201); expect(Number(p.body.data.amount)).toBe(0); expect(p.body.data.bankAccountId).toBeNull();
    expect(await balance(bankVes)).toBe(before); // compensación pura
    const open = ((await api.get(`/treasury/payables/open?supplierId=${supplierId}`)).body.data as any[]).map(x => x.id);
    expect(open).not.toContain(e2.id); expect(open).not.toContain(credit.id);
    // lo compensado se revierte al anular
    expect((await api.post(`/treasury/payments/${p.body.data.id}/cancel`, { reason: 'prueba' })).status).toBe(201);
    const open2 = ((await api.get(`/treasury/payables/open?supplierId=${supplierId}`)).body.data as any[]).map(x => x.id);
    expect(open2).toEqual(expect.arrayContaining([e2.id, credit.id]));
    // pagar menos de lo que se compensa es inválido
    const e3 = await purchase(1, 100);
    expect((await pay([{ payableEntryId: e3.id, amount: '100' }, { payableEntryId: credit.id, amount: '-300' }])).body.error).toBe('NEGATIVE_PAYMENT');
  });

  it('transferencias entre cuentas y movimientos manuales; conciliación bancaria', async () => {
    const b0 = await balance(bankVes); const u0 = await balance(bankUsd);
    expect((await api.post('/treasury/transfers', { fromAccountId: bankVes, toAccountId: bankUsd, amountOut: '400' })).body.error).toBe('AMOUNT_IN_REQUIRED');
    const tr = await api.post('/treasury/transfers', { fromAccountId: bankVes, toAccountId: bankUsd, amountOut: '400', amountIn: '10' });
    expect(tr.status).toBe(201);
    expect(await balance(bankVes)).toBe(b0 - 400); expect(await balance(bankUsd)).toBe(u0 + 10);
    expect((await api.post('/treasury/transfers', { fromAccountId: bankVes, toAccountId: bankVes, amountOut: '1' })).status).toBe(422);
    const fee = await api.post('/treasury/movements', { bankAccountId: bankVes, kind: 'FEE', amount: '5', description: 'Comisión' });
    expect(Number(fee.body.data.amount)).toBe(-5);

    // conciliación de la cuenta en USD: apertura 0 → depósito 100, transferencia +10, pago −30 …
    const led = (await api.get(`/treasury/accounts/${bankUsd}/movements?limit=100`)).body.data as any[];
    const all = led.map(m => m.id);
    const total = led.reduce((a, m) => a + Number(m.amount), 0);
    const bad = await api.post('/treasury/reconciliations', { bankAccountId: bankUsd, statementDate: today(), statementBalance: String(total + 1), movementIds: all });
    expect(bad.status).toBe(422); expect(bad.body.error).toBe('RECONCILIATION_DIFFERENCE');
    const ok = await api.post('/treasury/reconciliations', { bankAccountId: bankUsd, statementDate: today(), statementBalance: String(total), movementIds: all });
    expect(ok.status).toBe(201);
    expect((await api.post('/treasury/reconciliations', { bankAccountId: bankUsd, statementDate: today(), statementBalance: String(total), movementIds: [all[0]] })).body.error).toBe('ALREADY_RECONCILED');
    const bal = (await api.get('/treasury/accounts/balances')).body.data.find((x: any) => x.id === bankUsd);
    expect(Number(bal.reconciledBalance)).toBe(total); expect(bal.unreconciledCount).toBe(0);
    // un pago conciliado no se anula
    const e = await purchase(1, 10, b.usd);
    const p = (await pay([{ payableEntryId: e.id, amount: '5' }], { currencyId: b.usd, bankAccountId: bankUsd })).body.data;
    const led2 = (await api.get(`/treasury/accounts/${bankUsd}/movements?onlyUnreconciled=true`)).body.data as any[];
    expect(led2).toHaveLength(1);
    const t2 = total - 5;
    expect((await api.post('/treasury/reconciliations', { bankAccountId: bankUsd, statementDate: today(), statementBalance: String(t2), movementIds: [led2[0].id] })).status).toBe(201);
    const cx = await api.post(`/treasury/payments/${p.id}/cancel`, { reason: 'intento' });
    expect(cx.status).toBe(422); expect(cx.body.error).toBe('PAYMENT_RECONCILED');
  });

  it('permisos: COMPRAS solo consulta pagos; el contador (solo lectura) no crea', async () => {
    const mk = async (role: string) => {
      const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@test.local`;
      expect((await api.post('/users', { email, fullName: `Usuario ${role}`, password: PASSWORD, roleCodes: [role] })).status).toBe(201);
      return client(ctx, (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken);
    };
    const compras = await mk('COMPRAS'); const contador = await mk('CONTADOR');
    expect((await compras.get('/treasury/payments')).status).toBe(200);
    expect((await compras.post('/treasury/payments', {})).status).toBe(403);
    expect((await contador.get('/treasury/accounts/balances')).status).toBe(200);
    expect((await contador.post('/treasury/movements', { bankAccountId: bankVes, kind: 'DEPOSIT', amount: '1' })).status).toBe(403);
  });

  it('el estado de cuenta del proveedor incluye los pagos y el saldo cuadra con la CxP abierta', async () => {
    const sup = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor Estado' })).body.data.id;
    const d = await api.post('/purchases', { supplierId: sup, warehouseId: b.w1, currencyId: b.usd, supplierDocNo: 'F-EST', paymentCondition: 'CREDIT', creditDays: 10, lines: [{ productId: product, quantity: '10', unitCost: '10', taxId: exempt }] });
    await api.post(`/purchases/${d.body.data.id}/confirm`); // 100 USD × 40 = 4.000 Bs
    const e = ((await api.get(`/treasury/payables/open?supplierId=${sup}`)).body.data as any[])[0];
    expect((await api.post('/treasury/payments', { supplierId: sup, paymentMethodId: method, bankAccountId: bankVes, currencyId: b.ves, applications: [{ payableEntryId: e.id, amount: '25' }] })).status).toBe(201); // 25 USD = 1.000 Bs
    const st = (await api.get(`/reports/suppliers/statement?supplierId=${sup}`)).body.data;
    expect(st.rows.map((r: any) => r.type)).toEqual(['Factura', 'Pago']);
    expect(Number(st.totals.balance_bs)).toBe(3000);
    const aging = (await api.get(`/reports/suppliers/payables?supplierId=${sup}`)).body.data;
    expect(Number(aging.rows[0].balance)).toBe(75);
  });
});
