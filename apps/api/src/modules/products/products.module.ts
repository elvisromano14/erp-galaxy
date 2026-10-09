import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../catalogs/exchange-rates';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({ imports: [ExchangeRatesModule], controllers: [ProductsController], providers: [ProductsService], exports: [ProductsService] })
export class ProductsModule {}
