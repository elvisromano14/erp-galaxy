import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../catalogs/exchange-rates';
import { CountSheetController, DocControllers, InventoryQueriesController, ProductInventoryController } from './inventory.controller';
import { InventoryDocsService } from './inventory-docs.service';
import { InventoryQueriesService } from './inventory-queries.service';
import { PostingService } from './posting.service';

@Module({
  imports: [ExchangeRatesModule],
  controllers: [...DocControllers, CountSheetController, InventoryQueriesController, ProductInventoryController],
  providers: [PostingService, InventoryDocsService, InventoryQueriesService],
  exports: [PostingService, InventoryQueriesService, InventoryDocsService],
})
export class InventoryModule {}
