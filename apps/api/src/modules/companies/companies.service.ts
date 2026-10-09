import { Injectable } from '@nestjs/common';
import { isValidRif, normalizeRif, formatRif } from '@erp/domain';
import { PrismaService } from '../../common/db/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { PermissionsService } from '../../common/auth/permissions.service';
import { ALL_PERMISSIONS, ROLE_TEMPLATES } from '../../common/auth/permissions';
import { BusinessRuleException, ConflictError, NotFoundError } from '../../common/errors/errors';
import { hashPassword, assertStrongPassword } from '../auth/auth.service';
import { DEFAULT_OPERATION_TYPES, DEFAULT_PAYMENT_METHODS, DEFAULT_REASONS, DEFAULT_TAXES, DEFAULT_UNITS } from './company-defaults';

export interface CreateCompanyInput {
  rif: string; legalName: string; tradeName?: string; fiscalAddress?: string;
  baseCurrencyCode?: string; valuationCurrencyCode?: string;
  isSpecialTaxpayer?: boolean; isVatWithholdingAgent?: boolean; isIgtfCollector?: boolean;
  admin?: { email: string; fullName: string; password: string };
}

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly perms: PermissionsService,
  ) {}

  /** Asegura el catálogo global de permisos (idempotente). */
  async syncPermissionCatalog() {
    const existing = new Set((await this.prisma.permission.findMany({ select: { code: true } })).map(p => p.code));
    const toCreate = ALL_PERMISSIONS.filter(c => !existing.has(c));
    if (toCreate.length) {
      await this.prisma.permission.createMany({
        data: toCreate.map(code => ({ code, module: code.split(':')[0], description: code })),
        skipDuplicates: true,
      });
    }
  }

  async create(input: CreateCompanyInput) {
    if (!isValidRif(input.rif)) throw new BusinessRuleException('RIF inválido', 'INVALID_RIF', [{ field: 'rif', code: 'INVALID_RIF' }]);
    const rif = formatRif(input.rif);
    const exists = await this.prisma.company.findUnique({ where: { rif } });
    if (exists) throw new ConflictError('Ya existe una empresa con ese RIF', 'UNIQUE_VIOLATION', [{ field: 'rif', code: 'DUPLICATE' }]);
    const [base, valuation] = await Promise.all([
      this.prisma.currency.findUnique({ where: { code: input.baseCurrencyCode ?? 'VES' } }),
      this.prisma.currency.findUnique({ where: { code: input.valuationCurrencyCode ?? 'USD' } }),
    ]);
    if (!base || !valuation) throw new BusinessRuleException('Moneda base o de valoración inexistente', 'CURRENCY_NOT_FOUND');
    if (input.admin) assertStrongPassword(input.admin.password);

    await this.syncPermissionCatalog();
    const company = await this.prisma.company.create({
      data: {
        rif, legalName: input.legalName, tradeName: input.tradeName, fiscalAddress: input.fiscalAddress,
        baseCurrencyId: base.id, valuationCurrencyId: valuation.id,
        isSpecialTaxpayer: input.isSpecialTaxpayer ?? false,
        isVatWithholdingAgent: input.isVatWithholdingAgent ?? false,
        isIgtfCollector: input.isIgtfCollector ?? false,
      },
    });
    let adminUserId: string | undefined;
    await this.prisma.runWithTenant(company.id, async tx => {
      await this.provision(tx, company.id, valuation.id);
      if (input.admin) {
        const email = input.admin.email.toLowerCase();
        let user = await tx.user.findUnique({ where: { email } });
        if (!user) {
          user = await tx.user.create({ data: { email, fullName: input.admin.fullName, passwordHash: await hashPassword(input.admin.password) } });
        }
        adminUserId = user.id;
        await tx.userCompany.upsert({
          where: { userId_companyId: { userId: user.id, companyId: company.id } },
          update: { isActive: true }, create: { userId: user.id, companyId: company.id },
        });
        const adminRole = await tx.role.findUniqueOrThrow({ where: { companyId_code: { companyId: company.id, code: 'ADMIN' } } });
        await tx.userRole.create({ data: { userId: user.id, companyId: company.id, roleId: adminRole.id } });
      }
    });
    await this.audit.log('company', company.id, 'CREATE', { rif, legalName: company.legalName }, { companyId: null });
    return { ...company, adminUserId };
  }

  /** Datos iniciales de una empresa: roles, impuestos, unidades, motivos, formas de pago, lista de precios, depósito. */
  async provision(tx: import('../../common/db/tenant-context').Tx, companyId: string, valuationCurrencyId: string) {
    for (const [code, tpl] of Object.entries(ROLE_TEMPLATES)) {
      const role = await tx.role.create({ data: { companyId, code, name: tpl.name, isSystem: true } });
      await tx.rolePermission.createMany({ data: [...new Set(tpl.permissions)].map(p => ({ companyId, roleId: role.id, permissionCode: p })) });
    }
    const validFrom = new Date('2020-01-01');
    await tx.tax.createMany({ data: DEFAULT_TAXES.map(t => ({ companyId, code: t.code, name: t.name, kind: t.kind, rate: t.rate, validFrom })) });
    await tx.unit.createMany({ data: DEFAULT_UNITS.map(u => ({ companyId, ...u })) });
    await tx.movementReason.createMany({ data: DEFAULT_REASONS.map(r => ({ companyId, ...r })) });
    const currencies = new Map((await tx.currency.findMany()).map(c => [c.code, c.id]));
    await tx.paymentMethod.createMany({
      data: DEFAULT_PAYMENT_METHODS.map(m => ({
        companyId, code: m.code, name: m.name, type: m.type, requiresReference: m.requiresReference,
        appliesIgtf: m.appliesIgtf, currencyId: m.currency ? currencies.get(m.currency) ?? null : null,
      })),
    });
    await tx.operationType.createMany({ data: DEFAULT_OPERATION_TYPES.map(o => ({ companyId, ...o })) });
    await tx.priceList.create({ data: { companyId, code: 'DETAL', name: 'Precio detal', currencyId: valuationCurrencyId, isDefault: true } });
    await tx.warehouse.create({ data: { companyId, code: 'PRINCIPAL', name: 'Depósito principal' } });
  }

  // ───────── empresa actual ─────────
  async current() {
    const c = await this.prisma.company.findUnique({ where: { id: this.prisma.companyId } });
    if (!c) throw new NotFoundError('Empresa');
    return c;
  }

  async updateCurrent(data: {
    legalName?: string; tradeName?: string | null; fiscalAddress?: string | null;
    isSpecialTaxpayer?: boolean; isVatWithholdingAgent?: boolean; isIgtfCollector?: boolean;
    features?: { lots?: boolean; serials?: boolean; expiry?: boolean; offline?: boolean };
  }) {
    const current = await this.current();
    let features = current.features as Record<string, boolean>;
    if (data.features) {
      if (data.features.serials) {
        throw new BusinessRuleException('El control por seriales aún no está implementado', 'FEATURE_NOT_AVAILABLE');
      }
      features = { ...features, ...data.features };
      if (features.expiry && !features.lots) throw new BusinessRuleException('El vencimiento requiere habilitar lotes', 'FEATURE_DEPENDENCY');
    }
    const { features: _f, ...rest } = data;
    const updated = await this.prisma.company.update({ where: { id: current.id }, data: { ...rest, features } });
    await this.audit.log('company', current.id, 'UPDATE', data);
    return updated;
  }

  async listAll() {
    return this.prisma.company.findMany({ orderBy: { legalName: 'asc' } });
  }

  // ───────── usuarios y roles de la empresa ─────────
  async listUsers() {
    const companyId = this.prisma.companyId;
    const members = await this.prisma.userCompany.findMany({ where: { companyId } });
    const users = await this.prisma.user.findMany({ where: { id: { in: members.map(m => m.userId) } }, orderBy: { fullName: 'asc' } });
    const userRoles = await this.prisma.tx.userRole.findMany({ where: { companyId } });
    const roles = await this.prisma.tx.role.findMany({ where: { companyId } });
    const roleById = new Map(roles.map(r => [r.id, r]));
    return users.map(u => ({
      id: u.id, email: u.email, fullName: u.fullName, isActive: u.isActive && !!members.find(m => m.userId === u.id)?.isActive,
      roles: userRoles.filter(r => r.userId === u.id).map(r => roleById.get(r.roleId)?.code).filter(Boolean),
    }));
  }

  async createUser(input: { email: string; fullName: string; password?: string; roleCodes: string[] }) {
    const companyId = this.prisma.companyId;
    const tx = this.prisma.tx;
    const email = input.email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (user) {
      const member = await this.prisma.userCompany.findUnique({ where: { userId_companyId: { userId: user.id, companyId } } });
      if (member) throw new ConflictError('El usuario ya pertenece a esta empresa', 'UNIQUE_VIOLATION');
    } else {
      if (!input.password) throw new BusinessRuleException('Se requiere contraseña para un usuario nuevo', 'PASSWORD_REQUIRED');
      assertStrongPassword(input.password);
      user = await this.prisma.user.create({ data: { email, fullName: input.fullName, passwordHash: await hashPassword(input.password) } });
    }
    await this.prisma.userCompany.create({ data: { userId: user.id, companyId } });
    await this.setRoles(user.id, input.roleCodes);
    await this.audit.log('user', user.id, 'CREATE', { email, roles: input.roleCodes });
    return { id: user.id, email: user.email, fullName: user.fullName, roles: input.roleCodes };
  }

  async updateUser(userId: string, data: { fullName?: string; isActive?: boolean; roleCodes?: string[] }) {
    const companyId = this.prisma.companyId;
    const member = await this.prisma.userCompany.findUnique({ where: { userId_companyId: { userId, companyId } } });
    if (!member) throw new NotFoundError('Usuario', userId);
    if (data.fullName) await this.prisma.user.update({ where: { id: userId }, data: { fullName: data.fullName } });
    if (data.isActive !== undefined) {
      await this.prisma.userCompany.update({ where: { userId_companyId: { userId, companyId } }, data: { isActive: data.isActive } });
      if (!data.isActive) await this.prisma.refreshToken.updateMany({ where: { userId, companyId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    if (data.roleCodes) await this.setRoles(userId, data.roleCodes);
    await this.perms.invalidate(companyId, userId);
    await this.audit.log('user', userId, 'UPDATE', data);
    return { id: userId };
  }

  private async setRoles(userId: string, roleCodes: string[]) {
    const companyId = this.prisma.companyId;
    const tx = this.prisma.tx;
    const roles = await tx.role.findMany({ where: { companyId, code: { in: roleCodes } } });
    if (roles.length !== new Set(roleCodes).size) throw new BusinessRuleException('Algún rol indicado no existe', 'ROLE_NOT_FOUND');
    await tx.userRole.deleteMany({ where: { userId, companyId } });
    if (roles.length) await tx.userRole.createMany({ data: roles.map(r => ({ userId, companyId, roleId: r.id })) });
    await this.perms.invalidate(companyId, userId);
  }

  async listRoles() {
    const tx = this.prisma.tx;
    const companyId = this.prisma.companyId;
    const roles = await tx.role.findMany({ where: { companyId }, orderBy: { code: 'asc' } });
    const rp = await tx.rolePermission.findMany({ where: { companyId } });
    return roles.map(r => ({ id: r.id, code: r.code, name: r.name, isSystem: r.isSystem, permissions: rp.filter(x => x.roleId === r.id).map(x => x.permissionCode).sort() }));
  }

  async createRole(input: { code: string; name: string; permissions: string[] }) {
    const companyId = this.prisma.companyId;
    const tx = this.prisma.tx;
    this.assertKnownPermissions(input.permissions);
    const role = await tx.role.create({ data: { companyId, code: input.code.toUpperCase(), name: input.name } });
    await tx.rolePermission.createMany({ data: [...new Set(input.permissions)].map(p => ({ companyId, roleId: role.id, permissionCode: p })) });
    await this.audit.log('role', role.id, 'CREATE', input);
    return { id: role.id, code: role.code, name: role.name, permissions: input.permissions };
  }

  async updateRole(id: string, input: { name?: string; permissions?: string[] }) {
    const companyId = this.prisma.companyId;
    const tx = this.prisma.tx;
    const role = await tx.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundError('Rol', id);
    if (role.code === 'ADMIN') throw new BusinessRuleException('El rol ADMIN no se puede modificar', 'ROLE_PROTECTED');
    if (input.name) await tx.role.update({ where: { id }, data: { name: input.name } });
    if (input.permissions) {
      this.assertKnownPermissions(input.permissions);
      await tx.rolePermission.deleteMany({ where: { companyId, roleId: id } });
      await tx.rolePermission.createMany({ data: [...new Set(input.permissions)].map(p => ({ companyId, roleId: id, permissionCode: p })) });
      await this.perms.invalidate(companyId);
    }
    await this.audit.log('role', id, 'UPDATE', input);
    return { id };
  }

  private assertKnownPermissions(perms: string[]) {
    const known = new Set(ALL_PERMISSIONS);
    const unknown = perms.filter(p => !known.has(p));
    if (unknown.length) throw new BusinessRuleException(`Permisos desconocidos: ${unknown.join(', ')}`, 'UNKNOWN_PERMISSION');
  }

  async listPermissions() {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }
}
