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
    const orgs = await this.prisma.organization.findMany({ where, orderBy: { name: 'asc' } });
    const counts = await this.prisma.company.groupBy({ by: ['organizationId'], _count: { _all: true }, where: { organizationId: { in: orgs.map(o => o.id) } } });
    const c = new Map(counts.map(x => [x.organizationId, x._count._all]));
    return orgs.map(o => ({ ...o, companyCount: c.get(o.id) ?? 0 }));
  }

  /** Alta de cliente (solo superadmin). El administrador indicado queda como administrador del cliente. */
  async create(input: { name: string; admin?: { email: string; fullName: string; password?: string } }) {
    const org = await this.prisma.organization.create({ data: { name: input.name } });
    let adminUserId: string | undefined;
    if (input.admin) adminUserId = await this.addUser(org.id, input.admin, true);
    await this.audit.log('organization', org.id, 'CREATE', { name: input.name, admin: input.admin?.email }, { companyId: null });
    return { ...org, adminUserId };
  }

  async update(id: string, data: { name?: string; isActive?: boolean }) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundError('Cliente', id);
    const r = await this.prisma.organization.update({ where: { id }, data });
    await this.audit.log('organization', id, 'UPDATE', data, { companyId: null });
    return r;
  }

  /** Crea (o vincula) un usuario dentro de un cliente. Un usuario pertenece a un único cliente. */
  async addUser(organizationId: string, u: { email: string; fullName: string; password?: string }, isAdmin: boolean): Promise<string> {
    const email = u.email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (user) {
      if (user.isSuperAdmin) throw new BusinessRuleException('Ese usuario no puede asignarse a un cliente', 'USER_NOT_ASSIGNABLE');
      const current = await this.prisma.userOrganization.findFirst({ where: { userId: user.id } });
      if (current && current.organizationId !== organizationId) {
        // Mensaje genérico: no revelar que el correo existe en otro cliente.
        throw new BusinessRuleException('No se puede agregar este usuario', 'USER_NOT_ASSIGNABLE');
      }
    } else {
      if (!u.password) throw new BusinessRuleException('Se requiere contraseña para un usuario nuevo', 'PASSWORD_REQUIRED');
      assertStrongPassword(u.password);
      user = await this.prisma.user.create({ data: { email, fullName: u.fullName, passwordHash: await hashPassword(u.password) } });
    }
    await this.prisma.userOrganization.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId } },
      update: isAdmin ? { isAdmin: true } : {}, create: { userId: user.id, organizationId, isAdmin },
    });
    return user.id;
  }

  async assertCanManage(actor: Actor, organizationId: string) {
    if (actor.isSuperAdmin) return;
    if (!(await this.access.adminOrgIds(actor.userId)).includes(organizationId)) {
      throw new BusinessRuleException('No tiene permisos sobre ese cliente', 'FORBIDDEN_ORGANIZATION');
    }
  }
}
