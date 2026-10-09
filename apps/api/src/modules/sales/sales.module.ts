import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ExchangeRatesModule } from '../catalogs/exchange-rates';
import { TreasuryModule } from '../treasury/treasury.module';
import { SalesControllers } from './sales.controller';
import { InvoicingService } from './invoicing.service';
import { SalesService } from './sales.service';

@Module({ imports: [ExchangeRatesModule, TreasuryModule, InventoryModule], controllers: SalesControllers, providers: [SalesService, InvoicingService], exports: [SalesService, InvoicingService] })
export class SalesModule {}
