import type { InvoicePdfData } from './invoice-pdf';

/**
 * Recibo para impresora térmica de 58 mm (MP58-04 y similares: 384 puntos, 32 columnas en fuente A).
 * Todo el diseño sale de una lista de líneas con formato (`ReceiptLine`) que luego se serializa a ESC/POS, texto o HTML.
 * Los acentos se transliteran a ASCII: evita depender de la tabla de caracteres (code page) de cada impresora.
 */
export const COLS = 32;

export interface ReceiptLine { text: string; align?: 'left' | 'center' | 'right'; bold?: boolean; big?: boolean; rule?: boolean; feed?: boolean }

const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/·/g, '-').replace(/[^\x20-\x7e]/g, '?');
const num = (v: string | number, dp = 2) => Number(v).toLocaleString('es-VE', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const day = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/** Parte un texto en líneas de `width` caracteres sin cortar palabras (corta las palabras más largas que el ancho). */
export function wrap(text: string, width = COLS): string[] {
  const out: string[] = [];
  for (const para of ascii(text).split(/\r?\n/)) {
    let line = '';
    for (let w of para.split(/\s+/).filter(Boolean)) {
      while (w.length > width) { if (line) { out.push(line); line = ''; } out.push(w.slice(0, width)); w = w.slice(width); }
      if (!line) line = w; else if (line.length + 1 + w.length <= width) line += ' ' + w; else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

/** «etiqueta ........ valor» en exactamente `width` columnas (la etiqueta se recorta si no cabe). */
export function pair(label: string, value: string, width = COLS): string {
  const l = ascii(label), v = ascii(value);
  const room = width - v.length - 1;
  return `${l.length > room ? l.slice(0, Math.max(room, 0)) : l.padEnd(room)} ${v}`.slice(0, width);
}

export function receiptLines(d: InvoicePdfData): ReceiptLine[] {
  const L: ReceiptLine[] = [];
  const add = (text: string, o: Omit<ReceiptLine, 'text'> = {}) => L.push({ text, ...o });
  const wrapAdd = (text: string, o: Omit<ReceiptLine, 'text'> = {}) => wrap(text).forEach(t => add(t, o));
  const rule = () => L.push({ text: '-'.repeat(COLS), rule: true });
  const title = d.kind === 'INVOICE' ? 'FACTURA' : d.kind === 'CREDIT_NOTE' ? 'NOTA DE CREDITO' : 'NOTA DE DEBITO';
  const isVes = d.currency === 'VES';

  wrap(d.company.tradeName || d.company.legalName, COLS).forEach(t => add(t, { align: 'center', bold: true, big: true }));
  add(`RIF: ${d.company.rif}`, { align: 'center' });
  if (d.company.isSpecialTaxpayer) add('Contribuyente especial', { align: 'center' });
  if (d.company.fiscalAddress) wrapAdd(d.company.fiscalAddress, { align: 'center' });
  rule();
  add(`${title} ${d.number ?? '(borrador)'}`, { align: 'center', bold: true });
  if (d.fiscalNumber) add(`Fiscal ${d.fiscalNumber}`, { align: 'center' });
  add(pair('Fecha:', day(d.docDate)));
  wrapAdd(`Cliente: ${d.customer.legalName}`);
  add(`RIF: ${d.customer.rif}`);
  if (d.customer.address) wrapAdd(`Dir: ${d.customer.address}`);
  add(pair('Condicion:', d.paymentCondition === 'CREDIT' ? `Credito ${d.creditDays} dias` : 'Contado'));
  if (d.seller) add(pair('Vendedor:', d.seller));
  if (d.origin) wrapAdd(`Afecta a: ${d.origin}`);
  rule();

  for (const l of d.lines) {
    wrapAdd(`${l.name}${l.exempt ? ' (E)' : ''}`, { bold: true });
    if (l.brand) wrapAdd(`Marca: ${l.brand}`);
    add(pair(`${num(l.quantity, Number(l.quantity) % 1 ? 3 : 0)} x ${num(l.unitPrice)}${Number(l.discountPct) ? ` -${num(l.discountPct, 0)}%` : ''}`, num(l.net)));
  }
  rule();

  // Desglose por alícuota (las líneas exentas aparte)
  const byRate = new Map<string, { base: number; tax: number }>();
  for (const l of d.lines) { if (l.exempt) continue; const g = byRate.get(l.taxRate) ?? { base: 0, tax: 0 }; g.base += Number(l.net); g.tax += Number(l.net) * Number(l.taxRate) / 100; byRate.set(l.taxRate, g); }
  if (Number(d.exemptBase) > 0) add(pair('Monto exento', num(d.exemptBase)));
  for (const [rate, g] of [...byRate].sort((a, b) => Number(a[0]) - Number(b[0]))) { add(pair(`Base ${num(rate, 0)}%`, num(g.base))); add(pair(`IVA ${num(rate, 0)}%`, num(g.tax))); }
  add(pair('Subtotal', num(d.subtotal)));
  if (Number(d.igtfAmount) > 0) add(pair(`IGTF ${num(d.igtfPct, 0)}%`, num(d.igtfAmount)));
  add(pair(`TOTAL ${d.currency}`, num(Number(d.total) + Number(d.igtfAmount))), { bold: true, big: true });
  if (!isVes) {
    add(pair('Tasa', num(d.exchangeRate, 4)));
    add(pair('TOTAL Bs', num(Number(d.totalBase) + Number(d.igtfAmount) * Number(d.exchangeRate))), { bold: true });
  }
  if (d.payments.length) {
    rule(); add('Pagos', { bold: true });
    for (const p of d.payments) { add(pair(p.method, `${num(p.amount)} ${p.currency}`)); if (p.reference) add(`  Ref. ${p.reference}`); }
  }
  if (d.notes) { rule(); wrapAdd(`Obs: ${d.notes}`); }
  rule();
  wrapAdd(d.legend, { align: 'center' });
  add('Gracias por su compra', { align: 'center', bold: true });
  L.push({ text: '', feed: true });
  return L;
}

/** Texto plano de 32 columnas (vista previa o impresoras que solo aceptan texto). */
export function receiptText(lines: ReceiptLine[]): string {
  return lines.map(l => {
    const t = l.text.slice(0, COLS);
    return l.align === 'center' ? t.padStart(Math.floor((COLS + t.length) / 2)) : l.align === 'right' ? t.padStart(COLS) : t;
  }).join('\n') + '\n';
}

/** Bytes ESC/POS: ESC @ (reset), alineación, negrita, doble alto (GS ! 0x01) y corte parcial al final. Sin tabla de caracteres: solo ASCII. */
export function receiptEscPos(lines: ReceiptLine[], opts: { cut?: boolean } = {}): Buffer {
  const out: number[] = [0x1b, 0x40];
  const push = (...b: number[]) => out.push(...b);
  let align = -1, bold = false, big = false;
  for (const l of lines) {
    const a = l.align === 'center' ? 1 : l.align === 'right' ? 2 : 0;
    if (a !== align) { push(0x1b, 0x61, a); align = a; }
    const b = !!l.bold; if (b !== bold) { push(0x1b, 0x45, b ? 1 : 0); bold = b; }
    // «big» = doble alto sin doble ancho: se conservan las 32 columnas.
    const g = !!l.big; if (g !== big) { push(0x1d, 0x21, g ? 0x01 : 0x00); big = g; }
    if (l.feed) { push(0x0a, 0x0a, 0x0a); continue; }
    for (const ch of Buffer.from(l.text.slice(0, COLS), 'latin1')) push(ch);
    push(0x0a);
  }
  push(0x1b, 0x61, 0, 0x1b, 0x45, 0, 0x1d, 0x21, 0);
  if (opts.cut !== false) push(0x1d, 0x56, 0x42, 0x00); // la MP58-04 no tiene cortador: se ignora sin efecto
  return Buffer.from(out);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML listo para imprimir en 58 mm desde el navegador (@page 58mm, fuente monoespaciada de 32 columnas). */
export function receiptHtml(lines: ReceiptLine[], title: string): string {
  const body = lines.map(l => l.feed ? '<div class="feed"></div>' : `<div class="l ${l.align ?? 'left'}${l.bold ? ' b' : ''}${l.big ? ' big' : ''}">${esc(l.text) || '&nbsp;'}</div>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>@page{size:58mm auto;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#fff}body{width:58mm;padding:2mm 3mm;color:#000;font:12px/1.25 "Courier New",ui-monospace,monospace}
.l{white-space:pre;overflow:hidden;width:32ch}.center{text-align:center}.right{text-align:right}.b{font-weight:700}.big{font-size:1.25em;line-height:1.1}.feed{height:12mm}
@media screen{body{margin:12px auto;border:1px dashed #98a2b3}}</style></head><body>${body}</body></html>`;
}
