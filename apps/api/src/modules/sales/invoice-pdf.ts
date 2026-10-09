import { renderPdf } from '../reports/report-export';

export interface InvoicePdfData {
  kind: 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
  number: string | null; controlNo: string | null; status: string; docDate: string; dueDate?: string | null;
  currency: string; exchangeRate: string; paymentCondition: string; creditDays: number; seller?: string | null; notes?: string | null; origin?: string | null;
  company: { rif: string; legalName: string; tradeName?: string | null; fiscalAddress?: string | null; isSpecialTaxpayer?: boolean };
  customer: { rif: string; legalName: string; address?: string | null; phone?: string | null };
  lines: { sku: string; name: string; description?: string | null; quantity: string; unitPrice: string; discountPct: string; taxRate: string; net: string; exempt: boolean; serials: string[] }[];
  subtotal: string; exemptBase: string; taxTotal: string; total: string; totalBase: string; igtfPct: string; igtfAmount: string;
  payments: { method: string; currency: string; amount: string; reference?: string | null }[];
  legend: string;
}

const n = (v: string | number, dp = 2) => Number(v).toLocaleString('es-VE', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const day = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/** Desglose por alícuota: base imponible e IVA por tasa (las líneas exentas aparte). */
function byRate(d: InvoicePdfData) {
  const map = new Map<string, { base: number; tax: number }>();
  for (const l of d.lines) {
    if (l.exempt) continue;
    const g = map.get(l.taxRate) ?? { base: 0, tax: 0 };
    g.base += Number(l.net); g.tax += Number(l.net) * Number(l.taxRate) / 100; map.set(l.taxRate, g);
  }
  return [...map].sort((a, b) => Number(a[0]) - Number(b[0]));
}

export function invoicePdf(d: InvoicePdfData, format: 'a4' | 'ticket'): Promise<Buffer> {
  const title = d.kind === 'INVOICE' ? 'FACTURA' : d.kind === 'CREDIT_NOTE' ? 'NOTA DE CRÉDITO' : 'NOTA DE DÉBITO';
  const ticket = format === 'ticket';
  const fs = ticket ? 7.5 : 9;
  const isVes = d.currency === 'VES';
  const grey = '#667085';
  const head = [
    { text: d.company.legalName, bold: true, fontSize: ticket ? 9 : 13, alignment: ticket ? 'center' : 'left' },
    { text: `RIF: ${d.company.rif}${d.company.isSpecialTaxpayer ? ' · Contribuyente especial' : ''}`, alignment: ticket ? 'center' : 'left', color: grey },
    ...(d.company.fiscalAddress ? [{ text: d.company.fiscalAddress, alignment: ticket ? 'center' : 'left', color: grey }] : []),
  ];
  const ident = ticket
    ? [{ text: `${title} ${d.number ?? '(borrador)'}`, bold: true, alignment: 'center', margin: [0, 6, 0, 0] }, { text: `Control: ${d.controlNo ?? '—'}`, alignment: 'center' }, { text: `Fecha: ${day(d.docDate)}`, alignment: 'center' }]
    : [{ text: title, bold: true, fontSize: 16, alignment: 'right' }, { text: `N° ${d.number ?? '(borrador)'}`, bold: true, alignment: 'right', fontSize: 12 }, { text: `N° de control: ${d.controlNo ?? '—'}`, alignment: 'right' }, { text: `Fecha de emisión: ${day(d.docDate)}`, alignment: 'right' }, ...(d.status === 'CANCELLED' ? [{ text: 'ANULADA', color: '#d92d20', bold: true, alignment: 'right', fontSize: 12 }] : [])];
  const party = [
    { text: `Cliente: ${d.customer.legalName}`, bold: true }, { text: `RIF: ${d.customer.rif}` },
    ...(d.customer.address ? [{ text: `Dirección: ${d.customer.address}` }] : []), ...(d.customer.phone && !ticket ? [{ text: `Teléfono: ${d.customer.phone}` }] : []),
    { text: `Condición: ${d.paymentCondition === 'CREDIT' ? `Crédito ${d.creditDays} días${d.dueDate ? ` (vence ${day(d.dueDate)})` : ''}` : 'Contado'}${d.seller ? ` · Vendedor: ${d.seller}` : ''}`, color: grey },
    ...(d.origin ? [{ text: `Afecta a: ${d.origin}`, color: grey }] : []),
  ];

  const lineRows = d.lines.map(l => ticket
    ? [{ stack: [{ text: `${l.name}${l.exempt ? ' (E)' : ''}` }, { text: `${n(l.quantity, 2)} x ${n(l.unitPrice)}${Number(l.discountPct) ? ` -${n(l.discountPct)}%` : ''}`, color: grey }], colSpan: 1 }, { text: n(Number(l.net) * (1 + (l.exempt ? 0 : Number(l.taxRate) / 100))), alignment: 'right' }]
    : [
      { stack: [{ text: l.sku, bold: true }, ...(l.serials.length ? [{ text: `Seriales: ${l.serials.join(', ')}`, fontSize: 6.5, color: grey }] : [])] },
      { text: l.description || l.name }, { text: n(l.quantity, 2), alignment: 'right' }, { text: n(l.unitPrice), alignment: 'right' },
      { text: Number(l.discountPct) ? `${n(l.discountPct)}%` : '', alignment: 'right' }, { text: l.exempt ? 'Exento' : `${n(l.taxRate)}%`, alignment: 'right' }, { text: n(l.net), alignment: 'right' },
    ]);
  const linesTable = ticket
    ? { table: { widths: ['*', 'auto'], body: [[{ text: 'Descripción', bold: true }, { text: 'Total', bold: true, alignment: 'right' }], ...lineRows] }, layout: 'lightHorizontalLines' }
    : { table: { headerRows: 1, widths: [60, '*', 40, 55, 32, 40, 60], body: [
      ['Código', 'Descripción', 'Cant.', 'Precio', 'Desc.', 'IVA', 'Total'].map((h, i) => ({ text: h, bold: true, color: '#ffffff', fillColor: '#465fff', alignment: i > 1 ? 'right' : 'left' })), ...lineRows] },
    layout: { hLineColor: () => '#e4e7ec', vLineColor: () => '#ffffff', hLineWidth: () => 0.5, vLineWidth: () => 0, paddingTop: () => 3, paddingBottom: () => 3 } };

  const t = (label: string, value: string, bold = false) => [{ text: label, bold, alignment: 'right' }, { text: value, bold, alignment: 'right' }];
  const rows = [
    ...(Number(d.exemptBase) > 0 ? [t('Monto exento', n(d.exemptBase))] : []),
    ...byRate(d).flatMap(([rate, g]) => [t(`Base imponible ${n(rate)}%`, n(g.base)), t(`IVA ${n(rate)}%`, n(g.tax))]),
    t('Subtotal', n(d.subtotal)), ...(Number(d.igtfAmount) > 0 ? [t(`IGTF ${n(d.igtfPct)}%`, n(d.igtfAmount))] : []),
    t(`TOTAL ${d.currency}`, n(Number(d.total) + Number(d.igtfAmount)), true),
    ...(!isVes ? [t(`Tasa de cambio`, n(d.exchangeRate, 4)), t('TOTAL Bs', n(Number(d.totalBase) + Number(d.igtfAmount) * Number(d.exchangeRate)), true)] : []),
  ];
  const totals = { table: { widths: ticket ? ['*', 'auto'] : ['*', 90], body: rows }, layout: 'noBorders', margin: [0, 6, 0, 0] };
  const pays = d.payments.length ? [
    { text: 'Pagos', bold: true, margin: [0, 8, 0, 2] },
    ...d.payments.map(p => ({ text: `${p.method}: ${n(p.amount)} ${p.currency}${p.reference ? ` (ref. ${p.reference})` : ''}`, color: grey })),
  ] : [];

  return renderPdf({
    pageSize: ticket ? { width: 226.77, height: 'auto' } : 'A4', pageMargins: ticket ? [8, 8, 8, 8] : [36, 36, 36, 50],
    defaultStyle: { font: 'Roboto', fontSize: fs }, info: { title: `${title} ${d.number ?? ''}`, author: d.company.legalName },
    footer: ticket ? undefined : { text: d.legend, alignment: 'center', color: grey, fontSize: 7, margin: [0, 14, 0, 0] },
    content: [
      ...(ticket ? [...head, ...ident, { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 210, y2: 4, lineWidth: 0.5 }] }, ...party] : [
        { columns: [{ stack: head, width: '*' }, { stack: ident, width: 200 }] },
        { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 523, y2: 6, lineWidth: 0.5, lineColor: '#e4e7ec' }], margin: [0, 0, 0, 6] }, { stack: party, margin: [0, 0, 0, 10] }]),
      linesTable, totals, ...pays,
      ...(d.notes ? [{ text: `Observaciones: ${d.notes}`, margin: [0, 8, 0, 0], color: grey }] : []),
      ...(ticket ? [{ text: d.legend, alignment: 'center', fontSize: 6, color: grey, margin: [0, 8, 0, 0] }] : []),
    ],
  });
}
