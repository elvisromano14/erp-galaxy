import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';
import { setupApp } from './setup-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  setupApp(app, { swagger: env.NODE_ENV !== 'production' });
  app.enableShutdownHooks();
  await app.listen(env.PORT, env.HOST);
}
bootstrap();
