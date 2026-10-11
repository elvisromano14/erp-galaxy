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
  async addUser(organizationId: string, u: { email: string; fullName: string; password?: string }, isAdmin: boolean, multiOrg = false): Promise<string> {
    const email = u.email.toLowerCase();
    let user = await this.prisma.db.user.findUnique({ where: { email } });
    if (user) {
      if (user.isSuperAdmin) throw new BusinessRuleException('Ese usuario no puede asignarse a un cliente', 'USER_NOT_ASSIGNABLE');
      // Un cliente (administrador de empresa) puede pertenecer a varias empresas; un usuario normal, a un solo cliente.
      const others = (await this.prisma.db.userOrganization.findMany({ where: { userId: user.id } })).filter(o => o.organizationId !== organizationId);
      if (others.length && !(multiOrg && others.every(o => o.isAdmin))) {
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

  /**
   * Alta de un cliente (administrador de empresa) asignado a una o varias empresas. En cada empresa queda con el rol ADMIN
   * y la empresa se actualiza: correo = correo del cliente, administrador = nombre del cliente.
   */
  async createClient(input: { fullName: string; email: string; password: string; companyIds: string[] }) {
    const companies = await this.loadCompanies(input.companyIds);
    const userId = await this.addUser(companies[0].organizationId, { email: input.email, fullName: input.fullName, password: input.password }, true, true);
    await this.assignCompanies(userId, input.fullName, input.email.toLowerCase(), companies);
    await this.audit.log('client', userId, 'CREATE', { email: input.email.toLowerCase(), companyIds: input.companyIds }, { companyId: null });
    return { id: userId, email: input.email.toLowerCase(), fullName: input.fullName, companyIds: input.companyIds };
  }

  /** Cambia las empresas de un cliente: agrega las nuevas y retira las que ya no tiene. */
  async setClientCompanies(userId: string, companyIds: string[]) {
    const user = await this.prisma.db.user.findUnique({ where: { id: userId } });
    const links = await this.prisma.db.userOrganization.findMany({ where: { userId, isAdmin: true } });
    if (!user || !links.length) throw new NotFoundError('Cliente', userId);
    const wanted = await this.loadCompanies(companyIds);
    const current = await this.prisma.db.company.findMany({ where: { organizationId: { in: links.map(l => l.organizationId) } } });
    const keep = new Set(wanted.map(c => c.id));
    for (const c of current.filter(c => !keep.has(c.id))) {
      await this.prisma.db.userCompany.updateMany({ where: { userId, companyId: c.id }, data: { isActive: false } });
      await this.prisma.db.userOrganization.deleteMany({ where: { userId, organizationId: c.organizationId } });
      await this.prisma.db.refreshToken.updateMany({ where: { userId, companyId: c.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (c.email === user.email) await this.prisma.db.company.update({ where: { id: c.id }, data: { email: null, adminName: null } });
    }
    await this.assignCompanies(userId, user.fullName, user.email, wanted);
    await this.audit.log('client', userId, 'UPDATE', { companyIds }, { companyId: null });
    return { id: userId, companyIds };
  }

  private async loadCompanies(ids: string[]) {
    const unique = [...new Set(ids)];
    const companies = await this.prisma.db.company.findMany({ where: { id: { in: unique } } });
    if (!unique.length || companies.length !== unique.length) throw new BusinessRuleException('Seleccione al menos una empresa válida', 'COMPANY_NOT_FOUND');
    return companies;
  }

  private async assignCompanies(userId: string, fullName: string, email: string, companies: { id: string; organizationId: string }[]) {
    for (const c of companies) {
      await this.prisma.db.userOrganization.upsert({
        where: { userId_organizationId: { userId, organizationId: c.organizationId } },
        update: { isAdmin: true }, create: { userId, organizationId: c.organizationId, isAdmin: true },
      });
      await this.access.ensureOrgAdminMembership(userId, c.id);
      await this.prisma.db.company.update({ where: { id: c.id }, data: { email, adminName: fullName } });
    }
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
