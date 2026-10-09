import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, PASSWORD, auth } from './helpers';

describe('Fiscal: retenciones, notas de débito, devolución en efectivo e IGTF en cobros', () => {
  let ctx: Ctx; let api: Api; let token: string; let b: Awaited<ReturnType<typeof seedBasics>>; let bankVes: string; let bankUsd: string; let trf: string; let cashUsd: string;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  const buf = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); };
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Fiscal'); token = t.token; api = client(ctx, t.token); b = await seedBasics(api);
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today() });
    const bank = (await api.get('/banks?limit=5')).body.data[0].id;
    bankVes = (await api.post('/bank-accounts', { bankId: bank, name: 'Bs', number: '01020000000000000041', currencyId: b.ves, openingBalance: '100000' })).body.data.id;
    bankUsd = (await api.post('/bank-accounts', { bankId: bank, name: 'USD', number: '01020000000000000042', currencyId: b.usd })).body.data.id;
    trf = (await api.post('/payment-methods', { code: 'TRF', name: 'Transferencia', type: 'TRANSFER' })).body.data.id;
    cashUsd = (await api.post('/payment-methods', { code: 'EFUSD', name: 'Efectivo USD', type: 'CASH', appliesIgtf: true })).body.data.id;
  });
  afterAll(async () => { await ctx.close(); });
  const balance = async (acc: string) => Number((await api.get('/treasury/accounts/balances')).body.data.find((x: any) => x.id === acc).balance);
  const rowsOf = (r: any) => r.body.data.rows as Record<string, any>[];

  describe('retenciones practicadas a proveedores', () => {
    let supplier: string; let product: string;
    const buy = async (cost = 1000) => {
      const d = await api.post('/purchases', { supplierId: supplier, warehouseId: b.w1, currencyId: b.ves, supplierDocNo: `F-${Math.random()}`, supplierControlNo: '00-123', paymentCondition: 'CREDIT', creditDays: 30, lines: [{ productId: product, quantity: '1', unitCost: String(cost) }] });
      expect(d.status).toBe(201);
      return (await api.post(`/purchases/${d.body.data.id}/confirm`)).body.data; // 1000 + IVA 160
    };
    const open = async () => (await api.get(`/treasury/payables/open?supplierId=${supplier}`)).body.data as any[];
    beforeAll(async () => {
      supplier = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor Retenido', retentionIvaPct: '75' })).body.data.id;
      product = await b.product('FIS-1');
    });

    it('exige ser agente de retención de IVA y calcula 75 % del IVA por omisión', async () => {
      const p = await buy();
      expect((await api.post('/fiscal/withholdings/issue', { kind: 'IVA', purchaseDocumentId: p.id })).body.error).toBe('NOT_VAT_AGENT');
      await api.patch('/companies/current', { isVatWithholdingAgent: true });
      const w = await api.post('/fiscal/withholdings/issue', { kind: 'IVA', purchaseDocumentId: p.id });
      expect(w.status).toBe(201);
      expect(w.body.data).toMatchObject({ direction: 'ISSUED', kind: 'IVA', status: 'CONFIRMED', number: expect.stringMatching(/^RIVA-\d{6}$/), period: today().slice(0, 7) });
      expect(Number(w.body.data.baseBs)).toBe(160); expect(Number(w.body.data.percentage)).toBe(75); expect(Number(w.body.data.amountBs)).toBe(120);
      const e = (await open()).find(x => x.purchaseDocumentId === p.id);
      expect(Number(e.balance)).toBe(1040); expect(e.status).toBe('PARTIALLY_PAID');
      expect((await api.post('/fiscal/withholdings/issue', { kind: 'IVA', purchaseDocumentId: p.id })).body.error).toBe('ALREADY_WITHHELD');
      // ISLR: porcentaje obligatorio; base por omisión = base imponible
      expect((await api.post('/fiscal/withholdings/issue', { kind: 'ISLR', purchaseDocumentId: p.id })).body.error).toBe('PERCENTAGE_REQUIRED');
      const i = await api.post('/fiscal/withholdings/issue', { kind: 'ISLR', purchaseDocumentId: p.id, percentage: '2', concept: 'Servicios (jurídica)' });
      expect(i.body.data).toMatchObject({ number: expect.stringMatching(/^RISLR-\d{6}$/) }); expect(Number(i.body.data.amountBs)).toBe(20);
      expect(Number((await open()).find(x => x.purchaseDocumentId === p.id).balance)).toBe(1020);
      // el pago neto cancela el resto
      const pay = await api.post('/treasury/payments', { supplierId: supplier, paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, applications: [{ payableEntryId: e.id, amount: '1020' }] });
      expect(pay.status).toBe(201);
      expect((await open()).find(x => x.purchaseDocumentId === p.id)).toBeUndefined();
      // comprobante PDF
      const pdf = await ctx.http.get(`/api/v1/fiscal/withholdings/${w.body.data.id}/pdf`).set(auth(token)).buffer(true).parse(buf);
      expect(pdf.status).toBe(200); expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    });

    it('anular restituye la deuda; compra de contado o sin IVA no se retiene; no excede el saldo', async () => {
      const p = await buy(500); // IVA 80 → retiene 60
      const w = (await api.post('/fiscal/withholdings/issue', { kind: 'IVA', purchaseDocumentId: p.id })).body.data;
      expect(Number((await open()).find(x => x.purchaseDocumentId === p.id).balance)).toBe(520);
      const cx = await api.post(`/fiscal/withholdings/${w.id}/cancel`, { reason: 'base mal calculada' });
      expect(cx.body.data.status).toBe('CANCELLED');
      expect(Number((await open()).find(x => x.purchaseDocumentId === p.id).balance)).toBe(580);
      expect((await api.post(`/fiscal/withholdings/${w.id}/cancel`, { reason: 'otra vez' })).status).toBe(422);
      // se puede rehacer tras anular
      expect((await api.post('/fiscal/withholdings/issue', { kind: 'IVA', purchaseDocumentId: p.id, percentage: '100' })).status).toBe(201);
      // pago casi total y luego una retención que excede el saldo
      const q = await buy(500);
      const e = (await open()).find(x => x.purchaseDocumentId === q.id);
      await api.post('/treasury/payments', { supplierId: supplier, paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, applications: [{ payableEntryId: e.id, amount: '570' }] });
      expect((await api.post('/fiscal/withholdings/issue', { kind: 'IVA', purchaseDocumentId: q.id })).body.error).toBe('EXCEEDS_BALANCE');
      // elegibles del proveedor
      const el = (await api.get(`/fiscal/withholdings/eligible?direction=ISSUED&partyId=${supplier}`)).body.data as any[];
      expect(el.find(x => x.documentId === p.id).withheld).toEqual(['IVA']);
    });
  });

  describe('retenciones recibidas de clientes, notas de débito y devolución en efectivo', () => {
    let customer: string; let product: string;
    const pay = (amount: string) => ({ payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount }] });
    const invoice = async (qty: string, credit: boolean) => {
      const d = (await api.post('/sales/invoices', { customerId: customer, warehouseId: b.w1, currencyId: b.ves, ...(credit ? { paymentCondition: 'CREDIT', creditDays: 20 } : {}), lines: [{ productId: product, quantity: qty, unitPrice: '100' }] })).body.data.id;
      const r = await api.post(`/sales/invoices/${d}/confirm`, credit ? {} : pay(String(Number(qty) * 116)));
      expect(r.status).toBe(201); return r.body.data;
    };
    beforeAll(async () => {
      customer = (await api.post('/customers', { rif: uniqueRif('J'), legalName: 'Cliente Agente', retentionIvaPct: '75', creditDays: 20 })).body.data.id;
      product = await b.product('FIS-2');
      const ch = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: product, quantity: '50', unitCost: '5' }] });
      await api.post(`/inventory/charges/${ch.body.data.id}/confirm`);
    });

    it('la retención del cliente reduce la cuenta por cobrar y se puede anular', async () => {
      const inv = await invoice('10', true); // 1.160
      expect((await api.post('/fiscal/withholdings/receive', { kind: 'IVA', salesDocumentId: inv.id })).status).toBe(400); // falta el comprobante del cliente
      const w = await api.post('/fiscal/withholdings/receive', { kind: 'IVA', salesDocumentId: inv.id, externalNumber: '2026010012345' });
      expect(w.status).toBe(201);
      expect(w.body.data).toMatchObject({ direction: 'RECEIVED', externalNumber: '2026010012345', number: expect.stringMatching(/^RRET-\d{6}$/) }); expect(Number(w.body.data.amountBs)).toBe(120); // 75 % de 160
      expect(Number((await api.get(`/sales/invoices/${inv.id}`)).body.data.receivable[0].balance)).toBe(1040);
      expect((await api.post('/fiscal/withholdings/receive', { kind: 'IVA', salesDocumentId: inv.id, externalNumber: 'X' })).body.error).toBe('ALREADY_WITHHELD');
      await api.post(`/fiscal/withholdings/${w.body.data.id}/cancel`, { reason: 'comprobante inválido' });
      expect(Number((await api.get(`/sales/invoices/${inv.id}`)).body.data.receivable[0].balance)).toBe(1160);
      const cash = await invoice('1', false);
      expect((await api.post('/fiscal/withholdings/receive', { kind: 'IVA', salesDocumentId: cash.id, externalNumber: 'Y' })).body.error).toBe('NO_RECEIVABLE');
    });

    it('nota de débito aumenta la cuenta por cobrar y sale en el libro y en PDF', async () => {
      const inv = await invoice('2', true); // 232
      const dn = await api.post(`/sales/invoices/${inv.id}/debit-note`, { concept: 'Intereses por mora', amount: '50' });
      expect(dn.status).toBe(201);
      expect(dn.body.data).toMatchObject({ docType: 'DEBIT_NOTE', status: 'CONFIRMED', number: expect.stringMatching(/^ND-\d{6}$/), total: '58' });
      expect(dn.body.data.links.parents[0]).toEqual({ type: 'INVOICE', id: inv.id });
      const open = (await api.get(`/treasury/receivables/open?customerId=${customer}`)).body.data as any[];
      expect(open.find(e => e.documentNo === dn.body.data.number)).toMatchObject({ entryType: 'DEBIT_NOTE', balance: '58' });
      const pdf = await ctx.http.get(`/api/v1/sales/debit-notes/${dn.body.data.id}/pdf`).set(auth(token)).buffer(true).parse(buf);
      expect(pdf.status).toBe(200); expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
      const book = rowsOf(await api.get('/reports/sales/book'));
      expect(book.find(r => r.number === dn.body.data.number)).toMatchObject({ type: 'Nota de débito' }); expect(Number(book.find(r => r.number === dn.body.data.number)!.total_bs)).toBe(58);
      expect((await api.post(`/sales/invoices/${inv.id}/debit-note`, { concept: 'x', amount: '5' })).status).toBe(400);
    });

    it('devolución en efectivo: la nota de crédito de una factura de contado devuelve el dinero', async () => {
      const inv = await invoice('2', false); // 232 pagados
      const before = await balance(bankVes);
      const noRefund = await api.post(`/sales/invoices/${inv.id}/credit-note`, { lines: [{ parentLineId: inv.lines[0].id, quantity: '1' }] });
      expect(noRefund.status).toBe(201); // queda saldo a favor en CxC
      expect((await api.get(`/treasury/receivables/open?customerId=${customer}`)).body.data.find((e: any) => e.documentNo === noRefund.body.data.number)).toMatchObject({ balance: '-116' });
      const ref = await api.post(`/sales/invoices/${inv.id}/credit-note`, { lines: [{ parentLineId: inv.lines[0].id, quantity: '1' }], refund: { bankAccountId: bankVes } });
      expect(ref.status).toBe(201);
      expect(await balance(bankVes)).toBe(before - 116);
      expect((await api.get(`/treasury/receivables/open?customerId=${customer}`)).body.data.find((e: any) => e.documentNo === ref.body.data.number)).toBeUndefined();
      const led = (await api.get(`/treasury/accounts/${bankVes}/movements?limit=5`)).body.data as any[];
      expect(led[0]).toMatchObject({ kind: 'CUSTOMER_REFUND' }); expect(Number(led[0].amount)).toBe(-116);
      // con factura a crédito pendiente, el saldo se aplica a la factura y no hay nada que devolver
      const cr = await invoice('2', true);
      const e = await api.post(`/sales/invoices/${cr.id}/credit-note`, { lines: [{ parentLineId: cr.lines[0].id, quantity: '1' }], refund: { bankAccountId: bankVes } });
      expect(e.status).toBe(422); expect(e.body.error).toBe('NOTHING_TO_REFUND');
    });

    it('IGTF en cobros posteriores en divisas: el cliente entrega lo aplicado más 3 %', async () => {
      await api.patch('/companies/current', { isIgtfCollector: true });
      const e = (await api.post('/treasury/receivables/opening', { customerId: customer, documentNo: 'SI-USD', issueDate: today(), currencyId: b.usd, amount: '97' })).body.data;
      const rc = await api.post('/treasury/receipts', { customerId: customer, paymentMethodId: cashUsd, bankAccountId: bankUsd, currencyId: b.usd, applications: [{ receivableEntryId: e.id, amount: '97' }] });
      expect(rc.status).toBe(201);
      expect(Number(rc.body.data.amount)).toBeCloseTo(100, 3); expect(Number(rc.body.data.igtfAmount)).toBeCloseTo(3, 3); expect(Number(rc.body.data.igtfPct)).toBe(3);
      expect(await balance(bankUsd)).toBeCloseTo(100, 3);
      const igtf = rowsOf(await api.get('/reports/fiscal/igtf'));
      expect(igtf.find(r => r.origin === 'Cobro')).toMatchObject({ currency: 'USD' }); expect(Number(igtf.find(r => r.origin === 'Cobro')!.igtf_bs)).toBeCloseTo(120, 1);
    });
  });

  it('libro de compras, resumen de IVA y reportes de retenciones', async () => {
    const book = rowsOf(await api.get('/reports/purchases/book'));
    expect(book.length).toBeGreaterThan(0);
    const withWh = book.find(r => Number(r.wh_iva_bs) > 0)!;
    expect(withWh).toMatchObject({ type: 'Compra', control_no: '00-123' });
    const sum = rowsOf(await api.get('/reports/fiscal/vat-summary'));
    expect(sum).toHaveLength(1); expect(sum[0].period).toBe(today().slice(0, 7));
    const r = sum[0]; // cuota = débito − crédito − retenciones recibidas
    expect(Number(r.due)).toBeCloseTo(Number(r.debit) - Number(r.credit) - Number(r.wh_received), 2);
    expect(Number(r.credit)).toBeGreaterThan(0); expect(Number(r.debit)).toBeGreaterThan(0); expect(Number(r.wh_issued)).toBeGreaterThan(0);
    const issued = rowsOf(await api.get('/reports/fiscal/withholdings-issued'));
    expect(issued.map(x => x.kind)).toEqual(expect.arrayContaining(['IVA', 'ISLR']));
    expect(rowsOf(await api.get('/reports/fiscal/withholdings-issued?status=CANCELLED')).every(x => x.status === 'Anulada')).toBe(true);
    // el vendedor no ve el área fiscal
    const email = `fv-${Math.random().toString(36).slice(2, 7)}@test.local`;
    await api.post('/users', { email, fullName: 'Vendedor Fiscal', password: PASSWORD, roleCodes: ['VENDEDOR'] });
    const v = client(ctx, (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken);
    expect((await v.get('/fiscal/withholdings')).status).toBe(403);
    expect((await v.get('/reports/fiscal/vat-summary')).status).toBe(403);
  });
});
