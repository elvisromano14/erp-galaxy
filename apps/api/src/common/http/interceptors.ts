import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { from, lastValueFrom, mergeMap, Observable } from 'rxjs';
import { PrismaService } from '../db/prisma.service';
import { getStore } from '../db/tenant-context';
import { ConflictError } from '../errors/errors';
import { CursorPage, Paged } from './paged';

/** Abre la transacción de la petición con `app.company_id` (RLS) cuando hay empresa activa. */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { companyId } = getStore();
    if (!companyId) return next.handle();
    return from(this.prisma.runWithTenant(companyId, () => lastValueFrom(next.handle(), { defaultValue: undefined })));
  }
}

/** Idempotency-Key en POST (erp-v3 §1): misma clave + mismo cuerpo → misma respuesta; distinto cuerpo → 409. */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}
  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers['idempotency-key'] as string | undefined;
    const { companyId, tx } = getStore();
    if (!key || req.method !== 'POST' || !companyId || !tx) return next.handle();
    const hash = createHash('sha256').update(req.method + req.originalUrl + JSON.stringify(req.body ?? {})).digest('hex');
    const inserted = await tx.$executeRaw`
      INSERT INTO idempotency_keys (company_id, key, request_hash, expires_at)
      VALUES (${companyId}::uuid, ${key}, ${hash}, now() + interval '48 hours')
      ON CONFLICT (company_id, key) DO NOTHING`;
    if (inserted === 0) {
      const row = await tx.idempotencyKey.findUnique({ where: { companyId_key: { companyId, key } } });
      if (!row || row.requestHash !== hash) throw new ConflictError('La Idempotency-Key ya se usó con otra solicitud', 'IDEMPOTENCY_KEY_REUSED');
      const res = ctx.switchToHttp().getResponse();
      res.status(row.responseStatus ?? 200);
      return from([row.responseBody]);
    }
    return next.handle();
  }
}

/** Persiste la respuesta de operaciones idempotentes (después del envoltorio). */
export async function storeIdempotentResponse(prisma: PrismaService, key: string, status: number, body: unknown) {
  const { companyId, tx } = getStore();
  if (!companyId || !tx) return;
  await tx.idempotencyKey.update({
    where: { companyId_key: { companyId, key } },
    data: { responseStatus: status, responseBody: JSON.parse(JSON.stringify(body ?? null)) },
  });
}

/** Envuelve respuestas en { data } / { data, meta } (erp-v3 §11.1) y guarda la respuesta idempotente. */
@Injectable()
export class ResponseWrapInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers['idempotency-key'] as string | undefined;
    return next.handle().pipe(
      mergeMap(async body => {
        let out: unknown;
        if (body instanceof Paged || body instanceof CursorPage) out = { data: body.data, meta: body.meta };
        else if (body === undefined) out = body;
        else if (body && typeof body === 'object' && (body as any).__raw) out = (body as any).value;
        else out = { data: body };
        if (key && req.method === 'POST' && getStore().tx && out !== undefined) {
          const status = ctx.switchToHttp().getResponse().statusCode;
          await storeIdempotentResponse(this.prisma, key, status, out);
        }
        return out;
      }),
    );
  }
}
