import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../db/redis.service';
import { getStore } from '../db/tenant-context';
import { AuthUser, IS_PUBLIC, NO_COMPANY, PERMISSIONS } from './decorators';
import { PermissionsService } from './permissions.service';
import { env } from '../../config/env';

export interface AccessClaims { sub: string; companyId?: string; jti: string; exp: number; sa?: boolean }

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService, private readonly redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException({ error: 'UNAUTHORIZED', message: 'Falta el token de acceso' });
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(header.slice(7), { secret: env.JWT_ACCESS_SECRET, algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException({ error: 'TOKEN_INVALID', message: 'Token inválido o expirado' });
    }
    if (await this.redis.client.exists(`bl:${claims.jti}`)) {
      throw new UnauthorizedException({ error: 'TOKEN_REVOKED', message: 'Token revocado' });
    }
    const user: AuthUser = { userId: claims.sub, companyId: claims.companyId, jti: claims.jti, exp: claims.exp, isSuperAdmin: !!claims.sa };
    req.user = user;
    const store = getStore();
    store.userId = user.userId;
    store.companyId = user.companyId;
    if (!user.companyId && !this.reflector.getAllAndOverride<boolean>(NO_COMPANY, targets)) {
      throw new ForbiddenException({ error: 'COMPANY_REQUIRED', message: 'Seleccione una empresa (POST /auth/select-company)' });
    }
    return true;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly perms: PermissionsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user?.companyId) throw new ForbiddenException({ error: 'COMPANY_REQUIRED', message: 'Seleccione una empresa' });
    if (user.isSuperAdmin) return true;
    const have = new Set(await this.perms.forUser(user.userId, user.companyId));
    const missing = required.filter(p => !have.has(p));
    if (missing.length) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'No tiene permiso para esta acción', details: missing.map(m => ({ code: 'MISSING_PERMISSION', message: m })) });
    return true;
  }
}
