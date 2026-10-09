import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../catalogs/exchange-rates';
import { TreasuryController } from './treasury.controller';
import { ReceivablesService } from './receivables.service';
import { TreasuryService } from './treasury.service';

@Module({ imports: [ExchangeRatesModule], controllers: [TreasuryController], providers: [TreasuryService, ReceivablesService], exports: [TreasuryService, ReceivablesService] })
export class TreasuryModule {}
