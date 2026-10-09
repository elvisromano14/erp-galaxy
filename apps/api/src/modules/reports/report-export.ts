import ExcelJS from 'exceljs';
import path from 'node:path';

export type ColType = 'text' | 'int' | 'qty' | 'money' | 'cost' | 'pct' | 'date' | 'datetime' | 'bool';
export interface ReportColumn { key: string; header: string; type: ColType }
export interface ReportOutput {
  title: string; companyName: string; companyRif: string; generatedAt: Date;
  filtersText: string[]; columns: ReportColumn[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown>;
}

const NUM_FMT: Partial<Record<ColType, string>> = { int: '#,##0', qty: '#,##0.####', money: '#,##0.00', cost: '#,##0.000000', pct: '0.00"%"' };
const isNum = (t: ColType) => t === 'int' || t === 'qty' || t === 'money' || t === 'cost' || t === 'pct';

/** Texto a mostrar (es-VE) para PDF/CSV; los números llegan como cadenas decimales exactas. */
export function formatCell(v: unknown, t: ColType): string {
  if (v === null || v === undefined || v === '') return '';
  switch (t) {
    case 'bool': return v ? 'Sí' : 'No';
    case 'date': return v instanceof Date ? v.toISOString().slice(0, 10).split('-').reverse().join('/') : String(v).slice(0, 10).split('-').reverse().join('/');
    case 'datetime': return new Date(v as string).toLocaleString('es-VE', { timeZone: 'America/Caracas' });
    case 'int': case 'qty': case 'money': case 'cost': case 'pct': {
      const n = Number(v);
      if (Number.isNaN(n)) return String(v);
      const dp = t === 'money' ? 2 : t === 'cost' ? 6 : t === 'pct' ? 2 : t === 'int' ? 0 : 4;
      return new Intl.NumberFormat('es-VE', { minimumFractionDigits: t === 'qty' ? 0 : dp, maximumFractionDigits: dp }).format(n);
    }
    default: return String(v);
  }
}

// ───────── CSV (UTF-8 con BOM; separador ';' por defecto: es el de Excel en español) ─────────
export function toCsv(o: ReportOutput, delimiter = ';'): Buffer {
  const esc = (s: string) => (/[";\n\r,]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s);
  // Los números se exportan en crudo (punto decimal, sin separador de miles) para que sean reutilizables.
  const raw = (v: unknown, t: ColType) => (v === null || v === undefined ? '' : isNum(t) ? String(v) : t === 'date' ? String(v).slice(0, 10) : t === 'bool' ? (v ? 'SI' : 'NO') : String(v));
  const lines = [o.columns.map(c => esc(c.header)).join(delimiter)];
  for (const r of o.rows) lines.push(o.columns.map(c => esc(raw(r[c.key], c.type))).join(delimiter));
  if (o.totals) lines.push(o.columns.map((c, i) => esc(i === 0 && o.totals![c.key] === undefined ? 'TOTAL' : raw(o.totals![c.key], c.type))).join(delimiter));
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

// ───────── XLSX ─────────
export async function toXlsx(o: ReportOutput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mini ERP'; wb.created = o.generatedAt;
  const ws = wb.addWorksheet('Reporte', { views: [{ state: 'frozen', ySplit: 4 + o.filtersText.length }] });
  const nCols = Math.max(o.columns.length, 1);
  const titleRow = (text: string, bold = false, size = 11) => {
    const r = ws.addRow([text]); r.font = { bold, size };
    ws.mergeCells(r.number, 1, r.number, nCols);
  };
  titleRow(`${o.companyName} (${o.companyRif})`, true, 12);
  titleRow(o.title, true, 14);
  titleRow(`Generado: ${o.generatedAt.toLocaleString('es-VE', { timeZone: 'America/Caracas' })}`);
  for (const f of o.filtersText) titleRow(f);
  ws.addRow([]);
  const head = ws.addRow(o.columns.map(c => c.header));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF465FFF' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  const toCell = (v: unknown, t: ColType): ExcelJS.CellValue => {
    if (v === null || v === undefined || v === '') return null;
    if (isNum(t)) { const n = Number(v); return Number.isNaN(n) ? String(v) : n; }
    if (t === 'date') { const s = v instanceof Date ? v.toISOString() : String(v); return new Date(s.slice(0, 10) + 'T00:00:00Z'); }
    if (t === 'datetime') return new Date(v as string);
    if (t === 'bool') return v ? 'Sí' : 'No';
    return String(v);
  };
  for (const r of o.rows) ws.addRow(o.columns.map(c => toCell(r[c.key], c.type)));
  if (o.totals) {
    const tr = ws.addRow(o.columns.map((c, i) => (o.totals![c.key] !== undefined ? toCell(o.totals![c.key], c.type) : i === 0 ? 'TOTAL' : null)));
    tr.font = { bold: true }; tr.border = { top: { style: 'thin' } };
  }
  o.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (NUM_FMT[c.type]) { col.numFmt = NUM_FMT[c.type]!; col.alignment = { horizontal: 'right' }; }
    if (c.type === 'date') col.numFmt = 'dd/mm/yyyy';
    if (c.type === 'datetime') col.numFmt = 'dd/mm/yyyy hh:mm';
    const maxLen = Math.max(c.header.length, ...o.rows.slice(0, 200).map(r => formatCell(r[c.key], c.type).length));
    col.width = Math.min(Math.max(maxLen + 2, 10), 60);
  });
  // El encabezado de la tabla (no los títulos) tiene autofiltro.
  ws.autoFilter = { from: { row: head.number, column: 1 }, to: { row: head.number, column: nCols } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────── PDF (pdfmake) ─────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfmake = require('pdfmake');
const fontDir = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
pdfmake.setFonts({ Roboto: { normal: path.join(fontDir, 'Roboto-Regular.ttf'), bold: path.join(fontDir, 'Roboto-Medium.ttf'), italics: path.join(fontDir, 'Roboto-Italic.ttf'), bolditalics: path.join(fontDir, 'Roboto-MediumItalic.ttf') } });
pdfmake.setUrlAccessPolicy(() => false); // sin descargas externas desde el PDF

export const PDF_MAX_ROWS = 5000;

export async function toPdf(o: ReportOutput): Promise<Buffer> {
  const landscape = o.columns.length > 6;
  const small = o.columns.length > 9;
  const fontSize = small ? 6.5 : o.columns.length > 6 ? 7.5 : 9;
  const rows = o.rows.slice(0, PDF_MAX_ROWS);
  const align = (t: ColType) => (isNum(t) ? 'right' : 'left');
  const body: unknown[][] = [
    o.columns.map(c => ({ text: c.header, bold: true, color: '#ffffff', fillColor: '#465fff', alignment: align(c.type) })),
    ...rows.map(r => o.columns.map(c => ({ text: formatCell(r[c.key], c.type), alignment: align(c.type) }))),
  ];
  if (o.totals) body.push(o.columns.map((c, i) => ({ text: o.totals![c.key] !== undefined ? formatCell(o.totals![c.key], c.type) : i === 0 ? 'TOTAL' : '', bold: true, alignment: align(c.type), fillColor: '#f2f4f7' })));
  const doc = {
    pageSize: 'A4', pageOrientation: landscape ? 'landscape' : 'portrait', pageMargins: [28, 40, 28, 36],
    defaultStyle: { font: 'Roboto', fontSize },
    info: { title: o.title, author: 'Mini ERP' },
    header: { columns: [{ text: `${o.companyName} · ${o.companyRif}`, bold: true, margin: [28, 14, 0, 0] }, { text: o.generatedAt.toLocaleString('es-VE', { timeZone: 'America/Caracas' }), alignment: 'right', margin: [0, 14, 28, 0], color: '#667085' }] },
    footer: (page: number, pages: number) => ({ text: `Página ${page} de ${pages}`, alignment: 'center', color: '#667085', fontSize: 8, margin: [0, 10, 0, 0] }),
    content: [
      { text: o.title, fontSize: 14, bold: true, margin: [0, 0, 0, 4] },
      ...(o.filtersText.length ? [{ text: o.filtersText.join('  ·  '), color: '#667085', fontSize: 8, margin: [0, 0, 0, 8] }] : []),
      { table: { headerRows: 1, widths: o.columns.map(c => (isNum(c.type) || c.type === 'date' || c.type === 'datetime' || c.type === 'bool' ? 'auto' : '*')), body }, layout: { hLineColor: () => '#e4e7ec', vLineColor: () => '#ffffff', hLineWidth: () => 0.5, vLineWidth: () => 0, paddingTop: () => 2, paddingBottom: () => 2 } },
      ...(o.rows.length > PDF_MAX_ROWS ? [{ text: `Se muestran las primeras ${PDF_MAX_ROWS} filas de ${o.rows.length}. Exporte a Excel para el detalle completo.`, color: '#b54708', margin: [0, 8, 0, 0] }] : []),
    ],
  };
  return pdfmake.createPdf(doc).getBuffer();
}

/** Renderiza una definición pdfmake con las fuentes y la política de URLs de este módulo. */
export const renderPdf = (definition: unknown): Promise<Buffer> => pdfmake.createPdf(definition).getBuffer();
