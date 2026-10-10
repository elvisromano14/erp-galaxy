import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { env } from './config/env';

// Prisma devuelve BigInt (seq del kardex); JSON no lo soporta de forma nativa.
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

export function setupApp(app: INestApplication, opts: { swagger?: boolean } = {}) {
  (app as any).set('query parser', 'extended');
  (app as any).set('trust proxy', env.TRUST_PROXY_HOPS);
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.useLogger(app.get(Logger));
  if (opts.swagger) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Mini ERP API').setVersion('0.1').addBearerAuth().build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
  }
  return app;
}
