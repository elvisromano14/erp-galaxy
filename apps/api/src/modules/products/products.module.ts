import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../catalogs/exchange-rates';
import { ProductsController } from './products.controller';
import { PriceRecalcScheduler } from './price-recalc.scheduler';
import { ProductsService } from './products.service';

@Module({ imports: [ExchangeRatesModule], controllers: [ProductsController], providers: [ProductsService, PriceRecalcScheduler], exports: [ProductsService] })
export class ProductsModule {}
