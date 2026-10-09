import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PermissionsService } from '../../common/auth/permissions.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard, PermissionsGuard } from '../../common/auth/guards';

@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PermissionsService, JwtAuthGuard, PermissionsGuard],
  exports: [AuthService, PermissionsService, JwtModule],
})
export class AuthModule {}
