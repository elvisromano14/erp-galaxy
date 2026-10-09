import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';

/**
 * Proceso aparte para las colas de BullMQ (reportes en segundo plano, tareas periódicas), sin servidor HTTP.
 * Úselo con `WORKER_ENABLED=false` en la API para que solo este proceso procese; o deje la API con `WORKER_ENABLED=true` y no lo use.
 */
async function bootstrap() {
  if (!env.WORKER_ENABLED) throw new Error('Defina WORKER_ENABLED=true para ejecutar el worker');
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  // eslint-disable-next-line no-console
  console.log(`Worker de colas activo (prefijo ${env.QUEUE_PREFIX})`);
}
bootstrap();
