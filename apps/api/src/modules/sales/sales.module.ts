import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../catalogs/exchange-rates';
import { SalesControllers } from './sales.controller';
import { SalesService } from './sales.service';

@Module({ imports: [ExchangeRatesModule], controllers: SalesControllers, providers: [SalesService], exports: [SalesService] })
export class SalesModule {}
