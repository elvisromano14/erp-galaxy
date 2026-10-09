import { Module } from '@nestjs/common';
import { AlertsController } from './alerts.controller';
import { AlertsService, HousekeepingService } from './alerts.service';

@Module({ controllers: [AlertsController], providers: [AlertsService, HousekeepingService], exports: [HousekeepingService] })
export class AlertsModule {}
