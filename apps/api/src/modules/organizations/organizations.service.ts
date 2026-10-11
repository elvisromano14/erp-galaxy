import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { BusinessRuleException, ConflictError, NotFoundError } from '../../common/errors/errors';
import { assertStrongPassword, hashPassword } from '../auth/auth.service';
import { AccessService } from './access.service';

export interface Actor { userId: string; isSuperAdmin: boolean }

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly access: AccessService) {}

  async list(actor: Actor) {
    const where = actor.isSuperAdmin ? {} : { id: { in: await this.access.adminOrgIds(actor.userId) } };
    const orgs = await this.prisma.db.organization.findMany({ where, orderBy: { name: 'asc' } });
    const counts = await this.prisma.db.company.groupBy({ by: ['organizationId'], _count: { _all: true }, where: { organizationId: { in: orgs.map(o => o.id) } } });
    const c = new Map(counts.map(x => [x.organizationId, x._count._all]));
    return orgs.map(o => ({ ...o, companyCount: c.get(o.id) ?? 0 }));
  }

  /** Alta de cliente (solo superadmin). El administrador indicado queda como administrador del cliente. */
  async create(input: { name: string; admin?: { email: string; fullName: string; password?: string } }) {
    const org = await this.prisma.db.organization.create({ data: { name: input.name } });
    let adminUserId: string | undefined;
    if (input.admin) adminUserId = await this.addUser(org.id, input.admin, true);
    await this.audit.log('organization', org.id, 'CREATE', { name: input.name, admin: input.admin?.email }, { companyId: null });
    return { ...org, adminUserId };
  }

  async update(id: string, data: { name?: string; isActive?: boolean }) {
    const org = await this.prisma.db.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundError('Cliente', id);
    const r = await this.prisma.db.organization.update({ where: { id }, data });
    await this.audit.log('organization', id, 'UPDATE', data, { companyId: null });
    return r;
  }

  /** Crea (o vincula) un usuario dentro de un cliente. Un usuario pertenece a un único cliente. */
  async addUser(organizationId: string, u: { email: string; fullName: string; password?: string }, isAdmin: boolean): Promise<string> {
    const email = u.email.toLowerCase();
    let user = await this.prisma.db.user.findUnique({ where: { email } });
    if (user) {
      if (user.isSuperAdmin) throw new BusinessRuleException('Ese usuario no puede asignarse a un cliente', 'USER_NOT_ASSIGNABLE');
      const current = await this.prisma.db.userOrganization.findFirst({ where: { userId: user.id } });
      if (current && current.organizationId !== organizationId) {
        // Mensaje genérico: no revelar que el correo existe en otro cliente.
        throw new BusinessRuleException('No se puede agregar este usuario', 'USER_NOT_ASSIGNABLE');
      }
    } else {
      if (!u.password) throw new BusinessRuleException('Se requiere contraseña para un usuario nuevo', 'PASSWORD_REQUIRED');
      assertStrongPassword(u.password);
      user = await this.prisma.db.user.create({ data: { email, fullName: u.fullName, passwordHash: await hashPassword(u.password) } });
    }
    await this.prisma.db.userOrganization.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId } },
      update: isAdmin ? { isAdmin: true } : {}, create: { userId: user.id, organizationId, isAdmin },
    });
    return user.id;
  }

  /** Clientes = administradores de empresa (creados por el administrador global), con la empresa a la que pertenecen. */
  async listClients() {
    const links = await this.prisma.db.userOrganization.findMany({ where: { isAdmin: true } });
    const users = await this.prisma.db.user.findMany({ where: { id: { in: links.map(l => l.userId) } }, orderBy: { fullName: 'asc' } });
    const companies = await this.prisma.db.company.findMany({ where: { organizationId: { in: links.map(l => l.organizationId) } }, orderBy: { legalName: 'asc' } });
    return users.map(u => {
      const orgIds = links.filter(l => l.userId === u.id).map(l => l.organizationId);
      return {
        id: u.id, fullName: u.fullName, email: u.email, isActive: u.isActive, lastLoginAt: u.lastLoginAt,
        companies: companies.filter(c => orgIds.includes(c.organizationId)).map(c => ({ id: c.id, rif: c.rif, name: c.tradeName || c.legalName })),
      };
    });
  }

  /** Alta de un administrador de empresa: queda como administrador del cliente dueño de la empresa y con el rol ADMIN en ella. */
  async createClient(input: { fullName: string; email: string; password: string; companyId: string }) {
    const company = await this.prisma.db.company.findUnique({ where: { id: input.companyId } });
    if (!company) throw new NotFoundError('Empresa', input.companyId);
    const userId = await this.addUser(company.organizationId, { email: input.email, fullName: input.fullName, password: input.password }, true);
    await this.access.ensureOrgAdminMembership(userId, company.id);
    await this.audit.log('client', userId, 'CREATE', { email: input.email.toLowerCase(), companyId: company.id }, { companyId: null });
    return { id: userId, email: input.email.toLowerCase(), fullName: input.fullName, companyId: company.id };
  }

  async setClientActive(userId: string, isActive: boolean) {
    const link = await this.prisma.db.userOrganization.findFirst({ where: { userId, isAdmin: true } });
    if (!link) throw new NotFoundError('Cliente', userId);
    await this.prisma.db.user.update({ where: { id: userId }, data: { isActive } });
    if (!isActive) await this.prisma.db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log('client', userId, isActive ? 'ACTIVATE' : 'DEACTIVATE', undefined, { companyId: null });
    return { id: userId, isActive };
  }

  async assertCanManage(actor: Actor, organizationId: string) {
    if (actor.isSuperAdmin) return;
    if (!(await this.access.adminOrgIds(actor.userId)).includes(organizationId)) {
      throw new BusinessRuleException('No tiene permisos sobre ese cliente', 'FORBIDDEN_ORGANIZATION');
    }
  }
}
