import { Module } from '@nestjs/common';
import { ExchangeRatesModule } from '../catalogs/exchange-rates';
import { StatementService } from './statement.service';
import { TreasuryController } from './treasury.controller';
import { PayablesService } from './payables.service';
import { ReceivablesService } from './receivables.service';
import { TreasuryService } from './treasury.service';

@Module({ imports: [ExchangeRatesModule], controllers: [TreasuryController], providers: [TreasuryService, ReceivablesService, PayablesService, StatementService], exports: [TreasuryService, ReceivablesService, PayablesService] })
export class TreasuryModule {}
