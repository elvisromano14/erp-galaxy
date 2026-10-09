/** Catálogo de permisos `modulo:recurso:accion` (erp-v3 §12.2) y plantillas de roles. */
const CRUD = ['read', 'create', 'update', 'delete'];
const DOC = ['read', 'create', 'update', 'confirm', 'cancel'];

export const ADMIN_RESOURCES = [
  'warehouses', 'categories', 'products', 'suppliers', 'zones', 'sellers', 'customers',
  'payment-methods', 'operation-types', 'units', 'price-lists', 'taxes', 'currencies',
  'exchange-rates', 'movement-reasons', 'banks', 'bank-accounts',
] as const;
export const INVENTORY_DOCS = ['transfers', 'charges', 'discharges', 'adjustments', 'cost-adjustments'] as const;
export const SALES_DOCS = ['quotes', 'budgets', 'orders', 'invoices', 'credit-notes', 'debit-notes'] as const;
export const PURCHASE_DOCS = ['quotes', 'orders', 'delivery-notes', 'delivery-note-returns', 'invoices', 'returns'] as const;

export const REPORT_CATEGORIES = ['inventory', 'categories', 'suppliers', 'purchases', 'customers', 'sellers', 'sales', 'fiscal'] as const;
const build = (module: string, resource: string, actions: string[]) => actions.map(a => `${module}:${resource}:${a}`);

export const ALL_PERMISSIONS: string[] = [
  ...ADMIN_RESOURCES.flatMap(r => build('admin', r, CRUD)),
  ...build('security', 'users', ['read', 'create', 'update']),
  ...build('security', 'roles', ['read', 'create', 'update']),
  ...build('security', 'companies', ['read', 'update']),
  ...build('security', 'audit', ['read']),
  ...build('admin', 'sequences', ['read', 'update']),
  ...build('admin', 'import', ['create']),
  ...build('inventory', 'stock', ['read']),
  ...build('inventory', 'serials', ['read']),
  ...build('inventory', 'kardex', ['read']),
  ...build('inventory', 'valuation', ['read']),
  ...build('inventory', 'periods', ['read', 'close']),
  ...INVENTORY_DOCS.flatMap(r => build('inventory', r, DOC)),
  ...PURCHASE_DOCS.flatMap(r => build('purchases', r, DOC)),
  ...SALES_DOCS.flatMap(r => build('sales', r, DOC)),
  ...build('sales', 'documents', ['read-all']),
  'sales:orders:credit-override',
  ...build('payables', 'entries', ['read']),
  ...build('treasury', 'payments', ['read', 'create', 'cancel']),
  ...build('fiscal', 'withholdings', ['read', 'create', 'cancel']),
  ...build('treasury', 'receipts', ['read', 'create', 'cancel']),
  ...build('treasury', 'receivables', ['read', 'create']),
  ...build('treasury', 'movements', ['read', 'create']),
  ...build('treasury', 'reconciliations', ['read', 'create']),
  ...REPORT_CATEGORIES.flatMap(c => build('reports', c, ['read'])),
];

const readCatalogs = ADMIN_RESOURCES.map(r => `admin:${r}:read`);

export const ROLE_TEMPLATES: Record<string, { name: string; permissions: string[] }> = {
  ADMIN: { name: 'Administrador', permissions: ALL_PERMISSIONS },
  GERENTE: { name: 'Gerente', permissions: ALL_PERMISSIONS.filter(p => !p.startsWith('security:companies:') && !p.startsWith('security:roles:')) },
  VENDEDOR: {
    name: 'Vendedor',
    // Ve y gestiona solo SUS documentos (sin 'sales:documents:read-all').
    permissions: [...readCatalogs, 'inventory:stock:read', ...SALES_DOCS.flatMap(r => build('sales', r, DOC)), 'admin:customers:create', 'admin:customers:update'],
  },
  ALMACENISTA: {
    name: 'Almacenista',
    permissions: [
      ...readCatalogs, 'inventory:stock:read', 'inventory:kardex:read', 'inventory:serials:read',
      ...INVENTORY_DOCS.flatMap(r => build('inventory', r, DOC)),
      'purchases:delivery-notes:read', 'purchases:delivery-notes:create', 'purchases:delivery-notes:confirm',
      'reports:inventory:read', 'reports:categories:read',
    ],
  },
  CAJERO: {
    name: 'Cajero',
    permissions: [...readCatalogs, ...SALES_DOCS.map(r => `sales:${r}:read`), 'sales:documents:read-all', ...build('sales', 'invoices', ['create', 'update', 'confirm']), 'treasury:receipts:read', 'treasury:receipts:create'],
  },
  CONTADOR: {
    name: 'Contador',
    permissions: ALL_PERMISSIONS.filter(p => p.endsWith(':read')).concat(['inventory:periods:close']),
  },
  COMPRAS: {
    name: 'Compras',
    permissions: [
      ...readCatalogs, 'inventory:stock:read', 'inventory:kardex:read', 'payables:entries:read',
      ...PURCHASE_DOCS.flatMap(r => build('purchases', r, DOC)), 'treasury:payments:read',
      'admin:suppliers:create', 'admin:suppliers:update',
      'reports:suppliers:read', 'reports:purchases:read', 'reports:inventory:read', 'reports:categories:read',
    ],
  },
};
