/** Estructura del menú lateral (erp-v3 §14.1). Cada ítem se filtra por permiso y feature flag. */
export interface NavLeaf {
  key: string;
  path: string;
  /** Permiso requerido (por defecto, ninguno). */
  perm?: string;
  feature?: string;
  /** Visible solo si el usuario puede crear empresas (administrador global o de cliente). */
  flag?: "canCreateCompanies" | "superAdmin";
}
export interface NavSection {
  key: string;
  icon: "grid" | "box" | "cube" | "cart" | "settings";
  items: NavLeaf[];
}

const admin = (key: string, resource = key): NavLeaf => ({ key, path: `/admin/${resource}`, perm: `admin:${resource}:read` });

export const NAV: NavSection[] = [
  {
    key: "administration",
    icon: "box",
    items: [
      admin("products"), admin("categories"), admin("units"), admin("warehouses"),
      admin("suppliers"), admin("customers"), admin("zones"), admin("sellers"),
      admin("price-lists"), admin("taxes"), admin("currencies"), admin("exchange-rates"),
      admin("payment-methods"), admin("bank-accounts"), admin("banks"), admin("movement-reasons"), admin("operation-types"),
    ],
  },
  {
    key: "inventory",
    icon: "cube",
    items: [
      { key: "stock", path: "/inventory/stock", perm: "inventory:stock:read" },
      { key: "kardex", path: "/inventory/kardex", perm: "inventory:kardex:read" },
      { key: "valuation", path: "/inventory/valuation", perm: "inventory:valuation:read" },
      { key: "transfers", path: "/inventory/transfers", perm: "inventory:transfers:read" },
      { key: "charges", path: "/inventory/charges", perm: "inventory:charges:read" },
      { key: "discharges", path: "/inventory/discharges", perm: "inventory:discharges:read" },
      { key: "adjustments", path: "/inventory/adjustments", perm: "inventory:adjustments:read" },
      { key: "cost-adjustments", path: "/inventory/cost-adjustments", perm: "inventory:cost-adjustments:read" },
      { key: "serials", path: "/inventory/serials", perm: "inventory:serials:read", feature: "serials" },
      { key: "periods", path: "/inventory/periods", perm: "inventory:periods:read" },
    ],
  },
  {
    key: "purchases",
    icon: "cart",
    items: [
      { key: "quotes", path: "/purchases/quotes", perm: "purchases:quotes:read" },
      { key: "orders", path: "/purchases/orders", perm: "purchases:orders:read" },
      { key: "delivery-notes", path: "/purchases/delivery-notes", perm: "purchases:delivery-notes:read" },
      { key: "invoices", path: "/purchases/invoices", perm: "purchases:invoices:read" },
      { key: "delivery-note-returns", path: "/purchases/delivery-note-returns", perm: "purchases:delivery-note-returns:read" },
      { key: "returns", path: "/purchases/returns", perm: "purchases:returns:read" },
    ],
  },
  {
    key: "settings",
    icon: "settings",
    items: [
      { key: "company", path: "/settings/company", perm: "security:companies:read" },
      { key: "companies", path: "/settings/companies", flag: "canCreateCompanies" },
      { key: "organizations", path: "/settings/organizations", flag: "superAdmin" },
      { key: "sequences", path: "/settings/sequences", perm: "admin:sequences:read" },
      { key: "users", path: "/settings/users", perm: "security:users:read" },
      { key: "roles", path: "/settings/roles", perm: "security:roles:read" },
    ],
  },
];
