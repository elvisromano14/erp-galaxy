import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { D, Decimal } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { BusinessRuleException, NotFoundError } from '../../common/errors/errors';
import { MAX_IMPORT_ROWS, normHeader, parseDecimal, parseImportFile } from '../imports/import-file';
import { TreasuryService } from './treasury.service';

export const statementQuery = z.object({
  mode: z.enum(['validate', 'commit']).default('validate'),
  /** Días de diferencia admitidos entre la fecha del extracto y la del movimiento al emparejar. */
  toleranceDays: z.coerce.number().int().min(0).max(30).default(3),
  /** Fecha y saldo final del extracto (obligatorios al aplicar). */
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  statementBalance: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
  /** Crea movimientos para las líneas del extracto sin pareja (comisiones, intereses, depósitos no registrados). */
  createMissing: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
});
export type StatementQuery = z.infer<typeof statementQuery>;

const ALIAS: Record<string, string[]> = {
  date: ['fecha', 'date', 'fecha_operacion', 'fecha_valor'],
  reference: ['referencia', 'ref', 'nro_referencia', 'numero', 'nro', 'documento'],
  description: ['descripcion', 'concepto', 'detalle', 'movimiento'],
  amount: ['monto', 'importe', 'valor'],
  debit: ['debito', 'debe', 'cargo', 'retiro', 'egreso'],
  credit: ['credito', 'haber', 'abono', 'deposito', 'ingreso'],
};
const pick = (values: Record<string, string>, key: string) => { for (const a of ALIAS[key]) if (values[a] !== undefined && values[a] !== '') return values[a]; return ''; };

/** `AAAA-MM-DD` o `DD/MM/AAAA` (también con guiones) → `AAAA-MM-DD`. */
export function parseStatementDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
const ref = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const dayDiff = (a: string, b: string) => Math.abs(Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000));

interface Line { row: number; date: string; reference: string; description: string; amount: Decimal }

