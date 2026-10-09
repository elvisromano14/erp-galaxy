import { Module } from '@nestjs/common';
import { CompaniesController, PermissionsController, RolesController, UsersController } from './companies.controller';
import { CompaniesService } from './companies.service';

@Module({
  controllers: [CompaniesController, UsersController, RolesController, PermissionsController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
