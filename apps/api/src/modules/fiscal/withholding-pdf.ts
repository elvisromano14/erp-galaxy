import { renderPdf } from '../reports/report-export';

export interface WithholdingPdfData {
  number: string; kind: 'IVA' | 'ISLR'; direction: 'ISSUED' | 'RECEIVED'; externalNumber?: string | null; voucherDate: string; period: string; status: string;
  agent: { rif: string; legalName: string; address?: string | null };
  subject: { rif: string; legalName: string; address?: string | null };
  document: { kind: string; number: string; date: string; ref?: string | null };
  concept?: string | null; baseBs: string; percentage: string; amountBs: string; legend: string;
}
const n = (v: string | number) => Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/** Comprobante de retención (agente = quien retiene; sujeto = a quien se le retiene). */
export function withholdingPdf(d: WithholdingPdfData): Promise<Buffer> {
  const grey = '#667085';
  const title = d.kind === 'IVA' ? 'COMPROBANTE DE RETENCIÓN DEL IMPUESTO AL VALOR AGREGADO' : 'COMPROBANTE DE RETENCIÓN DE IMPUESTO SOBRE LA RENTA';
  const party = (label: string, p: { rif: string; legalName: string; address?: string | null }) => [
    { text: label, bold: true, color: grey, margin: [0, 6, 0, 1] }, { text: p.legalName, bold: true }, { text: `RIF: ${p.rif}` }, ...(p.address ? [{ text: p.address, color: grey }] : []),
  ];
  return renderPdf({
    pageSize: 'A4', pageMargins: [40, 40, 40, 50], defaultStyle: { font: 'Roboto', fontSize: 9 }, info: { title: `${d.number}`, author: d.agent.legalName },
    footer: { text: d.legend, alignment: 'center', color: grey, fontSize: 7, margin: [0, 14, 0, 0] },
    content: [
      { text: title, bold: true, fontSize: 12, alignment: 'center' },
      { columns: [{ text: `N° de comprobante: ${d.number}${d.externalNumber ? ` (del cliente: ${d.externalNumber})` : ''}`, bold: true }, { text: `Fecha: ${day(d.voucherDate)}  ·  Período fiscal: ${d.period}`, alignment: 'right' }], margin: [0, 10, 0, 0] },
      ...(d.status === 'CANCELLED' ? [{ text: 'ANULADO', color: '#d92d20', bold: true, fontSize: 14, alignment: 'center', margin: [0, 6, 0, 0] }] : []),
      { columns: [{ stack: party('AGENTE DE RETENCIÓN', d.agent) }, { stack: party('SUJETO RETENIDO', d.subject) }], margin: [0, 6, 0, 10] },
      { table: { headerRows: 1, widths: ['auto', 'auto', 'auto', '*', 'auto', 'auto', 'auto'], body: [
        ['Documento', 'N°', 'Fecha', 'Concepto', 'Base Bs', '% Ret.', 'Retenido Bs'].map((h, i) => ({ text: h, bold: true, color: '#ffffff', fillColor: '#465fff', alignment: i >= 4 ? 'right' : 'left' })),
        [d.document.kind, d.document.number + (d.document.ref ? ` / ${d.document.ref}` : ''), day(d.document.date), d.concept ?? (d.kind === 'IVA' ? 'Impuesto al valor agregado' : ''), { text: n(d.baseBs), alignment: 'right' }, { text: n(d.percentage), alignment: 'right' }, { text: n(d.amountBs), alignment: 'right', bold: true }],
      ] }, layout: { hLineColor: () => '#e4e7ec', vLineColor: () => '#ffffff', hLineWidth: () => 0.5, vLineWidth: () => 0, paddingTop: () => 4, paddingBottom: () => 4 } },
      { text: `Total retenido: Bs ${n(d.amountBs)}`, bold: true, alignment: 'right', margin: [0, 10, 0, 0], fontSize: 11 },
    ],
  });
}