@Injectable()
export class StatementService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly treasury: TreasuryService) {}

  private async parse(file: Express.Multer.File) {
    let parsed;
    try { parsed = await parseImportFile(file.buffer, file.originalname); } catch (e) { throw new BusinessRuleException((e as Error).message, 'INVALID_FILE'); }
    if (!parsed.rows.length) throw new BusinessRuleException('El extracto no tiene filas', 'EMPTY_FILE');
    if (parsed.rows.length > MAX_IMPORT_ROWS) throw new BusinessRuleException(`El extracto tiene ${parsed.rows.length} filas; el máximo es ${MAX_IMPORT_ROWS}`, 'TOO_MANY_ROWS');
    const has = (k: string) => ALIAS[k].some(a => parsed.headers.includes(a));
    if (!has('date') || !(has('amount') || has('debit') || has('credit'))) throw new BusinessRuleException('El extracto necesita columnas de fecha y de monto (monto, o débito/crédito)', 'MISSING_COLUMNS');
    const lines: Line[] = []; const errors: { row: number; error: string }[] = [];
    for (const r of parsed.rows) {
      const date = parseStatementDate(pick(r.values, 'date'));
      if (!date) { errors.push({ row: r.row, error: 'Fecha inválida (use AAAA-MM-DD o DD/MM/AAAA)' }); continue; }
      let amount: Decimal | null = null;
      const single = pick(r.values, 'amount'); const deb = pick(r.values, 'debit'); const cre = pick(r.values, 'credit');
      if (single) { const n = parseDecimal(single); amount = n === null ? null : D(n); }
      else if (deb || cre) {
        const d = deb ? parseDecimal(deb) : '0'; const c = cre ? parseDecimal(cre) : '0';
        amount = d === null || c === null ? null : D(c).minus(D(d).abs());
      }
      if (amount === null || amount.isZero()) { errors.push({ row: r.row, error: 'Monto inválido o cero' }); continue; }
      lines.push({ row: r.row, date, reference: pick(r.values, 'reference'), description: pick(r.values, 'description'), amount });
    }
    return { lines, errors };
  }

  /**
   * Empareja el extracto con los movimientos aún no conciliados de la cuenta (monto exacto, fecha dentro de la tolerancia;
   * prefiere misma referencia y luego la fecha más cercana). `commit` crea las líneas faltantes (opcional) y concilia: el saldo final
   * del extracto debe cuadrar con lo conciliado, o no se guarda nada.
   */
  async run(accountId: string, file: Express.Multer.File | undefined, q: StatementQuery) {
    const tx = this.prisma.tx;
    if (!file) throw new BusinessRuleException('Adjunte el extracto en el campo «file»', 'FILE_REQUIRED');
    const acc = await tx.bankAccount.findFirst({ where: { id: accountId, deletedAt: null } });
    if (!acc) throw new NotFoundError('Cuenta bancaria', accountId);
    const { lines, errors } = await this.parse(file);

    const maxDate = lines.reduce((m, l) => (l.date > m ? l.date : m), '0000-00-00');
    const open = await tx.$queryRaw<{ id: string; movement_date: Date; amount: string; reference: string | null; description: string | null; kind: string }[]>`
      SELECT m.id, m.movement_date, m.amount::text, m.reference, m.description, m.kind FROM bank_movements m
      WHERE m.company_id = ${this.prisma.companyId}::uuid AND m.bank_account_id = ${accountId}::uuid
        AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_items i WHERE i.company_id = m.company_id AND i.movement_id = m.id)
      ORDER BY m.movement_date, m.created_at`;
    const free = new Map(open.map(m => [m.id, { ...m, date: m.movement_date.toISOString().slice(0, 10) }]));
    const matches: { row: number; movementId: string; line: Line }[] = []; const unmatchedLines: Line[] = [];
    for (const l of lines) {
      const cands = [...free.values()].filter(m => D(m.amount).eq(l.amount) && dayDiff(m.date, l.date) <= q.toleranceDays);
      cands.sort((a, b) => (Number(ref(b.reference) !== '' && ref(b.reference) === ref(l.reference)) - Number(ref(a.reference) !== '' && ref(a.reference) === ref(l.reference))) || dayDiff(a.date, l.date) - dayDiff(b.date, l.date));
      const best = cands[0];
      if (best) { matches.push({ row: l.row, movementId: best.id, line: l }); free.delete(best.id); } else unmatchedLines.push(l);
    }
    const unmatchedMovements = [...free.values()].filter(m => m.date <= maxDate);
    const view = {
      account: { id: acc.id, name: acc.name },
      summary: { lines: lines.length, errors: errors.length, matched: matches.length, unmatchedLines: unmatchedLines.length, unmatchedMovements: unmatchedMovements.length },
      errors,
      matches: matches.map(m => ({ row: m.row, date: m.line.date, reference: m.line.reference, description: m.line.description, amount: m.line.amount.toFixed(4), movementId: m.movementId })),
      unmatchedLines: unmatchedLines.map(l => ({ row: l.row, date: l.date, reference: l.reference, description: l.description, amount: l.amount.toFixed(4), suggestedKind: this.kindFor(l) })),
      unmatchedMovements: unmatchedMovements.map(m => ({ id: m.id, date: m.date, kind: m.kind, reference: m.reference, description: m.description, amount: m.amount })),
    };
    if (q.mode === 'validate') return { ...view, committed: false };

    if (errors.length) throw new BusinessRuleException(`El extracto tiene ${errors.length} fila(s) con errores; corrija y reintente`, 'STATEMENT_HAS_ERRORS', errors.slice(0, 20).map(e => ({ field: `fila ${e.row}`, code: 'ROW_ERROR', message: e.error })));
    if (!q.statementDate || q.statementBalance === undefined) throw new BusinessRuleException('Indique la fecha y el saldo final del extracto (statementDate, statementBalance)', 'STATEMENT_BALANCE_REQUIRED');
    if (unmatchedLines.length && !q.createMissing) {
      throw new BusinessRuleException(`${unmatchedLines.length} línea(s) del extracto no tienen movimiento en el libro. Revíselas o use createMissing=true para registrarlas`, 'UNMATCHED_LINES', unmatchedLines.slice(0, 20).map(l => ({ field: `fila ${l.row}`, code: 'UNMATCHED', message: `${l.date} ${l.amount.toFixed(2)} ${l.description}` })));
    }
    const ids = matches.map(m => m.movementId);
    let created = 0;
    for (const l of unmatchedLines) {
      const m = await this.treasury.addMovement({ bankAccountId: accountId, date: new Date(l.date), kind: this.kindFor(l), amount: l.amount, reference: l.reference || null, description: l.description || 'Según extracto bancario', sourceType: 'BANK_STATEMENT', force: true });
      ids.push(m.id); created++;
    }
    if (!ids.length) throw new BusinessRuleException('No hay movimientos que conciliar', 'NOTHING_TO_RECONCILE');
    const rec = await this.treasury.reconcile({ bankAccountId: accountId, statementDate: q.statementDate, statementBalance: q.statementBalance, movementIds: ids, notes: `Extracto importado: ${file.originalname}` });
    await this.audit.log('bank_statement', accountId, 'IMPORT', { file: file.originalname, matched: matches.length, created });
    return { ...view, committed: true, reconciliationId: rec.id, created, reconciled: ids.length };
  }

  /** Tipo del movimiento a crear para una línea sin pareja. */
  private kindFor(l: Line): 'DEPOSIT' | 'WITHDRAWAL' | 'FEE' {
    if (l.amount.gt(0)) return 'DEPOSIT';
    return /comisi|mantenim|cargo por|fee|iva banc|itf|impuesto/i.test(l.description) ? 'FEE' : 'WITHDRAWAL';
  }
}
