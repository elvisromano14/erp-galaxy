import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { ConnectionsService } from './connections.service';
import { ConnectionsController, IntegrationController, MonitorController, RuntimeController, ServiceAccountsController } from './integration.controller';
import { IntegrationEventsModule } from './integration-events.service';
import { IntegrationService } from './integration.service';
import { ServiceAccountsService } from './service-accounts.service';

@Module({
  imports: [IntegrationEventsModule, ProductsModule],
  // Las rutas fijas van antes que `:entity/...` para que el enrutador no las confunda con una entidad.
  controllers: [ConnectionsController, MonitorController, RuntimeController, ServiceAccountsController, IntegrationController],
  providers: [IntegrationService, ServiceAccountsService, ConnectionsService],
})
export class IntegrationModule {}
