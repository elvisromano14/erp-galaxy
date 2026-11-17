import { COLS, pair, receiptEscPos, receiptHtml, receiptLines, receiptText, wrap } from './receipt58';
import type { InvoicePdfData } from './invoice-pdf';

const data: InvoicePdfData = {
  kind: 'INVOICE', number: '00001234', controlNo: null, status: 'ISSUED', docDate: '2026-11-17', currency: 'USD', exchangeRate: '50', paymentCondition: 'CASH', creditDays: 0, seller: 'María Pérez',
  company: { rif: 'J-12345678-9', legalName: 'Eléctricos del Sur, C.A.', fiscalAddress: 'Av. Principal, local 5, Maracaibo, Estado Zulia' },
  customer: { rif: 'V-1234567', legalName: 'José Ñandú' },
  lines: [
    { sku: 'A-1', name: 'AMORTIGUADOR DELANTERO IZQUIERDO FIESTA POWER', brand: 'KMD', quantity: '2', unitPrice: '12.5', discountPct: '0', taxRate: '16', net: '25', exempt: false, serials: [] },
    { sku: 'A-2', name: 'Cinta aislante', quantity: '1.5', unitPrice: '1', discountPct: '10', taxRate: '0', net: '1.35', exempt: true, serials: [] },
  ],
  subtotal: '26.35', exemptBase: '1.35', taxTotal: '4', total: '30.35', totalBase: '1517.5', igtfPct: '3', igtfAmount: '0.91',
  payments: [{ method: 'Zelle', currency: 'USD', amount: '31.26', reference: 'ABC123' }], legend: 'Comprobante de gestión interna.',
};

describe('recibo térmico 58 mm', () => {
  it('ninguna línea supera 32 columnas y todo es ASCII (sin acentos)', () => {
    const txt = receiptText(receiptLines(data));
    for (const l of txt.split('\n')) expect(l.length).toBeLessThanOrEqual(COLS);
    expect(txt).toMatch(/^[\x0a\x20-\x7e]*$/);
    expect(txt).toContain('Electricos del Sur, C.A.');
    expect(txt).toContain('Jose Nandu');
    expect(txt).toContain('Marca: KMD');
  });
  it('alinea etiqueta y valor a exactamente 32 columnas y recorta etiquetas largas', () => {
    expect(pair('TOTAL USD', '30,35')).toHaveLength(COLS);
    expect(pair('X'.repeat(50), '1.234,56')).toHaveLength(COLS);
    expect(wrap('a'.repeat(70))).toEqual(['a'.repeat(32), 'a'.repeat(32), 'a'.repeat(6)]);
  });
  it('muestra totales en USD y Bs con la tasa, IGTF y pagos', () => {
    const txt = receiptText(receiptLines(data));
    expect(txt).toContain('TOTAL USD');
    expect(txt).toMatch(/Tasa\s+50,0000/);
    expect(txt).toContain('IGTF 3%');
    expect(txt).toContain('Ref. ABC123');
  });
  it('ESC/POS: inicia con ESC @, termina con corte y no emite bytes fuera de ASCII en el texto', () => {
    const b = receiptEscPos(receiptLines(data));
    expect([...b.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...b.subarray(b.length - 4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    expect(b.includes(0x1b)).toBe(true);
    expect([...receiptEscPos(receiptLines(data), { cut: false }).subarray(-4)]).not.toEqual([0x1d, 0x56, 0x42, 0x00]);
  });
  it('HTML escapa el contenido y fija @page 58mm', () => {
    const h = receiptHtml(receiptLines({ ...data, customer: { rif: 'V-1', legalName: '<b>x</b>' } }), 'R');
    expect(h).toContain('size:58mm auto');
    expect(h).not.toContain('<b>x</b>');
  });
});
