import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { ROLE_TEMPLATES } from '../../common/auth/permissions';
import { PermissionsService } from '../../common/auth/permissions.service';
import { PrismaService } from '../../common/db/prisma.service';
import { BusinessRuleException, ConflictError, NotFoundError } from '../../common/errors/errors';
import { hashPassword } from '../auth/auth.service';

const newSecret = () => `erpsvc_${randomBytes(32).toString('base64url')}`;
const newClientId = () => `svc_${randomBytes(9).toString('hex')}`;

/** Cuentas de servicio de la empresa activa (una activa por empresa). El secreto solo se muestra al crearlo o rotarlo. */
@Injectable()
export class ServiceAccountsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly perms: PermissionsService) {}

  async list() {
    const rows = await this.prisma.db.serviceCredential.findMany({ where: { companyId: this.prisma.companyId }, orderBy: { createdAt: 'desc' } });
    return rows.map(r => this.view(r));
  }

  async create(name: string) {
    const companyId = this.prisma.companyId;
    const active = await this.prisma.db.serviceCredential.findFirst({ where: { companyId, revokedAt: null } });
    if (active) throw new ConflictError('La empresa ya tiene una cuenta de servicio activa: rote su secreto o revóquela primero', 'SERVICE_ACCOUNT_EXISTS');
    const clientId = newClientId();
    const secret = newSecret();
    // Usuario de servicio: sin clave utilizable (el hash es de un valor aleatorio descartado) y fuera del listado de usuarios.
    const user = await this.prisma.db.user.create({
      data: { email: `${clientId}@integration.invalid`, fullName: `Integración: ${name}`, passwordHash: await hashPassword(randomBytes(48).toString('base64url')), isService: true },
    });
    await this.prisma.db.userCompany.create({ data: { userId: user.id, companyId } });
    const roleId = await this.ensureRole(companyId);
    await this.prisma.tx.userRole.create({ data: { userId: user.id, companyId, roleId } });
    const cred = await this.prisma.db.serviceCredential.create({
      data: { companyId, userId: user.id, clientId, secretHash: await hashPassword(secret), name, createdBy: this.prisma.userId ?? null },
    });
    await this.audit.log('service_account', cred.id, 'CREATE', { name, clientId });
    return { ...this.view(cred), clientSecret: secret };
  }

  async rotate(id: string) {
    const cred = await this.find(id);
    if (cred.revokedAt) throw new BusinessRuleException('La cuenta está revocada', 'SERVICE_ACCOUNT_REVOKED');
    const secret = newSecret();
    await this.prisma.db.serviceCredential.update({ where: { id }, data: { secretHash: await hashPassword(secret) } });
    await this.audit.log('service_account', id, 'ROTATE', { clientId: cred.clientId });
    return { ...this.view(cred), clientSecret: secret };
  }

  async revoke(id: string) {
    const cred = await this.find(id);
    if (cred.revokedAt) return this.view(cred);
    const companyId = this.prisma.companyId;
    const updated = await this.prisma.db.serviceCredential.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.prisma.db.userCompany.update({ where: { userId_companyId: { userId: cred.userId, companyId } }, data: { isActive: false } });
    await this.prisma.db.user.update({ where: { id: cred.userId }, data: { isActive: false } });
    await this.perms.invalidate(companyId, cred.userId);
    await this.audit.log('service_account', id, 'REVOKE', { clientId: cred.clientId });
    return this.view(updated);
  }

  private async find(id: string) {
    const cred = await this.prisma.db.serviceCredential.findFirst({ where: { id, companyId: this.prisma.companyId } });
    if (!cred) throw new NotFoundError('Cuenta de servicio', id);
    return cred;
  }

  /** El rol «Integrador» existe en las empresas nuevas; en las existentes se crea la primera vez que se necesita. */
  private async ensureRole(companyId: string): Promise<string> {
    const tx = this.prisma.tx;
    const tpl = ROLE_TEMPLATES.INTEGRADOR;
    let role = await tx.role.findFirst({ where: { companyId, code: 'INTEGRADOR' } });
    if (!role) role = await tx.role.create({ data: { companyId, code: 'INTEGRADOR', name: tpl.name, isSystem: true } });
    await tx.rolePermission.createMany({ data: [...new Set(tpl.permissions)].map(p => ({ companyId, roleId: role!.id, permissionCode: p })), skipDuplicates: true });
    return role.id;
  }

  private view(c: { id: string; clientId: string; name: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }) {
    return { id: c.id, clientId: c.clientId, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, revokedAt: c.revokedAt, active: !c.revokedAt };
  }
}
