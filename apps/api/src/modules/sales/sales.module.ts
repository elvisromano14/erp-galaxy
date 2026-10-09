import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../catalogs/exchange-rates';
import { TreasuryModule } from '../treasury/treasury.module';
import { SalesControllers } from './sales.controller';
import { SalesService } from './sales.service';

@Module({ imports: [ExchangeRatesModule, TreasuryModule], controllers: SalesControllers, providers: [SalesService], exports: [SalesService] })
export class SalesModule {}
