import { bootstrap, Ctx, createTenant, client, Api, seedBasics, uniqueRif } from './helpers';

describe('Compras: cotización → orden → nota de entrega → compra → devoluciones → CxP', () => {
  let ctx: Ctx; let api: Api; let b: Awaited<ReturnType<typeof seedBasics>>; let supplierId: string;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Caracas' });
  beforeAll(async () => {
    ctx = await bootstrap();
    const t = await createTenant(ctx, 'Compras'); api = client(ctx, t.token); b = await seedBasics(api);
    supplierId = (await api.post('/suppliers', { rif: uniqueRif(), legalName: 'Proveedor Uno', creditDays: 15 })).body.data.id;
    await api.post('/exchange-rates', { currencyId: b.usd, rate: '40', date: today() });
  });
  afterAll(async () => { await ctx.close(); });

  const stock = async (p: string) => (await api.get(`/products/${p}/stock`)).body.data;
  const doc = (extra: object, lines: object[]) => ({ supplierId, warehouseId: b.w1, currencyId: b.usd, paymentCondition: 'CREDIT', creditDays: 15, lines, ...extra });

  it('calcula totales con IVA congelado por línea y total en Bs a la tasa del día', async () => {
    const p = await b.product('TOT-1');
    const r = await api.post('/purchases/orders', doc({}, [{ productId: p, quantity: '3', unitCost: '12.5', discountPct: '5' }]));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'DRAFT', number: null, subtotal: '35.625', taxTotal: '5.7', total: '41.325', exchangeRate: '40' });
    expect(r.body.data.totalBase).toBe('1653');
    expect(r.body.data.lines[0].taxRate).toBe('16');
  });

  it('flujo completo: cotización → orden → recepción parcial/total → compra → CxP', async () => {
    const p = await b.product('FLOW-1');
    const q = await api.post('/purchases/quotes', doc({ expiresAt: '2099-12-31' }, [{ productId: p, quantity: '10', unitCost: '5' }]));
    const qid = q.body.data.id;
    expect((await api.post(`/purchases/orders`, { ...doc({}, []), lines: [] })).status).toBe(400);
    expect((await api.post(`/purchases/quotes/${qid}/convert-to-order`)).status).toBe(422); // aún no aceptada
    const sent = await api.post(`/purchases/quotes/${qid}/send`);
    expect(sent.body.data).toMatchObject({ status: 'SENT', number: expect.stringMatching(/^COT-C-\d{6}$/) });
    expect((await api.post(`/purchases/quotes/${qid}/accept`)).body.data.status).toBe('ACCEPTED');
    const order = (await api.post(`/purchases/quotes/${qid}/convert-to-order`)).body.data;
    expect(order.status).toBe('DRAFT'); expect(order.links.parents[0]).toEqual({ type: 'QUOTE', id: qid });
    expect((await api.post(`/purchases/quotes/${qid}/convert-to-order`)).status).toBe(409); // no se convierte dos veces
    const oc = await api.post(`/purchases/orders/${order.id}/confirm`);
    expect(oc.body.data).toMatchObject({ status: 'CONFIRMED', number: expect.stringMatching(/^OC-\d{6}$/) });
    expect((await stock(p)).totalQuantity).toBe('0'); // la orden no mueve inventario

    const lineId = oc.body.data.lines[0].id;
    // recepción parcial de 4
    const r1 = await api.post(`/purchases/orders/${order.id}/receive`, { lines: [{ orderLineId: lineId, quantity: '4' }] });
    expect(r1.status).toBe(201);
    expect(r1.body.data).toMatchObject({ docType: 'DELIVERY_NOTE', status: 'CONFIRMED', number: expect.stringMatching(/^NE-/) });
    expect((await stock(p)).totalQuantity).toBe('4');
    let o = (await api.get(`/purchases/orders/${order.id}`)).body.data;
    expect(o.status).toBe('PARTIALLY_FULFILLED');
    expect(o.lineStatus[0]).toMatchObject({ ordered: '10', received: '4', pending: '6' });
    // no se puede recibir más de lo pendiente
    const over = await api.post(`/purchases/orders/${order.id}/receive`, { lines: [{ orderLineId: lineId, quantity: '7' }] });
    expect(over.status).toBe(422); expect(over.body.error).toBe('EXCEEDS_PARENT_QUANTITY');
    // no se anula una orden con recepciones
    expect((await api.post(`/purchases/orders/${order.id}/cancel`, { reason: 'ya no' })).body.error).toBe('ORDER_HAS_RECEIPTS');
    // recepción del resto
    const r2 = await api.post(`/purchases/orders/${order.id}/receive`, { lines: [{ orderLineId: lineId, quantity: '6' }] });
    expect(r2.status).toBe(201);
    o = (await api.get(`/purchases/orders/${order.id}`)).body.data;
    expect(o.status).toBe('FULFILLED');
    expect((await stock(p)).totalQuantity).toBe('10');
    // costo: 5 USD, moneda de valoración USD → sin conversión
    expect((await stock(p)).avgCost).toBe('5');

    // facturar la primera nota de entrega
    const dnId = r1.body.data.id;
    const pur = (await api.post(`/purchases/delivery-notes/${dnId}/convert-to-purchase`)).body.data;
    expect(pur).toMatchObject({ docType: 'PURCHASE', status: 'DRAFT' });
    expect((await api.post(`/purchases/delivery-notes/${dnId}/convert-to-purchase`)).status).toBe(422); // ya está en una compra
    // sin número de factura del proveedor no confirma
    const noNo = await api.post(`/purchases/${pur.id}/confirm`);
    expect(noNo.status).toBe(422); expect(noNo.body.error).toBe('SUPPLIER_DOC_REQUIRED');
    await api.patch(`/purchases/${pur.id}`, { supplierDocNo: 'FAC-0001', supplierControlNo: '00-123456' });
    const conf = await api.post(`/purchases/${pur.id}/confirm`);
    expect(conf.status).toBe(201);
    expect(conf.body.data).toMatchObject({ status: 'CONFIRMED', number: expect.stringMatching(/^COMP-\d{6}$/) });
    expect((await stock(p)).totalQuantity).toBe('10'); // NO se duplica la entrada: ya entró por la nota de entrega
    expect(conf.body.data.payable[0]).toMatchObject({ status: 'OPEN', amount: '23.2', balance: '23.2' }); // 4×5=20 + IVA 3.2
    expect((await api.get(`/purchases/delivery-notes/${dnId}`)).body.data.status).toBe('INVOICED');
    expect(conf.body.data.payable[0].dueDate.slice(0, 10)).toBe(new Date(new Date(today()).getTime() + 15 * 86400000).toISOString().slice(0, 10));
    // una nota facturada no se anula
    expect((await api.post(`/purchases/delivery-notes/${dnId}/cancel`, { reason: 'error' })).body.error).toBe('DOCUMENT_INVOICED');
  });

  it('compra directa: entra inventario, genera CxP, devolución parcial al costo original y anulación', async () => {
    const p = await b.product('DIR-1');
    const c1 = (await api.post('/purchases', doc({ supplierDocNo: 'F-1' }, [{ productId: p, quantity: '10', unitCost: '5' }]))).body.data;
    await api.post(`/purchases/${c1.id}/confirm`);
    const c2 = (await api.post('/purchases', doc({ supplierDocNo: 'F-2' }, [{ productId: p, quantity: '10', unitCost: '7' }]))).body.data;
    const c2c = (await api.post(`/purchases/${c2.id}/confirm`)).body.data;
    expect(await stock(p)).toMatchObject({ totalQuantity: '20', avgCost: '6' });
    await api.post('/inventory/discharges', { warehouseId: b.w1, lines: [{ productId: p, quantity: '5' }] }).then(d => api.post(`/inventory/discharges/${d.body.data.id}/confirm`));
    // devolver 10 de la segunda compra (7 c/u) → promedio (15×6 − 10×7)/5 = 4
    const lineId = c2c.lines[0].id;
    const ret = await api.post('/purchases/returns', doc({ parentId: c2.id }, [{ productId: p, quantity: '10', unitCost: '7', parentLineId: lineId }]));
    expect(ret.status).toBe(201);
    const rc = await api.post(`/purchases/returns/${ret.body.data.id}/confirm`);
    expect(rc.status).toBe(201);
    expect(await stock(p)).toMatchObject({ totalQuantity: '5', avgCost: '4' });
    // la CxP de la compra se redujo por el valor de la devolución (10×7 + IVA = 81.2)
    const parent = (await api.get(`/purchases/${c2.id}`)).body.data;
    expect(parent.payable.find((x: any) => x.entryType === 'INVOICE')).toMatchObject({ amount: '81.2', balance: '0', status: 'PAID' });
    expect(parent.lineStatus[0]).toMatchObject({ returned: '10', available: '0' });
    // no se puede devolver más de lo comprado
    const again = await api.post('/purchases/returns', doc({ parentId: c2.id }, [{ productId: p, quantity: '1', unitCost: '7', parentLineId: lineId }]));
    expect(again.status).toBe(422); expect(again.body.error).toBe('EXCEEDS_PARENT_QUANTITY');
    // una compra con devoluciones activas no se anula…
    expect((await api.post(`/purchases/${c2.id}/cancel`, { reason: 'error' })).body.error).toBe('HAS_DEPENDENT_DOCUMENTS');
    // …pero al anular la devolución todo vuelve atrás
    await api.post(`/purchases/returns/${ret.body.data.id}/cancel`, { reason: 'Devolución errónea' });
    expect(await stock(p)).toMatchObject({ totalQuantity: '15', avgCost: '6' });
    expect((await api.get(`/purchases/${c2.id}`)).body.data.payable.find((x: any) => x.entryType === 'INVOICE')).toMatchObject({ balance: '81.2', status: 'OPEN' });
    // ahora sí se anula la compra: revierte inventario y cancela CxP
    const cx = await api.post(`/purchases/${c2.id}/cancel`, { reason: 'Factura duplicada' });
    expect(cx.body.data.status).toBe('CANCELLED');
    expect(await stock(p)).toMatchObject({ totalQuantity: '5', avgCost: '4' });
    expect(cx.body.data.links).toBeDefined();
    expect((await api.get(`/purchases/${c2.id}`)).body.data.payable[0].status).toBe('CANCELLED');
  });

  it('convierte a moneda de valoración: compra en Bs con tasa USD', async () => {
    const p = await b.product('BS-1');
    // 400 Bs/unidad a 40 Bs/USD → 10 USD (valoración USD)
    const d = (await api.post('/purchases', { supplierId, warehouseId: b.w1, currencyId: b.ves, supplierDocNo: 'BS-1', paymentCondition: 'CASH', lines: [{ productId: p, quantity: '2', unitCost: '400' }] })).body.data;
    expect(d.exchangeRate).toBe('1');
    const c = await api.post(`/purchases/${d.id}/confirm`);
    expect(c.status).toBe(201);
    expect((await stock(p)).avgCost).toBe('10');
    // de contado → CxP pagada
    expect(c.body.data.payable[0]).toMatchObject({ status: 'PAID', balance: '0' });
  });

  it('nota de entrega: anulación revierte inventario; devolución de nota sale al costo original', async () => {
    const p = await b.product('DN-1');
    const dn = (await api.post('/purchases/delivery-notes', doc({}, [{ productId: p, quantity: '8', unitCost: '3' }]))).body.data;
    const dc = (await api.post(`/purchases/delivery-notes/${dn.id}/confirm`)).body.data;
    expect((await stock(p)).totalQuantity).toBe('8');
    const ret = await api.post('/purchases/delivery-note-returns', doc({ parentId: dn.id }, [{ productId: p, quantity: '3', unitCost: '3', parentLineId: dc.lines[0].id }]));
    await api.post(`/purchases/delivery-note-returns/${ret.body.data.id}/confirm`);
    expect((await stock(p)).totalQuantity).toBe('5');
    // con una devolución activa la nota no se anula
    expect((await api.post(`/purchases/delivery-notes/${dn.id}/cancel`, { reason: 'por error' })).body.error).toBe('HAS_DEPENDENT_DOCUMENTS');
    await api.post(`/purchases/delivery-note-returns/${ret.body.data.id}/cancel`, { reason: 'por error' });
    const c = await api.post(`/purchases/delivery-notes/${dn.id}/cancel`, { reason: 'Mercancía no llegó' });
    expect(c.body.data.status).toBe('CANCELLED');
    expect((await stock(p)).totalQuantity).toBe('0');
  });

  it('borradores editables, eliminables y con validaciones; confirmados inmutables', async () => {
    const p = await b.product('EDIT-1');
    const d = (await api.post('/purchases/orders', doc({}, [{ productId: p, quantity: '1', unitCost: '10' }]))).body.data;
    const up = await api.patch(`/purchases/orders/${d.id}`, { lines: [{ productId: p, quantity: '2', unitCost: '10' }] });
    expect(up.body.data.total).toBe('23.2'); expect(up.body.data.version).toBe(d.version + 1);
    expect((await api.patch(`/purchases/orders/${d.id}`, { version: 1, notes: 'x' })).status).toBe(409);
    await api.post(`/purchases/orders/${d.id}/confirm`);
    expect((await api.patch(`/purchases/orders/${d.id}`, { notes: 'x' })).status).toBe(422);
    expect((await api.del(`/purchases/orders/${d.id}`)).status).toBe(422);
    const c = await api.post(`/purchases/orders/${d.id}/cancel`, { reason: 'Cambio de proveedor' });
    expect(c.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Cambio de proveedor' });
    const draft = (await api.post('/purchases/orders', doc({}, [{ productId: p, quantity: '1', unitCost: '1' }]))).body.data;
    expect((await api.del(`/purchases/orders/${draft.id}`)).status).toBe(200);
    expect((await api.get(`/purchases/orders/${draft.id}`)).status).toBe(404);
    // proveedor inactivo / producto de servicio / moneda sin tasa
    const noRate = await api.post('/purchases/orders', { ...doc({}, [{ productId: p, quantity: '1', unitCost: '1' }]), currencyId: (await api.get('/currencies')).body.data.find((x: any) => x.code === 'EUR').id });
    expect(noRate.status).toBe(422); expect(noRate.body.error).toBe('RATE_NOT_FOUND');
  });

  it('numeración de compras sin huecos bajo concurrencia', async () => {
    const p = await b.product('NUMC-1');
    const drafts = await Promise.all(Array.from({ length: 8 }, (_, i) => api.post('/purchases/orders', doc({}, [{ productId: p, quantity: '1', unitCost: '1' }]))));
    const res = await Promise.all(drafts.map(d => api.post(`/purchases/orders/${d.body.data.id}/confirm`)));
    expect(res.every(r => r.status === 201)).toBe(true);
    const nums = res.map(r => Number(r.body.data.number.replace('OC-', ''))).sort((a, c) => a - c);
    expect(new Set(nums).size).toBe(8);
    expect(nums[7] - nums[0]).toBe(7);
  });

  it('la compra concurrente del mismo documento solo se confirma una vez', async () => {
    const p = await b.product('DBL-1');
    const d = (await api.post('/purchases', doc({ supplierDocNo: 'DBL' }, [{ productId: p, quantity: '5', unitCost: '2' }]))).body.data;
    const res = await Promise.all([api.post(`/purchases/${d.id}/confirm`), api.post(`/purchases/${d.id}/confirm`)]);
    expect(res.map(r => r.status).sort()).toEqual([201, 422]);
    expect((await stock(p)).totalQuantity).toBe('5');
  });
});
