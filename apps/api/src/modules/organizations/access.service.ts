import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/db/prisma.service';

export interface VisibleCompany {
  id: string; rif: string; legalName: string; tradeName: string | null; organizationId: string; organizationName: string;
  isActive: boolean; fiscalAddress: string | null; isSpecialTaxpayer: boolean; isVatWithholdingAgent: boolean; isIgtfCollector: boolean;
}

export type AccessVia = 'super' | 'orgAdmin' | 'member';

/**
 * Regla de visibilidad de empresas (clientes aislados entre sí):
 *  - superadmin de plataforma → todas;
 *  - administrador de cliente → todas las empresas de SU cliente (aunque no esté asignado una a una);
 *  - usuario normal → solo las empresas a las que fue asignado explícitamente, dentro de su cliente.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async adminOrgIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.db.userOrganization.findMany({ where: { userId, isAdmin: true }, select: { organizationId: true } });
    return rows.map(r => r.organizationId);
  }

  async userOrgId(userId: string): Promise<string | null> {
    return (await this.prisma.db.userOrganization.findFirst({ where: { userId } }))?.organizationId ?? null;
  }

  async visibleCompanies(userId: string, isSuperAdmin: boolean, includeInactive = false): Promise<VisibleCompany[]> {
    const select = { id: true, rif: true, legalName: true, tradeName: true, organizationId: true, isActive: true, fiscalAddress: true, isSpecialTaxpayer: true, isVatWithholdingAgent: true, isIgtfCollector: true };
    const active = includeInactive ? {} : { isActive: true };
    let companies;
    if (isSuperAdmin) {
      companies = await this.prisma.db.company.findMany({ where: { ...active }, select, orderBy: { legalName: 'asc' } });
    } else {
      const adminOrgs = await this.adminOrgIds(userId);
      const memberIds = (await this.prisma.db.userCompany.findMany({ where: { userId, isActive: true }, select: { companyId: true } })).map(m => m.companyId);
      // Los miembros solo cuentan dentro de su propio cliente (defensa si hubiera datos cruzados).
      const myOrg = await this.userOrgId(userId);
      companies = await this.prisma.db.company.findMany({
        where: {
          ...active,
          OR: [
            ...(adminOrgs.length ? [{ organizationId: { in: adminOrgs } }] : []),
            ...(memberIds.length && myOrg ? [{ id: { in: memberIds }, organizationId: myOrg }] : []),
          ],
        },
        select, orderBy: { legalName: 'asc' },
      });
      if (!adminOrgs.length && !memberIds.length) return [];
    }
    const orgs = new Map((await this.prisma.db.organization.findMany({ where: { id: { in: [...new Set(companies.map(c => c.organizationId))] } } })).map(o => [o.id, o.name]));
    return companies.map(c => ({ ...c, organizationName: orgs.get(c.organizationId) ?? '' }));
  }

  async accessTo(userId: string, isSuperAdmin: boolean, companyId: string): Promise<AccessVia | null> {
    const company = await this.prisma.db.company.findUnique({ where: { id: companyId } });
    if (!company?.isActive) return null;
    if (isSuperAdmin) return 'super';
    const org = await this.prisma.db.organization.findUnique({ where: { id: company.organizationId } });
    if (!org?.isActive) return null;
    const uo = await this.prisma.db.userOrganization.findFirst({ where: { userId, organizationId: company.organizationId } });
    if (!uo) return null; // otro cliente: jamás
    if (uo.isAdmin) return 'orgAdmin';
    const m = await this.prisma.db.userCompany.findUnique({ where: { userId_companyId: { userId, companyId } } });
    return m?.isActive ? 'member' : null;
  }

  /** Un administrador de cliente que entra por primera vez a una empresa de su cliente recibe el rol ADMIN en ella. */
  async ensureOrgAdminMembership(userId: string, companyId: string) {
    const member = await this.prisma.db.userCompany.findUnique({ where: { userId_companyId: { userId, companyId } } });
    if (member?.isActive) {
      const has = await this.prisma.runWithTenant(companyId, tx => tx.userRole.count({ where: { userId, companyId } }));
      if (has) return;
    }
    await this.prisma.db.userCompany.upsert({
      where: { userId_companyId: { userId, companyId } }, update: { isActive: true }, create: { userId, companyId },
    });
    await this.prisma.runWithTenant(companyId, async tx => {
      const role = await tx.role.findUnique({ where: { companyId_code: { companyId, code: 'ADMIN' } } });
      if (role) await tx.userRole.upsert({ where: { userId_companyId_roleId: { userId, companyId, roleId: role.id } }, update: {}, create: { userId, companyId, roleId: role.id } });
    });
  }
}
