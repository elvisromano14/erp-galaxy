import type { CrudDef } from "./crud-types";

const code = { name: "code", type: "text", required: true, maxLength: 30 } as const;
const name = { name: "name", type: "text", required: true, maxLength: 200 } as const;
const active = { name: "isActive", type: "boolean", default: true } as const;
const contact = [
  { name: "email", type: "email", nullable: true },
  { name: "phone", type: "tel", nullable: true },
  { name: "address", type: "text", nullable: true, wide: true },
] as const;

/** Catálogos de /admin/<resource>: cada entrada refleja el esquema Zod del backend (apps/api catalogs.config.ts). */
export const CRUD_REGISTRY: Record<string, CrudDef> = {
  warehouses: {
    resource: "warehouses", permission: "admin:warehouses", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name", sort: true }, { key: "allowNegativeStock", type: "bool" }, { key: "isActive", type: "bool" }],
    fields: [code, name, { name: "address", type: "text", nullable: true, wide: true }, { name: "allowNegativeStock", type: "boolean" }, active],
  },
  categories: {
    resource: "categories", permission: "admin:categories", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name", sort: true }, { key: "marginDefault", type: "decimal" }],
    fields: [code, name, { name: "parentId", type: "ref", resource: "categories", labelKey: (r) => `${r.code} — ${r.name}`, nullable: true }, { name: "marginDefault", type: "decimal", nullable: true }],
  },
  units: {
    resource: "units", permission: "admin:units", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name", sort: true }],
    fields: [code, name],
  },
  taxes: {
    resource: "taxes", permission: "admin:taxes", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name" }, { key: "kind", type: "enum" }, { key: "rate", type: "decimal" }, { key: "validFrom", type: "date", sort: true }, { key: "validTo", type: "date" }, { key: "isActive", type: "bool" }],
    fields: [
      code, name,
      { name: "kind", type: "select", options: ["VAT", "EXEMPT", "EXONERATED", "IGTF"], required: true, default: "VAT" },
      { name: "rate", type: "decimal", required: true, hint: "%" },
      { name: "validFrom", type: "date", required: true },
      { name: "validTo", type: "date", nullable: true },
      active,
    ],
  },
  "price-lists": {
    resource: "price-lists", permission: "admin:price-lists", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name" }, { key: "isDefault", type: "bool" }],
    fields: [code, name, { name: "currencyId", type: "ref", resource: "currencies", labelKey: (r) => `${r.code} — ${r.name}`, required: true }, { name: "isDefault", type: "boolean" }],
  },
  zones: {
    resource: "zones", permission: "admin:zones", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name", sort: true }],
    fields: [code, name, { name: "parentId", type: "ref", resource: "zones", labelKey: (r) => `${r.code} — ${r.name}`, nullable: true }],
  },
  sellers: {
    resource: "sellers", permission: "admin:sellers", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name", sort: true }, { key: "commissionRate", type: "decimal" }, { key: "isActive", type: "bool" }],
    fields: [
      code, name,
      { name: "commissionRate", type: "decimal", default: "0", hint: "%" },
      { name: "zoneId", type: "ref", resource: "zones", labelKey: (r) => `${r.code} — ${r.name}`, nullable: true },
      { name: "monthlyGoal", type: "decimal", nullable: true },
      active,
    ],
  },
  suppliers: {
    resource: "suppliers", permission: "admin:suppliers", softDelete: true, defaultSort: "legalName",
    columns: [{ key: "rif", sort: true }, { key: "legalName", sort: true }, { key: "creditDays", type: "int" }, { key: "retentionIvaPct", type: "decimal" }, { key: "isActive", type: "bool" }],
    fields: [
      { name: "rif", type: "text", required: true, placeholder: "J-12345678-9" },
      { name: "legalName", type: "text", required: true },
      { name: "tradeName", type: "text", nullable: true },
      { name: "personType", type: "select", options: ["LEGAL", "NATURAL"], default: "LEGAL" },
      { name: "isSpecialTaxpayer", type: "boolean" },
      { name: "retentionIvaPct", type: "decimal", default: "0", hint: "% (75 / 100)" },
      { name: "isIslrSubject", type: "boolean" },
      { name: "creditDays", type: "int", default: "0" },
      { name: "zoneId", type: "ref", resource: "zones", labelKey: (r) => `${r.code} — ${r.name}`, nullable: true },
      ...contact, active,
    ],
  },
  customers: {
    resource: "customers", permission: "admin:customers", softDelete: true, defaultSort: "legalName",
    columns: [{ key: "rif", sort: true }, { key: "legalName", sort: true }, { key: "creditLimit", type: "decimal" }, { key: "creditDays", type: "int" }, { key: "isActive", type: "bool" }],
    fields: [
      { name: "rif", type: "text", required: true, placeholder: "J-12345678-9" },
      { name: "legalName", type: "text", required: true },
      { name: "tradeName", type: "text", nullable: true },
      { name: "personType", type: "select", options: ["LEGAL", "NATURAL"], default: "LEGAL" },
      { name: "isSpecialTaxpayer", type: "boolean" },
      { name: "retentionIvaPct", type: "decimal", default: "0", hint: "% (75 / 100)" },
      { name: "priceListId", type: "ref", resource: "price-lists", labelKey: (r) => `${r.code} — ${r.name}`, nullable: true },
      { name: "creditLimit", type: "decimal", default: "0" },
      { name: "creditDays", type: "int", default: "0" },
      { name: "sellerId", type: "ref", resource: "sellers", labelKey: (r) => `${r.code} — ${r.name}`, nullable: true },
      { name: "zoneId", type: "ref", resource: "zones", labelKey: (r) => `${r.code} — ${r.name}`, nullable: true },
      ...contact, active,
    ],
  },
  "payment-methods": {
    resource: "payment-methods", permission: "admin:payment-methods", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name" }, { key: "type", type: "enum" }, { key: "requiresReference", type: "bool" }, { key: "appliesIgtf", type: "bool" }, { key: "isActive", type: "bool" }],
    fields: [
      code, name,
      { name: "type", type: "select", required: true, options: ["CASH", "TRANSFER", "MOBILE_PAYMENT", "CARD", "ZELLE", "CHECK", "WITHHOLDING", "CREDIT"] },
      { name: "currencyId", type: "ref", resource: "currencies", labelKey: (r) => `${r.code} — ${r.name}`, nullable: true },
      { name: "bankAccountId", type: "ref", resource: "bank-accounts", labelKey: (r) => `${r.name} (${r.number})`, nullable: true },
      { name: "requiresReference", type: "boolean" }, { name: "appliesIgtf", type: "boolean" }, active,
    ],
  },
  "operation-types": {
    resource: "operation-types", permission: "admin:operation-types", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name" }, { key: "docType" }, { key: "inventoryEffect", type: "enum" }, { key: "isActive", type: "bool" }],
    fields: [
      code, name, { name: "docType", type: "text", required: true },
      { name: "inventoryEffect", type: "select", options: ["IN", "OUT", "NONE"], default: "NONE" },
      { name: "affectsReceivable", type: "boolean" }, { name: "affectsPayable", type: "boolean" }, { name: "affectsBank", type: "boolean" },
      { name: "requiresFiscalNumber", type: "boolean" }, { name: "series", type: "text", maxLength: 5 }, active,
    ],
  },
  "movement-reasons": {
    resource: "movement-reasons", permission: "admin:movement-reasons", softDelete: true, defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name" }, { key: "kind", type: "enum" }, { key: "isActive", type: "bool" }],
    fields: [code, name, { name: "kind", type: "select", required: true, options: ["CHARGE", "DISCHARGE", "ADJUSTMENT"] }, active],
  },
  "bank-accounts": {
    resource: "bank-accounts", permission: "admin:bank-accounts", softDelete: true, defaultSort: "name",
    columns: [{ key: "name", sort: true }, { key: "number" }, { key: "accountType", type: "enum" }, { key: "openingBalance", type: "decimal" }, { key: "overdraftLimit", type: "decimal" }, { key: "isActive", type: "bool" }],
    fields: [
      { name: "bankId", type: "ref", resource: "banks", labelKey: (r) => `${r.code} — ${r.name}`, required: true },
      name, { name: "number", type: "text", required: true, maxLength: 30 },
      { name: "currencyId", type: "ref", resource: "currencies", labelKey: (r) => `${r.code} — ${r.name}`, required: true },
      { name: "accountType", type: "select", options: ["CHECKING", "SAVINGS", "CASH"], default: "CHECKING" },
      { name: "openingBalance", type: "decimal", default: "0" }, { name: "overdraftLimit", type: "decimal", default: "0" }, active,
    ],
    immutableOnEdit: ["bankId", "currencyId", "openingBalance"],
  },
  currencies: {
    resource: "currencies", permission: "admin:currencies", defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name" }, { key: "symbol" }, { key: "decimals", type: "int" }],
    fields: [{ name: "code", type: "text", required: true, maxLength: 3 }, name, { name: "symbol", type: "text", required: true, maxLength: 5 }, { name: "decimals", type: "int", default: "2" }],
  },
  banks: {
    resource: "banks", permission: "admin:banks", defaultSort: "code",
    columns: [{ key: "code", sort: true }, { key: "name", sort: true }],
    fields: [{ name: "code", type: "text", required: true, maxLength: 4, placeholder: "0102" }, name],
  },
};
