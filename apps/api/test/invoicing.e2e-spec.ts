import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif, PASSWORD, auth } from './helpers';

describe('Facturación: factura, notas de crédito y PDF', () => {
  let ctx: Ctx; let api: Api; let token: string; let b: Awaited<ReturnType<typeof seedBasics>>; let customerId: string; let bankVes: string; let bankUsd: string; let trf: string; let cashUsd: string;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Facturacion'); token = t.token; api = client(ctx, t.token); b = await seedBasics(api);
    await api.patch('/companies/current', { isIgtfCollector: true, features: { serials: true, lots: true, expiry: true } });
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today() });
    customerId = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Factura', creditDays: 15, address: 'Av. Principal, Caracas' })).body.data.id;
    const bank = (await api.get('/banks?limit=5')).body.data[0].id;
    bankVes = (await api.post('/bank-accounts', { bankId: bank, name: 'Caja Bs', number: '01020000000000000021', currencyId: b.ves })).body.data.id;
    bankUsd = (await api.post('/bank-accounts', { bankId: bank, name: 'Caja USD', number: '01020000000000000022', currencyId: b.usd })).body.data.id;
    trf = (await api.post('/payment-methods', { code: 'TRF', name: 'Transferencia', type: 'TRANSFER' })).body.data.id;
    cashUsd = (await api.post('/payment-methods', { code: 'EFUSD', name: 'Efectivo USD', type: 'CASH', appliesIgtf: true })).body.data.id;
  });
  afterAll(async () => { await ctx.close(); });

  const withStock = async (sku: string, qty: number, cost = 5, extra: object = {}, lines: object = {}) => {
    const p = await b.product(sku, extra);
    const d = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: String(qty), unitCost: String(cost), ...lines }] });
    expect((await api.post(`/inventory/charges/${d.body.data.id}/confirm`)).status).toBe(201);
    return p;
  };
  const stock = async (p: string) => (await api.get(`/products/${p}/stock`)).body.data;
  const reserved = async (p: string) => (await stock(p)).warehouses.find((w: any) => w.warehouseId === b.w1)?.reservedQty ?? '0';
  const balance = async (acc: string) => Number((await api.get('/treasury/accounts/balances')).body.data.find((x: any) => x.id === acc).balance);
  const invoice = (lines: object[], extra: object = {}) => api.post('/sales/invoices', { customerId, warehouseId: b.w1, currencyId: b.ves, lines, ...extra });
  const buf = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); };

  it('factura de contado: descarga inventario al costo, registra el pago en banco y genera PDF A4 y ticket', async () => {
    const p = await withStock('F-1', 10, 5);
    const d = await invoice([{ productId: p, quantity: '4', unitPrice: '100' }]);
    expect(d.status).toBe(201); expect(d.body.data).toMatchObject({ status: 'DRAFT', total: '464', number: null });
    const id = d.body.data.id;
    expect((await api.post(`/sales/invoices/${id}/confirm`, {})).body.error).toBe('PAYMENT_REQUIRED');
    const bad = await api.post(`/sales/invoices/${id}/confirm`, { payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: '400', reference: 'R1' }] });
    expect(bad.status).toBe(422); expect(bad.body.error).toBe('PAYMENT_MISMATCH');
    const ok = await api.post(`/sales/invoices/${id}/confirm`, { payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: '464', reference: 'R1' }] });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ status: 'CONFIRMED', number: expect.stringMatching(/^FAC-\d{6}$/), controlNo: expect.stringMatching(/^00-\d{6}$/) });
    expect(ok.body.data.fiscalSnapshot.customer.legalName).toBe('Cliente Factura');
    expect(Number(ok.body.data.lines[0].unitCost)).toBe(5); // costo en la moneda de valoración (USD)
    expect((await stock(p)).totalQuantity).toBe('6');
    expect(await balance(bankVes)).toBe(464);
    expect((await api.post(`/sales/invoices/${id}/confirm`, {})).body.error).toBe('INVALID_STATE');
    const pdf = async (path: string) => ctx.http.get(`/api/v1${path}`).set(auth(token)).buffer(true).parse(buf);
    const a4 = await pdf(`/sales/invoices/${id}/pdf`);
    expect(a4.status).toBe(200); expect(a4.headers['content-type']).toContain('application/pdf'); expect(a4.body.subarray(0, 4).toString()).toBe('%PDF');
    const tk = await pdf(`/sales/invoices/${id}/pdf?format=ticket`);
    expect(tk.status).toBe(200); expect(tk.headers['content-disposition']).toContain('-ticket.pdf'); expect(tk.body.subarray(0, 4).toString()).toBe('%PDF');
    expect((await api.get(`/sales/invoices/${d.body.data.id}/pdf`)).status).toBe(200);
    const draft = (await invoice([{ productId: p, quantity: '1', unitPrice: '1' }])).body.data.id;
    expect((await api.get(`/sales/invoices/${draft}/pdf`)).body.error).toBe('DRAFT_NO_PDF');
  });

  it('sin existencia no se factura (todo o nada) y la factura de contado no admite cuenta de otra moneda', async () => {
    const p = await withStock('F-2', 2, 5);
    const d = (await invoice([{ productId: p, quantity: '3', unitPrice: '10' }])).body.data.id;
    const r = await api.post(`/sales/invoices/${d}/confirm`, { payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: '34.8' }] });
    expect(r.status).toBe(422); expect(r.body.error).toBe('INSUFFICIENT_STOCK');
    expect((await stock(p)).totalQuantity).toBe('2');
    expect((await api.get(`/sales/invoices/${d}`)).body.data.status).toBe('DRAFT');
    const d2 = (await invoice([{ productId: p, quantity: '1', unitPrice: '10' }])).body.data.id;
    const mm = await api.post(`/sales/invoices/${d2}/confirm`, { payments: [{ paymentMethodId: trf, bankAccountId: bankUsd, currencyId: b.ves, amount: '11.6' }] });
    expect(mm.body.error).toBe('BANK_CURRENCY_MISMATCH');
  });

  it('IGTF: el pago en divisas suma 3 % y los pagos deben cuadrar con total + IGTF', async () => {
    const p = await withStock('F-3', 10, 5);
    const d = (await api.post('/sales/invoices', { customerId, warehouseId: b.w1, currencyId: b.usd, lines: [{ productId: p, quantity: '1', unitPrice: '100' }] })).body.data.id; // 116 USD
    const pay = (amount: string) => api.post(`/sales/invoices/${d}/confirm`, { payments: [{ paymentMethodId: cashUsd, bankAccountId: bankUsd, currencyId: b.usd, amount }] });
    const bad = await pay('116');
    expect(bad.status).toBe(422); expect(bad.body.error).toBe('PAYMENT_MISMATCH'); // faltó el IGTF
    const ok = await pay('119.59'); // 119,59 − 3 % de 119,59 ≈ 116
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ total: '116', igtfPct: '3' }); expect(Number(ok.body.data.igtfAmount)).toBeCloseTo(3.5877, 3);
    expect(await balance(bankUsd)).toBeCloseTo(119.59, 2);
    expect(ok.body.data.payments[0]).toMatchObject({ appliesIgtf: true });
    // pago mixto: USD con IGTF + Bs sin IGTF: 40 USD (IGTF 1,2) + resto en Bs = (116 + 1,2 − 40) × 40 = 3.088 Bs
    const d2 = (await api.post('/sales/invoices', { customerId, warehouseId: b.w1, currencyId: b.usd, lines: [{ productId: p, quantity: '1', unitPrice: '100' }] })).body.data.id;
    const mix = await api.post(`/sales/invoices/${d2}/confirm`, { payments: [
      { paymentMethodId: cashUsd, bankAccountId: bankUsd, currencyId: b.usd, amount: '40' }, { paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: '3088', reference: 'X1' }] });
    expect(mix.status).toBe(201); expect(Number(mix.body.data.igtfAmount)).toBeCloseTo(1.2, 4);
  });

  it('factura a crédito genera cuenta por cobrar; no admite pagos; se cobra con un recibo; límite de crédito', async () => {
    const p = await withStock('F-4', 10, 5);
    const d = (await invoice([{ productId: p, quantity: '2', unitPrice: '100' }], { paymentCondition: 'CREDIT', creditDays: 10 })).body.data.id; // 232
    expect((await api.post(`/sales/invoices/${d}/confirm`, { payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: '232' }] })).body.error).toBe('PAYMENTS_NOT_ALLOWED');
    const ok = await api.post(`/sales/invoices/${d}/confirm`, {});
    expect(ok.status).toBe(201);
    const entry = ok.body.data.receivable[0];
    expect(entry).toMatchObject({ entryType: 'INVOICE', status: 'OPEN', documentNo: ok.body.data.number }); expect(Number(entry.balance)).toBe(232);
    const rc = await api.post('/treasury/receipts', { customerId, paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, applications: [{ receivableEntryId: entry.id, amount: '232' }] });
    expect(rc.status).toBe(201);
    // anular una factura con cobros no se permite
    expect((await api.post(`/sales/invoices/${d}/cancel`, { reason: 'prueba de cobro' })).body.error).toBe('HAS_COLLECTIONS');
    // límite de crédito
    const lim = (await api.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Limitado F', creditLimit: '100' })).body.data.id;
    const d2 = (await invoice([{ productId: p, quantity: '1', unitPrice: '100' }], { customerId: lim, paymentCondition: 'CREDIT', creditDays: 5 })).body.data.id;
    const ex = await api.post(`/sales/invoices/${d2}/confirm`, {});
    expect(ex.status).toBe(422); expect(ex.body.error).toBe('CREDIT_LIMIT_EXCEEDED');
    expect((await api.post(`/sales/invoices/${d2}/confirm`, { overrideCredit: true })).status).toBe(201);
  });

  it('pedido con reserva → facturas parciales liberan la reserva; anular una factura la restituye', async () => {
    const p = await withStock('F-5', 10, 5);
    const o = (await api.post('/sales/orders', { customerId, warehouseId: b.w1, currencyId: b.ves, reservesStock: true, lines: [{ productId: p, quantity: '6', unitPrice: '10' }] })).body.data.id;
    expect((await api.post(`/sales/orders/${o}/confirm`)).status).toBe(201);
    expect(await reserved(p)).toBe('6');
    const i1 = (await api.post(`/sales/orders/${o}/convert-to-invoice`)).body.data;
    expect(i1).toMatchObject({ docType: 'INVOICE', status: 'DRAFT' }); expect(i1.links.parents[0]).toEqual({ type: 'ORDER', id: o });
    // bajar la factura a 4 unidades
    expect((await api.patch(`/sales/invoices/${i1.id}`, { lines: [{ productId: p, quantity: '4', unitPrice: '10', parentLineId: i1.lines[0].parentLineId }] })).status).toBe(200);
    const pay = (amt: string) => ({ payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: amt }] });
    expect((await api.post(`/sales/invoices/${i1.id}/confirm`, pay('46.4'))).status).toBe(201);
    expect(await reserved(p)).toBe('2'); expect((await stock(p)).totalQuantity).toBe('6');
    expect((await api.get(`/sales/orders/${o}`)).body.data).toMatchObject({ status: 'PARTIALLY_INVOICED' });
    // el resto del pedido
    const i2 = (await api.post(`/sales/orders/${o}/convert-to-invoice`)).body.data;
    expect(Number(i2.lines[0].quantity)).toBe(2);
    expect((await api.post(`/sales/orders/${o}/convert-to-invoice`)).status).toBe(422); // ya hay un borrador que cubre lo pendiente
    expect((await api.post(`/sales/invoices/${i2.id}/confirm`, pay('23.2'))).status).toBe(201);
    expect(await reserved(p)).toBe('0');
    expect((await api.get(`/sales/orders/${o}`)).body.data.status).toBe('INVOICED');
    // anular la primera factura: stock vuelve, reserva se restituye, pedido pasa a parcial
    const cx = await api.post(`/sales/invoices/${i1.id}/cancel`, { reason: 'error de precio' });
    expect(cx.body.data.status).toBe('CANCELLED');
    expect((await stock(p)).totalQuantity).toBe('8'); expect(await reserved(p)).toBe('4');
    expect((await api.get(`/sales/orders/${o}`)).body.data.status).toBe('PARTIALLY_INVOICED');
    expect(await balance(bankVes)).toBeGreaterThanOrEqual(0);
  });

  it('nota de crédito: reingresa al costo original, compensa la cuenta por cobrar y limita a lo facturado', async () => {
    const p = await withStock('F-6', 10, 5);
    // el costo promedio cambia después de vender: la devolución usa el costo de la venta
    const inv = (await invoice([{ productId: p, quantity: '4', unitPrice: '100' }], { paymentCondition: 'CREDIT', creditDays: 30 })).body.data.id; // 464
    const ok = (await api.post(`/sales/invoices/${inv}/confirm`, {})).body.data;
    const other = await withStock('F-6B', 1, 1); void other;
    const ch = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '10', unitCost: '9' }] });
    await api.post(`/inventory/charges/${ch.body.data.id}/confirm`); // promedio sube
    const lineId = ok.lines[0].id;
    const over = await api.post(`/sales/invoices/${inv}/credit-note`, { lines: [{ parentLineId: lineId, quantity: '5' }] });
    expect(over.status).toBe(422); expect(over.body.error).toBe('EXCEEDS_PARENT_QUANTITY');
    const before = (await stock(p)).totalQuantity;
    const cn = await api.post(`/sales/invoices/${inv}/credit-note`, { lines: [{ parentLineId: lineId, quantity: '1' }], notes: 'Producto defectuoso' });
    expect(cn.status).toBe(201);
    expect(cn.body.data).toMatchObject({ docType: 'CREDIT_NOTE', status: 'CONFIRMED', number: expect.stringMatching(/^NC-\d{6}$/), total: '116' });
    expect(Number((await stock(p)).totalQuantity)).toBe(Number(before) + 1);
    const i = (await api.get(`/sales/invoices/${inv}`)).body.data;
    expect(Number(i.receivable[0].balance)).toBe(348); // 464 − 116
    expect(i.lineStatus[0]).toMatchObject({ credited: '1', available: '3' });
    // el mismo reglón otra vez hasta agotar; luego no hay más
    expect((await api.post(`/sales/invoices/${inv}/credit-note`, { lines: [{ parentLineId: lineId, quantity: '3' }] })).status).toBe(201);
    expect((await api.post(`/sales/invoices/${inv}/credit-note`, { lines: [{ parentLineId: lineId, quantity: '1' }] })).body.error).toBe('EXCEEDS_PARENT_QUANTITY');
    expect(Number((await api.get(`/sales/invoices/${inv}`)).body.data.receivable[0].balance)).toBe(0);
    expect((await api.post(`/sales/invoices/${inv}/cancel`, { reason: 'no debería' })).body.error).toBe('HAS_CREDIT_NOTES');
    const pdf = await ctx.http.get(`/api/v1/sales/credit-notes/${cn.body.data.id}/pdf`).set(auth(token)).buffer(true).parse(buf);
    expect(pdf.status).toBe(200); expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('productos por serial: se venden como SOLD, exigen seriales y la devolución solo admite los vendidos', async () => {
    const p = await b.product('F-SER', { trackingMode: 'SERIAL' });
    const ch = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, unitCost: '10', serials: ['S1', 'S2', 'S3'] }] });
    expect((await api.post(`/inventory/charges/${ch.body.data.id}/confirm`)).status).toBe(201);
    const d = (await invoice([{ productId: p, quantity: '2', unitPrice: '50' }])).body.data.id;
    const pay = { payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: '116' }] };
    expect((await api.post(`/sales/invoices/${d}/confirm`, pay)).body.error).toBe('SERIALS_REQUIRED');
    expect((await api.patch(`/sales/invoices/${d}`, { lines: [{ productId: p, quantity: '2', unitPrice: '50', serials: ['S1'] }] })).body.error).toBe('SERIAL_COUNT_MISMATCH');
    await api.patch(`/sales/invoices/${d}`, { lines: [{ productId: p, quantity: '2', unitPrice: '50', serials: ['S1', 'S2'] }] });
    const ok = await api.post(`/sales/invoices/${d}/confirm`, pay);
    expect(ok.status).toBe(201);
    const sold = (await api.get('/inventory/serials?status=SOLD&limit=20')).body.data as any[];
    expect(sold.map(s => s.serialNo).sort()).toEqual(['S1', 'S2']);
    const lineId = ok.body.data.lines[0].id;
    expect((await api.post(`/sales/invoices/${d}/credit-note`, { lines: [{ parentLineId: lineId, quantity: '1', serials: ['S3'] }] })).body.error).toBe('SERIAL_NOT_SOLD');
    expect((await api.post(`/sales/invoices/${d}/credit-note`, { lines: [{ parentLineId: lineId, quantity: '1', serials: ['S2'] }] })).status).toBe(201);
    const inStock = (await api.get('/inventory/serials?status=IN_STOCK&limit=20')).body.data as any[];
    expect(inStock.map(s => s.serialNo).sort()).toEqual(['S2', 'S3']);
  });

  it('anular una factura de contado revierte inventario y banco; permisos del cajero', async () => {
    const p = await withStock('F-7', 5, 5);
    const before = await balance(bankVes);
    const d = (await invoice([{ productId: p, quantity: '2', unitPrice: '50' }])).body.data.id;
    const ok = await api.post(`/sales/invoices/${d}/confirm`, { payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: '116' }] });
    expect(ok.status).toBe(201); expect(await balance(bankVes)).toBe(before + 116);
    const cx = await api.post(`/sales/invoices/${d}/cancel`, { reason: 'cliente se arrepintió' });
    expect(cx.body.data.status).toBe('CANCELLED');
    expect((await stock(p)).totalQuantity).toBe('5'); expect(await balance(bankVes)).toBe(before);
    expect((await api.post(`/sales/invoices/${d}/cancel`, { reason: 'otra vez' })).status).toBe(422);
    // el cajero puede facturar pero no anular
    const email = `caj-${Math.random().toString(36).slice(2, 7)}@test.local`;
    await api.post('/users', { email, fullName: 'Cajero Uno', password: PASSWORD, roleCodes: ['CAJERO'] });
    const cj = client(ctx, (await ctx.http.post('/api/v1/auth/login').send({ email, password: PASSWORD })).body.data.accessToken);
    const d2 = await cj.post('/sales/invoices', { customerId, warehouseId: b.w1, currencyId: b.ves, lines: [{ productId: p, quantity: '1', unitPrice: '10' }] });
    expect(d2.status).toBe(201);
    expect((await cj.post(`/sales/invoices/${d2.body.data.id}/confirm`, { payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: '11.6' }] })).status).toBe(201);
    expect((await cj.post(`/sales/invoices/${d2.body.data.id}/cancel`, { reason: 'no puedo' })).status).toBe(403);
  });

  it('libro de ventas: facturas, notas (restan) y anuladas sin montos', async () => {
    const t2 = await createTenant(ctx, 'LibroVentas'); const a2 = client(ctx, t2.token); const b2 = await seedBasics(a2);
    await a2.post('/exchange-rates', { currencyId: b2.usd, rate: '40', date: today() });
    const bank = (await a2.get('/banks?limit=5')).body.data[0].id;
    const acc = (await a2.post('/bank-accounts', { bankId: bank, name: 'Bs', number: '01020000000000000031', currencyId: b2.ves })).body.data.id;
    const m = (await a2.post('/payment-methods', { code: 'TRF', name: 'Transferencia', type: 'TRANSFER' })).body.data.id;
    const cust = (await a2.post('/customers', { rif: uniqueRif('V'), legalName: 'Cliente Libro' })).body.data.id;
    const p = await b2.product('LB-1');
    const ch = await a2.post('/inventory/charges', { warehouseId: b2.w1, lines: [{ productId: p, quantity: '20', unitCost: '1' }] });
    await a2.post(`/inventory/charges/${ch.body.data.id}/confirm`);
    const mk = async (qty: string) => {
      const d = (await a2.post('/sales/invoices', { customerId: cust, warehouseId: b2.w1, currencyId: b2.ves, lines: [{ productId: p, quantity: qty, unitPrice: '100' }] })).body.data.id;
      const total = (Number(qty) * 116).toFixed(2);
      const r = await a2.post(`/sales/invoices/${d}/confirm`, { payments: [{ paymentMethodId: m, bankAccountId: acc, currencyId: b2.ves, amount: total }] });
      expect(r.status).toBe(201); return r.body.data;
    };
    const f1 = await mk('2'); const f2 = await mk('1');
    await a2.post(`/sales/invoices/${f2.id}/cancel`, { reason: 'duplicada' });
    await a2.post(`/sales/invoices/${f1.id}/credit-note`, { lines: [{ parentLineId: f1.lines[0].id, quantity: '1' }] });
    const book = (await a2.get('/reports/sales/book')).body.data;
    expect(book.rows.map((r: any) => r.type)).toEqual(['Factura', 'Factura anulada', 'Nota de crédito']);
    expect(book.rows.map((r: any) => Number(r.total_bs))).toEqual([232, 0, -116]);
    expect(book.rows[0]).toMatchObject({ number: f1.number, control_no: f1.controlNo });
    expect(Number(book.totals.base_bs)).toBe(100); expect(Number(book.totals.tax_bs)).toBe(16); expect(Number(book.totals.total_bs)).toBe(116);
  });

  it('costo por serial: cada unidad sale a su propio costo y el promedio del resto se recalcula', async () => {
    const p = await b.product('F-SERCOST', { trackingMode: 'SERIAL' });
    const charge = async (serial: string, cost: string) => {
      const ch = await api.post('/inventory/charges', { warehouseId: b.w1, lines: [{ productId: p, unitCost: cost, serials: [serial] }] });
      expect((await api.post(`/inventory/charges/${ch.body.data.id}/confirm`)).status).toBe(201);
    };
    await charge('C1', '10'); await charge('C2', '20');
    expect((await stock(p)).avgCost).toBe('15');
    const sell = async (serial: string) => {
      const d = (await invoice([{ productId: p, quantity: '1', unitPrice: '100', serials: [serial] }])).body.data.id;
      const r = await api.post(`/sales/invoices/${d}/confirm`, { payments: [{ paymentMethodId: trf, bankAccountId: bankVes, currencyId: b.ves, amount: '116' }] });
      expect(r.status).toBe(201); return r.body.data;
    };
    const f1 = await sell('C1');
    expect(Number(f1.lines[0].unitCost)).toBe(10); // costo de C1, no el promedio 15
    expect((await stock(p)).avgCost).toBe('20');   // queda solo C2
    const f2 = await sell('C2');
    expect(Number(f2.lines[0].unitCost)).toBe(20);
    // la devolución reingresa a ESE costo
    const cn = await api.post(`/sales/invoices/${f1.id}/credit-note`, { lines: [{ parentLineId: f1.lines[0].id, quantity: '1', serials: ['C1'] }] });
    expect(cn.status).toBe(201);
    expect((await stock(p)).avgCost).toBe('10');
    // un serial sin costo registrado (datos previos) cae al promedio
    const kardex = (await api.get(`/inventory/kardex?productId=${p}&limit=20`)).body.data as any[];
    expect(kardex.filter(k => Number(k.quantity) < 0).map(k => Number(k.unitCost)).sort()).toEqual([10, 20]);
  });
});
