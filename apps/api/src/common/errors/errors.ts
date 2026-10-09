import { HttpException, HttpStatus } from '@nestjs/common';

export interface ErrorDetail { field?: string; code: string; message?: string }

/** Violación de regla de negocio → 422 (erp-v3 §11.1). */
export class BusinessRuleException extends HttpException {
  constructor(message: string, public readonly code = 'BUSINESS_RULE_VIOLATION', public readonly details: ErrorDetail[] = []) {
    super({ error: code, message, details }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export class NotFoundError extends HttpException {
  constructor(entity: string, id?: string) {
    super({ error: 'NOT_FOUND', message: id ? `${entity} ${id} no encontrado` : `${entity} no encontrado`, details: [] }, HttpStatus.NOT_FOUND);
  }
}

export class ConflictError extends HttpException {
  constructor(message: string, code = 'CONFLICT', details: ErrorDetail[] = []) {
    super({ error: code, message, details }, HttpStatus.CONFLICT);
  }
}

export class ValidationError extends HttpException {
  constructor(message: string, details: ErrorDetail[] = []) {
    super({ error: 'VALIDATION_ERROR', message, details }, HttpStatus.BAD_REQUEST);
  }
}
