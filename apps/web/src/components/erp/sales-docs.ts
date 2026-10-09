export interface SalesDocMeta {
  slug: string;
  api: string;
  permission: string;
  type: "QUOTE" | "BUDGET" | "ORDER" | "INVOICE" | "CREDIT_NOTE";
}

export const SALES_DOCS: Record<string, SalesDocMeta> = {
  quotes: { slug: "quotes", api: "/sales/quotes", permission: "sales:quotes", type: "QUOTE" },
  budgets: { slug: "budgets", api: "/sales/budgets", permission: "sales:budgets", type: "BUDGET" },
  orders: { slug: "orders", api: "/sales/orders", permission: "sales:orders", type: "ORDER" },
  invoices: { slug: "invoices", api: "/sales/invoices", permission: "sales:invoices", type: "INVOICE" },
  "credit-notes": { slug: "credit-notes", api: "/sales/credit-notes", permission: "sales:credit-notes", type: "CREDIT_NOTE" },
};

export const SALES_SLUG_BY_TYPE: Record<string, string> = Object.fromEntries(Object.values(SALES_DOCS).map((d) => [d.type, d.slug]));
