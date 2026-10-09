/**
 * Exporta la especificación OpenAPI de la API a `packages/api-client/openapi.json` (con operationId legibles y orden estable).
 * Requiere la infraestructura de desarrollo (PostgreSQL/Redis) porque levanta la aplicación sin escuchar en ningún puerto.
 *   pnpm --filter @erp/api openapi:export && pnpm --filter @erp/api-client generate
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';

const slug = (p: string) => p.replace(/^\/api\/v1\//, '').replace(/\{(\w+)\}/g, 'by_$1').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Mini ERP API').setVersion('0.1').addBearerAuth().build());
  const paths: Record<string, any> = {};
  for (const p of Object.keys(doc.paths).sort()) {
    paths[p] = {};
    for (const [method, op] of Object.entries(doc.paths[p] as Record<string, any>)) {
      paths[p][method] = { ...op, operationId: `${method}_${slug(p)}` };
    }
  }
  const out = path.resolve(__dirname, '../../../packages/api-client/openapi.json');
  writeFileSync(out, JSON.stringify({ ...doc, paths }, null, 2) + '\n');
  console.log(`OpenAPI exportado: ${Object.keys(paths).length} rutas → ${out}`);
  await app.close();
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
