import { renderPdf } from '../reports/report-export';

export interface LabelLine { label: string; value: string }
/** `lines` = datos elegidos por el usuario (además del código); si falta, se usan nombre y marca. */
export interface LabelProduct { sku: string; name: string; brand?: string | null; lines?: LabelLine[] }
export interface LabelOptions { widthMm: number; heightMm: number; copies: number }

const MM = 72 / 25.4;
const mm = (v: number) => Math.round(v * MM * 100) / 100;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Contenido del QR: la PRIMERA línea es el código (SKU) —así lo reconoce el escáner de la app— y debajo van
 * nombre y marca, para que cualquier lector de QR muestre la información del producto. Sin precios (cambian).
 */
export function labelPayload(p: LabelProduct): string {
  if (p.lines) return [p.sku, ...p.lines.map(l => `${l.label}: ${l.value}`)].join('\n');
  return [p.sku, p.name, p.brand ? `Marca: ${p.brand}` : ''].filter(Boolean).join('\n');
}

/** Líneas que se imprimen junto al QR (el código va aparte, en negrita). */
function visibleLines(p: LabelProduct): LabelLine[] {
  return p.lines ?? [{ label: '', value: p.name }, ...(p.brand ? [{ label: '', value: p.brand }] : [])];
}

/** Un PDF con una etiqueta por página, del tamaño exacto del rollo (la impresora imprime a tamaño real). */
export function labelsPdf(products: LabelProduct[], o: LabelOptions): Promise<Buffer> {
  const w = mm(o.widthMm), h = mm(o.heightMm);
  const m = mm(Math.min(1.8, o.widthMm * 0.05));                 // margen
  const qr = Math.min(h - m * 2, w * 0.5);                          // lado del QR
  const textW = w - m * 3 - qr;
  const small = o.heightMm < 25;
  const maxLines = Math.max(2, Math.floor((h - m * 2) / ((small ? 5 : 6) * 1.05 + 1)) - 1);
  const content: unknown[] = [];
  const all = products.flatMap(p => Array.from({ length: o.copies }, () => p));
  all.forEach((p, i) => {
    const last = i === all.length - 1;
    content.push({
      columns: [
        { qr: labelPayload(p), fit: qr, margin: [0, 0, 0, 0], width: qr, eccLevel: 'M' },
        {
          width: textW, margin: [m, 0, 0, 0],
          stack: [
            { text: clip(p.sku, 24), bold: true, fontSize: small ? 6.5 : 8, lineHeight: 1 },
            ...visibleLines(p).slice(0, maxLines).map(l => ({
              text: clip(l.label && l.label !== 'Descripción' && l.label !== 'Nombre' ? `${l.label}: ${l.value}` : l.value, small ? 38 : 70),
              fontSize: small ? 5 : 6, lineHeight: 1.05, margin: [0, 1, 0, 0],
            })),
          ],
        },
      ],
      columnGap: 0,
      ...(last ? {} : { pageBreak: 'after' }),
    });
  });
  return renderPdf({
    pageSize: { width: w, height: h }, pageMargins: [m, m, m, m],
    defaultStyle: { font: 'Roboto' }, info: { title: 'Etiquetas QR de productos' },
    content: content.length ? content : [{ text: ' ' }],
  });
}
