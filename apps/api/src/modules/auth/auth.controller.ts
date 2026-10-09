import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { changePasswordSchema, loginSchema, refreshSchema, selectCompanySchema } from '@erp/contracts';
import { AllowNoCompany, AuthUser, CurrentUser, Public } from '../../common/auth/decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { AuthService } from './auth.service';
import { Throttle } from '@nestjs/throttler';
import { env } from '../../config/env';
import { ZBody } from '../../common/http/zod.decorators';

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Throttle({ default: { limit: env.THROTTLE_LOGIN_PER_MIN, ttl: 60_000 } }) @Post('login') @HttpCode(200)
  login(@ZBody(loginSchema) b: { email: string; password: string }, @Req() req: any) {
    return this.auth.login(b.email, b.password, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Post('select-company') @HttpCode(200) @AllowNoCompany()
  selectCompany(@CurrentUser() u: AuthUser, @ZBody(selectCompanySchema) b: { companyId: string }, @Req() req: any) {
    return this.auth.selectCompany(u, b.companyId, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Public() @Throttle({ default: { limit: env.THROTTLE_LOGIN_PER_MIN * 3, ttl: 60_000 } }) @Post('refresh') @HttpCode(200)
  refresh(@ZBody(refreshSchema) b: { refreshToken: string }, @Req() req: any) {
    return this.auth.refresh(b.refreshToken, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @Post('logout') @HttpCode(204) @AllowNoCompany()
  async logout(@CurrentUser() u: AuthUser, @Body() b: { refreshToken?: string }) {
    await this.auth.logout(u, b?.refreshToken);
  }

  @Get('me') @AllowNoCompany()
  me(@CurrentUser() u: AuthUser) { return this.auth.me(u); }

  @Post('change-password') @HttpCode(204) @AllowNoCompany()
  async changePassword(@CurrentUser() u: AuthUser, @ZBody(changePasswordSchema) b: { currentPassword: string; newPassword: string }) {
    await this.auth.changePassword(u, b.currentPassword, b.newPassword);
  }
}
