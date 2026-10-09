import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export const DEFAULT_PREFIX: Record<string, string> = {
  PURCHASE_QUOTE: 'COT-C-', PURCHASE_ORDER: 'OC-', PURCHASE_DELIVERY_NOTE: 'NE-', PURCHASE_DELIVERY_NOTE_RETURN: 'DNE-',
  PURCHASE: 'COMP-', PURCHASE_RETURN: 'DC-',
  SALES_QUOTE: 'COT-V-', SALES_BUDGET: 'PRE-', SALES_ORDER: 'PED-', SALES_INVOICE: 'FAC-', SALES_CREDIT_NOTE: 'NC-', SALES_CONTROL: '00-', SALES_DEBIT_NOTE: 'ND-', WITHHOLDING_IVA: 'RIVA-', WITHHOLDING_ISLR: 'RISLR-', WITHHOLDING_RECEIVED: 'RRET-',
  SUPPLIER_PAYMENT: 'PAGO-', CUSTOMER_RECEIPT: 'REC-',
  INVENTORY_TRANSFER: 'TR-', INVENTORY_CHARGE: 'CAR-', INVENTORY_DISCHARGE: 'DES-', INVENTORY_ADJUSTMENT: 'AJ-', INVENTORY_COST_ADJUSTMENT: 'AC-',
};

@Injectable()
export class SequenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Siguiente correlativo (erp-v3 §7.5). Debe llamarse DENTRO de la transacción de contabilización:
   * el UPDATE bloquea la fila hasta el commit → sin huecos ni duplicados; un rollback no consume número.
   */
  async next(docType: string, series = 'A'): Promise<string> {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    await tx.$executeRaw`
      INSERT INTO document_sequences (company_id, doc_type, series, prefix, next_number, padding)
      VALUES (${companyId}::uuid, ${docType}, ${series}, ${DEFAULT_PREFIX[docType] ?? ''}, 1, 6)
      ON CONFLICT (company_id, doc_type, series) DO NOTHING`;
    const rows = await tx.$queryRaw<{ prefix: string; n: bigint; padding: number }[]>`
      UPDATE document_sequences SET next_number = next_number + 1
      WHERE company_id = ${companyId}::uuid AND doc_type = ${docType} AND series = ${series}
      RETURNING prefix, (next_number - 1) AS n, padding`;
    const { prefix, n, padding } = rows[0];
    return `${prefix}${String(n).padStart(padding, '0')}`;
  }
}
