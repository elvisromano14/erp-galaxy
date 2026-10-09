import { Module } from '@nestjs/common';
import { FiscalController } from './fiscal.controller';
import { WithholdingsService } from './withholdings.service';

@Module({ controllers: [FiscalController], providers: [WithholdingsService], exports: [WithholdingsService] })
export class FiscalModule {}
