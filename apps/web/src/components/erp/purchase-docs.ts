export interface PurchaseDocMeta {
  slug: string;
  api: string;
  permission: string;
  type: "QUOTE" | "ORDER" | "DELIVERY_NOTE" | "DELIVERY_NOTE_RETURN" | "PURCHASE" | "PURCHASE_RETURN";
  /** Documento origen (devoluciones): slug del padre. */
  parentSlug?: string;
}

export const PURCHASE_DOCS: Record<string, PurchaseDocMeta> = {
  quotes: { slug: "quotes", api: "/purchases/quotes", permission: "purchases:quotes", type: "QUOTE" },
  orders: { slug: "orders", api: "/purchases/orders", permission: "purchases:orders", type: "ORDER" },
  "delivery-notes": { slug: "delivery-notes", api: "/purchases/delivery-notes", permission: "purchases:delivery-notes", type: "DELIVERY_NOTE" },
  invoices: { slug: "invoices", api: "/purchases", permission: "purchases:invoices", type: "PURCHASE" },
  "delivery-note-returns": { slug: "delivery-note-returns", api: "/purchases/delivery-note-returns", permission: "purchases:delivery-note-returns", type: "DELIVERY_NOTE_RETURN", parentSlug: "delivery-notes" },
  returns: { slug: "returns", api: "/purchases/returns", permission: "purchases:returns", type: "PURCHASE_RETURN", parentSlug: "invoices" },
};

/** Tipo de documento de la API → slug de la UI (para enlaces entre documentos). */
export const SLUG_BY_TYPE: Record<string, string> = Object.fromEntries(Object.values(PURCHASE_DOCS).map((d) => [d.type, d.slug]));
