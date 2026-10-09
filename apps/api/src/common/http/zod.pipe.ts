import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { ZodTypeAny } from 'zod';
import { ValidationError } from '../errors/errors';

export class ZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown, _meta: ArgumentMetadata): ReturnType<T['parse']> {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new ValidationError(
        'Datos inválidos',
        r.error.issues.map(i => ({ field: i.path.join('.'), code: i.code.toUpperCase(), message: i.message })),
      );
    }
    return r.data;
  }
}
