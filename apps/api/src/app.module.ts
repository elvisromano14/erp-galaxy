import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { env } from './config/env';
import { DbModule } from './common/db/db.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard, PermissionsGuard } from './common/auth/guards';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { IdempotencyInterceptor, ResponseWrapInterceptor, TenantInterceptor } from './common/http/interceptors';
import { RequestContextMiddleware } from './common/http/request-context.middleware';
import { HealthModule } from './modules/health/health.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { CatalogsModule } from './modules/catalogs/catalogs.module';
import { ProductsModule } from './modules/products/products.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { PurchasesModule } from './modules/purchases/purchases.module';
import { SequencesModule } from './modules/sequences/sequences.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        genReqId: (req: any) => req.id,
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        autoLogging: { ignore: (req: any) => req.url?.includes('/health') },
        transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: env.THROTTLE_DEFAULT_PER_MIN }]),
    DbModule, OrganizationsModule, AuthModule, HealthModule, CompaniesModule, CatalogsModule, ProductsModule, InventoryModule, PurchasesModule, SequencesModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Orden: Tenant (abre transacción) → Idempotency → Wrap (guarda respuesta idempotente dentro de la transacción)
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseWrapInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
