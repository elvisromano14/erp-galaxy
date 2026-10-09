import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../catalogs/exchange-rates';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchaseControllers } from './purchases.controller';
import { PurchasesService } from './purchases.service';

@Module({ imports: [InventoryModule, ExchangeRatesModule], controllers: PurchaseControllers, providers: [PurchasesService], exports: [PurchasesService] })
export class PurchasesModule {}
