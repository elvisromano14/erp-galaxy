import ExcelJS from 'exceljs';

export interface ParsedFile { headers: string[]; rows: { row: number; values: Record<string, string> }[] }

export const MAX_IMPORT_ROWS = 5000;

/** minúsculas, sin acentos, espacios → guion bajo: «Código de barras» → «codigo_de_barras». */
export const normHeader = (h: string) =>
  h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue); // fórmula
    if ('richText' in o) return (o.richText as { text: string }[]).map(t => t.text).join('');
    if ('text' in o) return String(o.text); // hipervínculo
    if ('error' in o) return '';
  }
  return String(v).trim();
}

/** CSV (RFC 4180) con detección de separador (; o ,) y BOM. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const firstLine = t.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let cur: string[] = []; let field = ''; let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQ) {
      if (ch === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { cur.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; cur.push(field); field = ''; rows.push(cur); cur = []; }
    else field += ch;
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

export async function parseImportFile(buf: Buffer, filename: string): Promise<ParsedFile> {
  let table: string[][];
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('Datos') ?? wb.worksheets[0];
    if (!ws) throw new Error('El archivo no tiene hojas');
    table = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(row.getCell(c).value));
      table[n - 1] = vals;
    });
    for (let i = 0; i < table.length; i++) table[i] = table[i] ?? [];
  } else if (/\.csv$/i.test(filename) || /\.txt$/i.test(filename)) {
    table = parseCsv(buf.toString('utf8'));
  } else throw new Error('Formato no soportado: use .xlsx o .csv');

  const headerIdx = table.findIndex(r => r.some(c => c.trim() !== ''));
  if (headerIdx < 0) throw new Error('El archivo está vacío');
  const headers = table[headerIdx].map(normHeader);
  const rows: ParsedFile['rows'] = [];
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    if (!r.some(c => c.trim() !== '')) continue; // fila vacía
    const values: Record<string, string> = {};
    headers.forEach((h, c) => { if (h) values[h] = (r[c] ?? '').trim(); });
    rows.push({ row: i + 1, values });
  }
  return { headers, rows };
}

// ───────── conversión de valores ─────────
/** Decimal tolerante: «1.234,56» y «1,234.56» → «1234.56». Devuelve null si no es número. */
export function parseDecimal(s: string): string | null {
  let t = s.replace(/\s|[$€]|Bs\.?/gi, '');
  if (!t) return null;
  const lastC = t.lastIndexOf(','), lastD = t.lastIndexOf('.');
  if (lastC >= 0 && lastD >= 0) t = lastC > lastD ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (lastC >= 0) t = t.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null;
}

export function parseBool(s: string, dflt: boolean): boolean | null {
  const t = normHeader(s);
  if (!t) return dflt;
  if (['si', 's', '1', 'true', 'x', 'yes', 'y', 'verdadero'].includes(t)) return true;
  if (['no', 'n', '0', 'false', 'falso'].includes(t)) return false;
  return null;
}

export function splitList(s: string): string[] {
  return [...new Set(s.split(/[;,|\n]+/).map(x => x.trim()).filter(Boolean))];
}
