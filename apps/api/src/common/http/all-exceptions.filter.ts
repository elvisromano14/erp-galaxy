import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getStore } from '../db/tenant-context';

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT',
  422: 'BUSINESS_RULE_VIOLATION', 429: 'TOO_MANY_REQUESTS',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const req = host.switchToHttp().getRequest();
    const requestId = getStore().requestId ?? req.id;
    const { statusCode, error, message, details } = this.normalize(exception);
    if (statusCode >= 500) this.log.error(`${req.method} ${req.url}: ${(exception as Error)?.stack ?? exception}`);
    res.status(statusCode).json({ statusCode, error, message, details, requestId });
  }

  private normalize(e: unknown): { statusCode: number; error: string; message: string; details: unknown[] } {
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const body = e.getResponse();
      if (typeof body === 'object' && body !== null) {
        const b = body as any;
        return {
          statusCode: status,
          error: typeof b.error === 'string' && b.error === b.error.toUpperCase() ? b.error : STATUS_CODES[status] ?? 'ERROR',
          message: Array.isArray(b.message) ? b.message.join('; ') : b.message ?? e.message,
          details: b.details ?? [],
        };
      }
      return { statusCode: status, error: STATUS_CODES[status] ?? 'ERROR', message: String(body), details: [] };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      switch (e.code) {
        case 'P2002': {
          const target = (e.meta?.target as string[] | string | undefined) ?? [];
          const fields = (Array.isArray(target) ? target : [target]).filter(f => f !== 'company_id');
          return { statusCode: 409, error: 'UNIQUE_VIOLATION', message: `Ya existe un registro con el mismo valor (${fields.join(', ') || 'único'})`, details: fields.map(f => ({ field: f, code: 'DUPLICATE' })) };
        }
        case 'P2003':
          return { statusCode: 409, error: 'FOREIGN_KEY_VIOLATION', message: 'La referencia indicada no existe o el registro está en uso', details: [] };
        case 'P2025':
          return { statusCode: 404, error: 'NOT_FOUND', message: 'Registro no encontrado', details: [] };
        case 'P2034':
          return { statusCode: 409, error: 'SERIALIZATION_CONFLICT', message: 'Conflicto de concurrencia; reintente', details: [] };
        case 'P2010': {
          const code = (e.meta as any)?.code as string | undefined;
          const msg = String((e.meta as any)?.message ?? e.message);
          if (code === '23505') return { statusCode: 409, error: 'UNIQUE_VIOLATION', message: 'Registro duplicado', details: [] };
          if (code === '23514') return { statusCode: 422, error: 'CHECK_VIOLATION', message: 'El dato viola una restricción de integridad', details: [{ code: 'CHECK_VIOLATION', message: msg }] };
          if (code === '23503') return { statusCode: 409, error: 'FOREIGN_KEY_VIOLATION', message: 'Referencia inválida', details: [] };
          if (code === '40P01' || code === '40001') return { statusCode: 409, error: 'SERIALIZATION_CONFLICT', message: 'Conflicto de concurrencia; reintente', details: [] };
          break;
        }
      }
    }
    if (e instanceof Prisma.PrismaClientValidationError) {
      return { statusCode: 400, error: 'VALIDATION_ERROR', message: 'Consulta inválida', details: [] };
    }
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, error: 'INTERNAL_ERROR', message: 'Error interno del servidor', details: [] };
  }
}
