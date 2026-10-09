import { Body, Controller, Get, Injectable, Module, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { DEFAULT_PREFIX } from '../../common/db/sequence.service';
import { RequirePermissions } from '../../common/auth/decorators';
import { BusinessRuleException } from '../../common/errors/errors';
import { ZBody } from '../../common/http/zod.decorators';

const upsertSchema = z.object({
  docType: z.string().min(2).max(60),
  series: z.string().min(1).max(5).default('A'),
  prefix: z.string().regex(/^[A-Za-z0-9\-_.]{0,12}$/, 'Hasta 12 caracteres: letras, números, - _ .').optional(),
  padding: z.number().int().min(1).max(12).optional(),
  /** Próximo número a emitir. Solo puede aumentar (reducirlo causaría duplicados). */
  nextNumber: z.union([z.string().regex(/^\d+$/), z.number().int().min(1)]).transform(String).optional(),
});

@Injectable()
export class SequencesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Todas las numeraciones conocidas: las existentes más las predeterminadas aún no usadas. */
  async list() {
    const rows = await this.prisma.tx.documentSequence.findMany({ orderBy: [{ docType: 'asc' }, { series: 'asc' }] });
    const have = new Set(rows.map(r => `${r.docType}|${r.series}`));
    const out = rows.map(r => ({
      id: r.id, docType: r.docType, series: r.series, prefix: r.prefix, padding: r.padding, nextNumber: r.nextNumber.toString(),
      example: `${r.prefix}${String(r.nextNumber).padStart(r.padding, '0')}`, isDefault: false,
    }));
    for (const [docType, prefix] of Object.entries(DEFAULT_PREFIX)) {
      if (have.has(`${docType}|A`)) continue;
      out.push({ id: null as unknown as string, docType, series: 'A', prefix, padding: 6, nextNumber: '1', example: `${prefix}${String(1).padStart(6, '0')}`, isDefault: true });
    }
    return out.sort((a, b) => a.docType.localeCompare(b.docType));
  }

  async upsert(b: z.infer<typeof upsertSchema>) {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    if (!(b.docType in DEFAULT_PREFIX)) throw new BusinessRuleException('Tipo de documento desconocido', 'UNKNOWN_DOC_TYPE', [{ field: 'docType', code: 'UNKNOWN' }]);
    await tx.$executeRaw`
      INSERT INTO document_sequences (company_id, doc_type, series, prefix, next_number, padding)
      VALUES (${companyId}::uuid, ${b.docType}, ${b.series}, ${DEFAULT_PREFIX[b.docType] ?? ''}, 1, 6)
      ON CONFLICT (company_id, doc_type, series) DO NOTHING`;
    // Bloqueo de la fila: serializa con las confirmaciones de documentos que están numerando.
    const [cur] = await tx.$queryRaw<{ id: string; next_number: bigint }[]>`
      SELECT id, next_number FROM document_sequences WHERE company_id = ${companyId}::uuid AND doc_type = ${b.docType} AND series = ${b.series} FOR UPDATE`;
    if (b.nextNumber !== undefined && BigInt(b.nextNumber) < cur.next_number) {
      throw new BusinessRuleException(`El próximo número no puede ser menor al actual (${cur.next_number}); evitaría duplicados`, 'SEQUENCE_CANNOT_DECREASE', [{ field: 'nextNumber', code: 'CANNOT_DECREASE' }]);
    }
    const row = await tx.documentSequence.update({
      where: { id: cur.id },
      data: { ...(b.prefix !== undefined ? { prefix: b.prefix } : {}), ...(b.padding !== undefined ? { padding: b.padding } : {}), ...(b.nextNumber !== undefined ? { nextNumber: BigInt(b.nextNumber) } : {}) },
    });
    await this.audit.log('document_sequence', row.id, 'UPDATE', { ...b, nextNumber: b.nextNumber });
    return { id: row.id, docType: row.docType, series: row.series, prefix: row.prefix, padding: row.padding, nextNumber: row.nextNumber.toString(), example: `${row.prefix}${String(row.nextNumber).padStart(row.padding, '0')}`, isDefault: false };
  }
}

@ApiTags('document-sequences') @ApiBearerAuth()
@Controller('document-sequences')
export class SequencesController {
  constructor(private readonly svc: SequencesService) {}
  @Get() @RequirePermissions('admin:sequences:read')
  list() { return this.svc.list(); }
  @Put() @RequirePermissions('admin:sequences:update')
  upsert(@ZBody(upsertSchema) b: z.infer<typeof upsertSchema>) { return this.svc.upsert(b); }
}

@Module({ controllers: [SequencesController], providers: [SequencesService] })
export class SequencesModule {}
