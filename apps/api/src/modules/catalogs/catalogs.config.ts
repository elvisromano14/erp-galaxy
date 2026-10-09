import { z } from 'zod';
import { decimalStr, uuid } from '@erp/contracts';
import { formatRif, isValidRif } from '@erp/domain';
import { BusinessRuleException } from '../../common/errors/errors';
import { CrudConfig } from './crud.factory';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');
const code = z.string().trim().min(1).max(30);
const name = z.string().trim().min(1).max(200);
const optStr = z.string().trim().max(500).nullable().optional();
const optUuid = uuid.nullable().optional();
const pct = decimalStr.refine(v => Number(v) >= 0 && Number(v) <= 100, 'Debe estar entre 0 y 100');

const rifHook = (data: any) => {
  if (data.rif !== undefined) {
    if (!isValidRif(data.rif)) throw new BusinessRuleException('RIF inválido', 'INVALID_RIF', [{ field: 'rif', code: 'INVALID_RIF' }]);
    data.rif = formatRif(data.rif);
  }
  return data;
};

export const CATALOGS: CrudConfig<any>[] = [
  {
    path: 'warehouses', entity: 'warehouse', model: 'warehouse', permission: 'admin:warehouses',
    create: z.object({ code, name, address: optStr, allowNegativeStock: z.boolean().optional(), isActive: z.boolean().optional() }),
    searchFields: ['code', 'name'], sortable: ['code', 'name', 'createdAt'], defaultSort: 'code', filterable: ['isActive'], softDelete: true,
  },
  {
    path: 'categories', entity: 'category', model: 'category', permission: 'admin:categories',
    create: z.object({ code, name, parentId: optUuid, marginDefault: pct.nullable().optional() }),
    searchFields: ['code', 'name'], sortable: ['code', 'name', 'createdAt'], defaultSort: 'code', filterable: ['parentId'], softDelete: true,
    beforeSave: (d, { id }) => {
      if (id && d.parentId === id) throw new BusinessRuleException('Una instancia no puede ser su propio padre', 'INVALID_PARENT');
      return d;
    },
  },
  {
    path: 'units', entity: 'unit', model: 'unit', permission: 'admin:units',
    create: z.object({ code, name }),
    searchFields: ['code', 'name'], sortable: ['code', 'name'], defaultSort: 'code', softDelete: true,
  },
  {
    path: 'taxes', entity: 'tax', model: 'tax', permission: 'admin:taxes',
    create: z.object({
      code, name, kind: z.enum(['VAT', 'EXEMPT', 'EXONERATED', 'IGTF']).default('VAT'), rate: pct,
      validFrom: date, validTo: date.nullable().optional(), isActive: z.boolean().optional(),
    }),
    searchFields: ['code', 'name'], sortable: ['code', 'name', 'validFrom'], defaultSort: 'code', filterable: ['kind', 'isActive'], softDelete: true,
    dateFields: ['validFrom', 'validTo'],
    beforeSave: (d) => {
      if (d.validFrom && d.validTo && d.validTo < d.validFrom) throw new BusinessRuleException('La vigencia final es anterior a la inicial', 'INVALID_VALIDITY');
      if (d.kind && d.kind !== 'VAT' && d.kind !== 'IGTF' && d.rate !== undefined && Number(d.rate) !== 0) {
        throw new BusinessRuleException('Un impuesto exento/exonerado debe tener alícuota 0', 'INVALID_RATE');
      }
      return d;
    },
  },
  {
    path: 'price-lists', entity: 'price_list', model: 'priceList', permission: 'admin:price-lists',
    create: z.object({ code, name, currencyId: uuid, isDefault: z.boolean().optional() }),
    searchFields: ['code', 'name'], sortable: ['code', 'name'], defaultSort: 'code', softDelete: true,
    beforeSave: async (d, { prisma, id }) => {
      if (d.isDefault) {
        await prisma.tx.priceList.updateMany({ where: { companyId: prisma.companyId, isDefault: true, ...(id ? { id: { not: id } } : {}) }, data: { isDefault: false } });
      }
      return d;
    },
  },
  {
    path: 'zones', entity: 'zone', model: 'zone', permission: 'admin:zones',
    create: z.object({ code, name, parentId: optUuid }),
    searchFields: ['code', 'name'], sortable: ['code', 'name'], defaultSort: 'code', filterable: ['parentId'], softDelete: true,
  },
  {
    path: 'sellers', entity: 'seller', model: 'seller', permission: 'admin:sellers',
    create: z.object({ code, name, userId: optUuid, commissionRate: pct.optional(), zoneId: optUuid, monthlyGoal: decimalStr.nullable().optional(), isActive: z.boolean().optional() }),
    searchFields: ['code', 'name'], sortable: ['code', 'name'], defaultSort: 'code', filterable: ['zoneId', 'isActive'], softDelete: true,
  },
  {
    path: 'suppliers', entity: 'supplier', model: 'supplier', permission: 'admin:suppliers',
    create: z.object({
      rif: z.string().min(5), legalName: name, tradeName: optStr, personType: z.enum(['LEGAL', 'NATURAL']).optional(),
      isSpecialTaxpayer: z.boolean().optional(), retentionIvaPct: pct.optional(), isIslrSubject: z.boolean().optional(),
      creditDays: z.number().int().min(0).max(365).optional(), zoneId: optUuid,
      email: z.string().email().nullable().optional(), phone: optStr, address: optStr, isActive: z.boolean().optional(),
    }),
    searchFields: ['rif', 'legalName', 'tradeName'], sortable: ['legalName', 'rif', 'createdAt'], defaultSort: 'legalName', filterable: ['isActive', 'zoneId'], softDelete: true,
    beforeSave: rifHook,
  },
  {
    path: 'customers', entity: 'customer', model: 'customer', permission: 'admin:customers',
    create: z.object({
      rif: z.string().min(5), legalName: name, tradeName: optStr, personType: z.enum(['LEGAL', 'NATURAL']).optional(),
      isSpecialTaxpayer: z.boolean().optional(), retentionIvaPct: pct.optional(), priceListId: optUuid,
      creditLimit: decimalStr.optional(), creditDays: z.number().int().min(0).max(365).optional(),
      sellerId: optUuid, zoneId: optUuid,
      email: z.string().email().nullable().optional(), phone: optStr, address: optStr, isActive: z.boolean().optional(),
    }),
    searchFields: ['rif', 'legalName', 'tradeName'], sortable: ['legalName', 'rif', 'createdAt'], defaultSort: 'legalName', filterable: ['isActive', 'sellerId', 'zoneId'], softDelete: true,
    beforeSave: rifHook,
  },
  {
    path: 'payment-methods', entity: 'payment_method', model: 'paymentMethod', permission: 'admin:payment-methods',
    create: z.object({
      code, name, type: z.enum(['CASH', 'TRANSFER', 'MOBILE_PAYMENT', 'CARD', 'ZELLE', 'CHECK', 'WITHHOLDING', 'CREDIT']),
      currencyId: optUuid, requiresReference: z.boolean().optional(), appliesIgtf: z.boolean().optional(), bankAccountId: optUuid, isActive: z.boolean().optional(),
    }),
    searchFields: ['code', 'name'], sortable: ['code', 'name'], defaultSort: 'code', filterable: ['type', 'isActive'], softDelete: true,
  },
  {
    path: 'operation-types', entity: 'operation_type', model: 'operationType', permission: 'admin:operation-types',
    create: z.object({
      code, name, docType: z.string().min(2), inventoryEffect: z.enum(['IN', 'OUT', 'NONE']).optional(),
      affectsReceivable: z.boolean().optional(), affectsPayable: z.boolean().optional(), affectsBank: z.boolean().optional(),
      requiresFiscalNumber: z.boolean().optional(), series: z.string().min(1).max(5).optional(), isActive: z.boolean().optional(),
    }),
    searchFields: ['code', 'name'], sortable: ['code', 'name'], defaultSort: 'code', filterable: ['docType', 'isActive'], softDelete: true,
  },
  {
    path: 'movement-reasons', entity: 'movement_reason', model: 'movementReason', permission: 'admin:movement-reasons',
    create: z.object({ code, name, kind: z.enum(['CHARGE', 'DISCHARGE', 'ADJUSTMENT']), isActive: z.boolean().optional() }),
    searchFields: ['code', 'name'], sortable: ['code', 'name'], defaultSort: 'code', filterable: ['kind', 'isActive'], softDelete: true,
  },
  {
    path: 'bank-accounts', entity: 'bank_account', model: 'bankAccount', permission: 'admin:bank-accounts',
    create: z.object({
      bankId: uuid, name, number: z.string().trim().min(5).max(30), currencyId: uuid,
      accountType: z.enum(['CHECKING', 'SAVINGS', 'CASH']).optional(), openingBalance: decimalStr.optional(), isActive: z.boolean().optional(),
    }),
    searchFields: ['name', 'number'], sortable: ['name', 'number'], defaultSort: 'name', filterable: ['bankId', 'currencyId', 'isActive'], softDelete: true,
  },
  // ───── globales (sin company_id) ─────
  {
    path: 'currencies', entity: 'currency', model: 'currency', permission: 'admin:currencies', global: true,
    create: z.object({ code: z.string().length(3).toUpperCase(), name, symbol: z.string().min(1).max(5), decimals: z.number().int().min(0).max(8).optional() }),
    searchFields: ['code', 'name'], sortable: ['code', 'name'], defaultSort: 'code',
  },
  {
    path: 'banks', entity: 'bank', model: 'bank', permission: 'admin:banks', global: true,
    create: z.object({ code: z.string().regex(/^\d{4}$/, 'Código de 4 dígitos'), name }),
    searchFields: ['code', 'name'], sortable: ['code', 'name'], defaultSort: 'code',
  },
];
