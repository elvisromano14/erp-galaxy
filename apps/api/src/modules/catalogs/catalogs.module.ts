import { Module, Type } from '@nestjs/common';
import { CATALOGS } from './catalogs.config';
import { makeCrud } from './crud.factory';
import { ExchangeRatesModule } from './exchange-rates';

const controllers: Type<unknown>[] = CATALOGS.map(c => makeCrud(c));
const services = controllers.map(c => (c as any).__service as Type<unknown>);

@Module({ imports: [ExchangeRatesModule], controllers, providers: services })
export class CatalogsModule {}
