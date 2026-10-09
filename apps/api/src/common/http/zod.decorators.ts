import { Body, Query } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { ZodTypeAny } from 'zod';
import { zodToOpenAPI } from 'nestjs-zod';
import { ZodPipe } from './zod.pipe';

/** Cuerpo validado con Zod y documentado en Swagger a partir del mismo esquema. */
export function ZBody(schema: ZodTypeAny): ParameterDecorator {
  return (target, key, index) => {
    Body(new ZodPipe(schema))(target, key as string, index);
    const desc = Object.getOwnPropertyDescriptor(target, key as string);
    if (desc) {
      try { ApiBody({ schema: zodToOpenAPI(schema) as any })(target, key as string, desc); } catch { /* esquema no representable */ }
    }
  };
}

/** Query validada con Zod; cada campo del esquema aparece como parámetro en Swagger. */
export function ZQuery(schema: ZodTypeAny): ParameterDecorator {
  return (target, key, index) => {
    Query(new ZodPipe(schema))(target, key as string, index);
    const desc = Object.getOwnPropertyDescriptor(target, key as string);
    let shape: Record<string, ZodTypeAny> = {};
    let s: any = schema;
    while (s && !s.shape && s._def) s = s._def.schema ?? s._def.innerType;
    if (s?.shape) shape = s.shape;
    if (desc) {
      for (const [name, field] of Object.entries(shape)) {
        try { ApiQuery({ name, required: false, schema: zodToOpenAPI(field) as any })(target, key as string, desc); } catch { /* ignorar */ }
      }
    }
  };
}
