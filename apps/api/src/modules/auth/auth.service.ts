import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/db/prisma.service';
import { RedisService } from '../../common/db/redis.service';
import { AuditService } from '../../common/audit/audit.service';
import { PermissionsService } from '../../common/auth/permissions.service';
import { AuthUser } from '../../common/auth/decorators';
import { BusinessRuleException, ForbiddenLike } from './auth.errors';
import { env } from '../../config/env';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const ACCESS_TTL_SECONDS = (() => {
  const m = /^(\d+)([smh])$/.exec(env.JWT_ACCESS_TTL);
  if (!m) return 900;
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as 's' | 'm' | 'h'];
})();

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }
interface Ctx { ip?: string; userAgent?: string }

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly perms: PermissionsService,
  ) {}

  // ───────── login ─────────
  async login(email: string, password: string, ctx: Ctx) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const fail = async (reason: string) => {
      await this.audit.log('auth', user?.id, 'LOGIN_FAILED', { email, reason }, { companyId: null, userId: user?.id ?? null });
      throw new UnauthorizedException({ error: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' });
    };
    if (!user || !user.isActive) return fail('unknown_or_inactive');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({ error: 'ACCOUNT_LOCKED', message: 'Cuenta bloqueada temporalmente por intentos fallidos' });
    }
    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      const failed = user.failedLogins + 1;
      const lock = failed >= env.LOGIN_MAX_ATTEMPTS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) : null },
      });
      return fail('bad_password');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });

    const companies = await this.userCompanies(user.id, user.isSuperAdmin);
    await this.audit.log('auth', user.id, 'LOGIN', undefined, { companyId: null, userId: user.id });
    const single = companies.length === 1 ? companies[0] : undefined;
    const tokens = await this.issue(user.id, user.isSuperAdmin, single?.id, ctx);
    return {
      user: { id: user.id, email: user.email, fullName: user.fullName, isSuperAdmin: user.isSuperAdmin },
      companies,
      companyId: single?.id ?? null,
      requiresCompanySelection: !single,
      ...tokens,
    };
  }

  private async userCompanies(userId: string, isSuperAdmin: boolean) {
    const memberships = await this.prisma.userCompany.findMany({ where: { userId, isActive: true } });
    const ids = isSuperAdmin ? undefined : memberships.map(m => m.companyId);
    const companies = await this.prisma.company.findMany({
      where: { isActive: true, ...(ids ? { id: { in: ids } } : {}) },
      select: { id: true, rif: true, legalName: true, tradeName: true },
      orderBy: { legalName: 'asc' },
    });
    return companies;
  }

  // ───────── select-company ─────────
  async selectCompany(user: AuthUser, companyId: string, ctx: Ctx) {
    const dbUser = await this.prisma.user.findUnique({ where: { id: user.userId } });
    if (!dbUser?.isActive) throw new UnauthorizedException({ error: 'UNAUTHORIZED', message: 'Usuario inactivo' });
    const member = await this.prisma.userCompany.findUnique({ where: { userId_companyId: { userId: user.userId, companyId } } });
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company?.isActive || (!dbUser.isSuperAdmin && !member?.isActive)) {
      throw new ForbiddenLike('No pertenece a la empresa indicada', 'COMPANY_FORBIDDEN');
    }
    await this.revokeAccess(user);
    const tokens = await this.issue(user.userId, dbUser.isSuperAdmin, companyId, ctx);
    await this.audit.log('auth', user.userId, 'SELECT_COMPANY', { companyId }, { companyId: null, userId: user.userId });
    return { companyId, ...tokens };
  }

  // ───────── refresh (rotativo con detección de reutilización) ─────────
  async refresh(refreshToken: string, ctx: Ctx) {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
    if (!row) throw new UnauthorizedException({ error: 'REFRESH_INVALID', message: 'Refresh token inválido' });
    if (row.revokedAt) {
      // Reutilización de un token ya rotado → se asume robo: se revoca toda la familia.
      await this.prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log('auth', row.userId, 'REFRESH_REUSE_DETECTED', { familyId: row.familyId }, { companyId: null, userId: row.userId });
      throw new UnauthorizedException({ error: 'REFRESH_REUSED', message: 'Sesión revocada por seguridad; inicie sesión nuevamente' });
    }
    if (row.expiresAt < new Date()) throw new UnauthorizedException({ error: 'REFRESH_EXPIRED', message: 'Refresh token expirado' });
    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user?.isActive) throw new UnauthorizedException({ error: 'UNAUTHORIZED', message: 'Usuario inactivo' });
    const tokens = await this.issue(user.id, user.isSuperAdmin, row.companyId ?? undefined, ctx, row);
    return tokens;
  }

  // ───────── logout ─────────
  async logout(user: AuthUser, refreshToken?: string) {
    await this.revokeAccess(user);
    if (refreshToken) {
      const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
      if (row && row.userId === user.userId) {
        await this.prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    }
    await this.audit.log('auth', user.userId, 'LOGOUT', undefined, { companyId: user.companyId ?? null, userId: user.userId });
  }

  async me(user: AuthUser) {
    const dbUser = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    const companies = await this.userCompanies(user.userId, dbUser.isSuperAdmin);
    let company: unknown = null, permissions: string[] = [], roles: { code: string; name: string }[] = [];
    if (user.companyId) {
      company = await this.prisma.company.findUnique({ where: { id: user.companyId } });
      permissions = dbUser.isSuperAdmin ? ['*'] : await this.perms.forUser(user.userId, user.companyId);
      roles = await this.prisma.runWithTenant(user.companyId, async tx => {
        const ur = await tx.userRole.findMany({ where: { userId: user.userId, companyId: user.companyId! } });
        return tx.role.findMany({ where: { id: { in: ur.map(r => r.roleId) } }, select: { code: true, name: true } });
      });
    }
    return {
      user: { id: dbUser.id, email: dbUser.email, fullName: dbUser.fullName, isSuperAdmin: dbUser.isSuperAdmin },
      companies, company, roles, permissions,
    };
  }

  async changePassword(user: AuthUser, current: string, next: string) {
    const dbUser = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    if (!(await argon2.verify(dbUser.passwordHash, current).catch(() => false))) {
      throw new BusinessRuleException('La contraseña actual no es correcta', 'INVALID_CURRENT_PASSWORD');
    }
    assertStrongPassword(next);
    await this.prisma.user.update({ where: { id: dbUser.id }, data: { passwordHash: await hashPassword(next) } });
    await this.prisma.refreshToken.updateMany({ where: { userId: dbUser.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.revokeAccess(user);
    await this.audit.log('auth', dbUser.id, 'CHANGE_PASSWORD', undefined, { companyId: user.companyId ?? null, userId: dbUser.id });
  }

  // ───────── internos ─────────
  private async revokeAccess(user: AuthUser) {
    const ttl = Math.max(1, user.exp - Math.floor(Date.now() / 1000));
    await this.redis.client.set(`bl:${user.jti}`, '1', 'EX', ttl);
  }

  private async issue(userId: string, isSuperAdmin: boolean, companyId: string | undefined, ctx: Ctx, previous?: { id: string; familyId: string }): Promise<TokenPair> {
    const jti = randomUUID();
    const accessToken = await this.jwt.signAsync(
      { sub: userId, companyId, jti, sa: isSuperAdmin || undefined },
      { secret: env.JWT_ACCESS_SECRET, expiresIn: ACCESS_TTL_SECONDS },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    const familyId = previous?.familyId ?? randomUUID();
    const created = await this.prisma.refreshToken.create({
      data: {
        userId, companyId: companyId ?? null, tokenHash: sha256(refreshToken), familyId,
        expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000),
        userAgent: ctx.userAgent, ip: ctx.ip,
      },
    });
    if (previous) {
      await this.prisma.refreshToken.update({ where: { id: previous.id }, data: { revokedAt: new Date(), replacedById: created.id } });
    }
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS };
  }
}

export const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });

export function assertStrongPassword(p: string) {
  if (p.length < 10 || !/[a-z]/i.test(p) || !/\d/.test(p)) {
    throw new BusinessRuleException('La contraseña debe tener al menos 10 caracteres, letras y números', 'WEAK_PASSWORD');
  }
}
