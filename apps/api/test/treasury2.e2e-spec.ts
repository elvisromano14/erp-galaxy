import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, auth } from './helpers';

describe('Tesorería II: saldos iniciales CxP, sobregiro y diferencial cambiario', () => {
  let ctx: Ctx; let api: Api; let token: string; let b: Awaited<ReturnType<typeof seedBasics>>; let supplierId: string; let customerId: string; let bankVes: string; let bankUsd: string; let trf: string;
  const iso = (n = 0) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Tesoreria2'); token = t.token; api = client(ctx, t.token); b = await seedBasics(api);
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '36', date: iso(-30) });
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: iso(0) });
    supplierId = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor Saldos', creditDays: 30 })).body.data.id;
    customerId = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Cambio' })).body.data.id;
    const bank = (await api.get('/banks?limit=5')).body.data[0].id;
    bankVes = (await api.post('/bank-accounts', { bankId: bank, name: 'Bs', number: '01020000000000000051', currencyId: b.ves, openingBalance: '1000' })).body.data.id;
    bankUsd = (await api.post('/bank-accounts', { bankId: bank, name: 'USD', number: '01020000000000000052', currencyId: b.usd, openingBalance: '500', overdraftLimit: '50' })).body.data.id;
    trf = (await api.post('/payment-methods', { code: 'TRF', name: 'Transferencia', type: 'TRANSFER' })).body.data.id;
  });
  afterAll(async () => { await ctx.close(); });
  const rowsOf = (r: any) => r.body.data.rows as Record<string, any>[];

  it('saldos iniciales de cuentas por pagar: carga, pago, reportes y anulación', async () => {
    const o = await api.post('/treasury/payables/opening', { supplierId, documentNo: 'PF-001', issueDate: iso(-20), currencyId: b.ves, amount: '800' });
    expect(o.status).toBe(201);
    expect(o.body.data).toMatchObject({ entryType: 'OPENING', status: 'OPEN', purchaseDocumentId: null }); expect(o.body.data.dueDate.slice(0, 10)).toBe(iso(10)); // emisión −20 + 30 días
    expect((await api.post('/treasury/payables/opening', { supplierId, documentNo: 'PF-001', issueDate: iso(-20), currencyId: b.ves, amount: '5' })).body.error).toBe('DUPLICATE_DOCUMENT');
    const open = (await api.get(`/treasury/payables/open?supplierId=${supplierId}`)).body.data as any[];
    expect(open[0].document).toMatchObject({ number: 'PF-001', docType: 'OPENING' });
    const pay = await api.post('/treasury/payments', { supplierId, paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, applications: [{ payableEntryId: o.body.data.id, amount: '300' }] });
    expect(pay.status).toBe(201); expect(pay.body.data.applications[0].document.number).toBe('PF-001');
    const rep = rowsOf(await api.get(`/reports/suppliers/payables?supplierId=${supplierId}`));
    expect(rep[0]).toMatchObject({ number: 'PF-001', supplier_doc: 'PF-001' }); expect(Number(rep[0].balance)).toBe(500);
    expect(Number(rowsOf(await api.get(`/reports/suppliers/aging?supplierId=${supplierId}`))[0].total)).toBe(500);
    const st = (await api.get(`/reports/suppliers/statement?supplierId=${supplierId}`)).body.data;
    expect(st.rows.map((x: any) => x.type)).toEqual(['Saldo inicial', 'Pago']); expect(Number(st.totals.balance_bs)).toBe(500);
    expect((await api.post(`/treasury/payables/${o.body.data.id}/cancel`, { reason: 'carga errónea' })).body.error).toBe('HAS_APPLICATIONS');
    // un saldo sin pagos se anula; en USD sin tasa explícita usa la del día de emisión
    const u = await api.post('/treasury/payables/opening', { supplierId, documentNo: 'PF-USD', issueDate: iso(-30), currencyId: b.usd, amount: '100' });
    expect(Number(u.body.data.exchangeRate)).toBe(36);
    expect((await api.post(`/treasury/payables/${u.body.data.id}/cancel`, { reason: 'carga errónea' })).body.data.status).toBe('CANCELLED');
    expect((await api.get('/treasury/payables?onlyOpen=true')).body.meta.total).toBe(1);
  });

  it('importa saldos iniciales de CxP desde archivo', async () => {
    const rif = uniqueRif();
    const sid = (await api.post('/suppliers', { rif, legalName: 'Proveedor Import', creditDays: 15 })).body.data.id;
    const csv = (rows: string[][]) => Buffer.from('﻿' + [['rif', 'documento', 'emision', 'moneda', 'monto', 'tasa'], ...rows].map(r => r.join(';')).join('\r\n'), 'utf8');
    const up = (f: Buffer, q = '') => ctx.http.post(`/api/v1/imports/payables-opening${q}`).set(auth(token)).attach('file', f, 'p.csv');
    const bad = (await up(csv([[rif, 'IP-1', '2026-01-10', 'USD', '100', ''], [rif, 'IP-1', '2026-01-10', 'VES', '5', '']]))).body.data;
    expect(bad.summary.errors).toBe(2);
    const ok = await up(csv([[rif, 'IP-1', '2026-01-10', 'VES', '1.500,00', ''], [rif, 'IP-2', '2026-01-12', 'USD', '100', '38']]), '?mode=commit');
    expect(ok.body.data.result.created).toBe(2);
    const open = (await api.get(`/treasury/payables/open?supplierId=${sid}`)).body.data as any[];
    expect(open.map(e => Number(e.balance)).sort((a, c) => a - c)).toEqual([100, 1500]);
    expect(open.find(e => e.documentNo === 'IP-1').dueDate.slice(0, 10)).toBe('2026-01-25');
  });

  it('sobregiro controlado: las salidas no pueden dejar la cuenta bajo cero (salvo límite) pero los reversos sí', async () => {
    // Bs: saldo 1.000 − 300 (pago anterior) = 700, sin sobregiro
    const w = await api.post('/treasury/movements', { bankAccountId: bankVes, kind: 'WITHDRAWAL', amount: '700.01' });
    expect(w.status).toBe(422); expect(w.body.error).toBe('INSUFFICIENT_FUNDS');
    expect((await api.post('/treasury/movements', { bankAccountId: bankVes, kind: 'WITHDRAWAL', amount: '700' })).status).toBe(201);
    const e = (await api.post('/treasury/payables/opening', { supplierId, documentNo: 'PF-002', issueDate: iso(), currencyId: b.ves, amount: '50' })).body.data;
    const noFunds = await api.post('/treasury/payments', { supplierId, paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, applications: [{ payableEntryId: e.id, amount: '50' }] });
    expect(noFunds.body.error).toBe('INSUFFICIENT_FUNDS');
    expect(Number((await api.get('/treasury/payables/open?supplierId=' + supplierId)).body.data.find((x: any) => x.id === e.id).balance)).toBe(50); // todo o nada
    // USD: saldo 500 + sobregiro 50 → se puede sacar hasta 550
    expect((await api.post('/treasury/movements', { bankAccountId: bankUsd, kind: 'WITHDRAWAL', amount: '550' })).status).toBe(201);
    expect((await api.post('/treasury/movements', { bankAccountId: bankUsd, kind: 'FEE', amount: '0.01' })).body.error).toBe('INSUFFICIENT_FUNDS');
    // transferencias respetan el límite de la cuenta origen
    expect((await api.post('/treasury/transfers', { fromAccountId: bankVes, toAccountId: bankUsd, amountOut: '10', amountIn: '1' })).body.error).toBe('INSUFFICIENT_FUNDS');
    // reponer fondos y anular un cobro ya gastado: el reverso no se bloquea
    await api.post('/treasury/movements', { bankAccountId: bankVes, kind: 'DEPOSIT', amount: '100' });
    const cr = await api.post('/treasury/receivables/opening', { customerId, documentNo: 'C-1', issueDate: iso(), currencyId: b.ves, amount: '100' });
    const rc = await api.post('/treasury/receipts', { customerId, paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, applications: [{ receivableEntryId: cr.body.data.id, amount: '100' }] });
    expect(rc.status).toBe(201);
    await api.post('/treasury/movements', { bankAccountId: bankVes, kind: 'WITHDRAWAL', amount: '200' }); // saldo queda en 0
    expect((await api.post(`/treasury/receipts/${rc.body.data.id}/cancel`, { reason: 'depósito rechazado' })).status).toBe(201);
    expect(Number((await api.get('/treasury/accounts/balances')).body.data.find((x: any) => x.id === bankVes).balance)).toBe(-100);
  });

  it('diferencial cambiario realizado en pagos y cobros en moneda extranjera', async () => {
    // compra en USD a tasa 36, pagada hoy a 40 → se paga más Bs: pérdida de 4 × 100 = −400
    const o = (await api.post('/treasury/payables/opening', { supplierId, documentNo: 'PF-FX', issueDate: iso(-30), currencyId: b.usd, amount: '100' })).body.data;
    await api.post('/treasury/movements', { bankAccountId: bankUsd, kind: 'DEPOSIT', amount: '300' });
    expect((await api.post('/treasury/payments', { supplierId, paymentMethodId: trf, bankAccountId: bankUsd, currencyId: b.usd, applications: [{ payableEntryId: o.id, amount: '100' }] })).status).toBe(201);
    // cobro: deuda de cliente USD 50 a tasa 36, cobrada a 40 → ganancia 4 × 50 = +200
    const r = (await api.post('/treasury/receivables/opening', { customerId, documentNo: 'C-FX', issueDate: iso(-30), currencyId: b.usd, amount: '50' })).body.data;
    expect((await api.post('/treasury/receipts', { customerId, paymentMethodId: trf, bankAccountId: bankUsd, currencyId: b.usd, applications: [{ receivableEntryId: r.id, amount: '50' }] })).status).toBe(201);
    // Bs no genera diferencial
    const vr = (await api.post('/treasury/receivables/opening', { customerId, documentNo: 'C-VES', issueDate: iso(-30), currencyId: b.ves, amount: '10' })).body.data;
    await api.post('/treasury/receipts', { customerId, paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, applications: [{ receivableEntryId: vr.id, amount: '10' }] });
    const fx = (await api.get('/reports/fiscal/fx-differences')).body.data;
    expect(fx.rows.map((x: any) => [x.type, Number(x.result_bs)])).toEqual([['Pago a proveedor', -400], ['Cobro a cliente', 200]]);
    expect(Number(fx.totals.result_bs)).toBe(-200);
    // un pago anulado deja de contar
    const p = (await api.get('/treasury/payments?limit=1')).body.data[0];
    await api.post(`/treasury/payments/${p.id}/cancel`, { reason: 'prueba' });
    expect(rowsOf(await api.get('/reports/fiscal/fx-differences')).map(x => x.type)).toEqual(['Cobro a cliente']);
  });

  it('extracto bancario: empareja por monto/fecha/referencia, crea lo faltante y concilia con cuadre de saldo', async () => {
    const bank = (await api.get('/banks?limit=5')).body.data[0].id;
    const acc = (await api.post('/bank-accounts', { bankId: bank, name: 'Extracto', number: '01020000000000000061', currencyId: b.ves, openingBalance: '1000' })).body.data.id;
    const mv = (kind: string, amount: string, extra: object = {}) => api.post('/treasury/movements', { bankAccountId: acc, kind, amount, ...extra });
    await mv('DEPOSIT', '500', { movementDate: iso(-5), reference: 'DEP-77' });
    await mv('WITHDRAWAL', '200', { movementDate: iso(-4), reference: 'CHQ-9' });
    await mv('DEPOSIT', '300', { movementDate: iso(-3) });
    await mv('WITHDRAWAL', '100', { movementDate: iso(-1) }); // el banco no lo ha procesado aún
    const dmy = (n: number) => { const d = iso(n); return `${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)}`; };
    const file = (rows: string[][], header = ['Fecha', 'Referencia', 'Descripción', 'Débito', 'Crédito']) => Buffer.from('﻿' + [header, ...rows].map(r => r.join(';')).join('\r\n'), 'utf8');
    const up = (f: Buffer, q = '') => ctx.http.post(`/api/v1/treasury/accounts/${acc}/statement${q}`).set(auth(token)).attach('file', f, 'extracto.csv');
    // saldo del banco: 1.000 + 500 − 200 + 300 − 5 (comisión) = 1.595
    const st = file([[dmy(-5), 'DEP-77', 'Depósito', '', '500,00'], [dmy(-3), '', 'Transferencia recibida', '', '300,00'], [dmy(-3), 'CHQ-9', 'Cheque pagado', '200,00', ''], [dmy(-2), 'COM-1', 'Comisión mantenimiento', '5,00', '']]);
    const v = (await up(st)).body.data;
    expect(v.committed).toBe(false);
    expect(v.summary).toMatchObject({ lines: 4, matched: 3, unmatchedLines: 1, unmatchedMovements: 0 }); // el retiro de 100 es posterior al extracto: no se lista
    expect(v.unmatchedLines[0]).toMatchObject({ amount: '-5.0000', suggestedKind: 'FEE' });
    expect(v.matches.find((m: any) => m.reference === 'CHQ-9')).toBeTruthy();
    // aplicar: falta la comisión → pide createMissing
    const q = `?mode=commit&statementDate=${iso(0)}&statementBalance=1595`;
    expect((await up(st, q)).body.error).toBe('UNMATCHED_LINES');
    // saldo mal digitado → no se guarda nada (ni la comisión creada)
    const bad = await up(st, `${q.replace('1595', '1600')}&createMissing=true`);
    expect(bad.status).toBe(422); expect(bad.body.error).toBe('RECONCILIATION_DIFFERENCE');
    expect((await api.get(`/treasury/accounts/${acc}/movements?limit=50`)).body.data).toHaveLength(4);
    const ok = await up(st, `${q}&createMissing=true`);
    expect(ok.status).toBe(201); expect(ok.body.data).toMatchObject({ committed: true, created: 1, reconciled: 4 });
    const bal = (await api.get('/treasury/accounts/balances')).body.data.find((x: any) => x.id === acc);
    expect(Number(bal.balance)).toBe(1495); expect(Number(bal.reconciledBalance)).toBe(1595); expect(bal.unreconciledCount).toBe(1); // queda el retiro de 100
    const led = (await api.get(`/treasury/accounts/${acc}/movements?limit=50`)).body.data as any[];
    expect(led.find(m => m.kind === 'FEE')).toMatchObject({ amount: '-5.0000', description: 'Comisión mantenimiento' });
    // formato con una sola columna de monto con signo y filas inválidas
    const bad2 = (await up(file([['mala', '', 'x', '', '']]))).body.data;
    expect(bad2.errors).toHaveLength(1);
    const signed = file([[iso(-1), '', 'Retiro', '-100,00']], ['fecha', 'referencia', 'descripcion', 'monto']);
    expect((await up(signed)).body.data.summary.matched).toBe(1);
    // sin permiso de conciliación no se importa
    expect((await ctx.http.post(`/api/v1/treasury/accounts/${acc}/statement`).set(auth(token)).send({})).status).toBe(422);
  });
});
