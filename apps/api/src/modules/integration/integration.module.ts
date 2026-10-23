import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { IntegrationController, ServiceAccountsController } from './integration.controller';
import { IntegrationEventsModule } from './integration-events.service';
import { IntegrationService } from './integration.service';
import { ServiceAccountsService } from './service-accounts.service';

@Module({
  imports: [IntegrationEventsModule, ProductsModule],
  controllers: [IntegrationController, ServiceAccountsController],
  providers: [IntegrationService, ServiceAccountsService],
})
export class IntegrationModule {}
