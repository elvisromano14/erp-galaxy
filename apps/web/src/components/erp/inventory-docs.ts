export type InvDocSlug = "transfers" | "charges" | "discharges" | "adjustments" | "cost-adjustments";

export interface InvDocMeta {
  slug: InvDocSlug;
  api: string;
  permission: string;
  type: "TRANSFER" | "CHARGE" | "DISCHARGE" | "ADJUSTMENT" | "COST_ADJUSTMENT";
  reasonKind?: "CHARGE" | "DISCHARGE" | "ADJUSTMENT";
}

export const INV_DOCS: Record<string, InvDocMeta> = {
  transfers: { slug: "transfers", api: "/inventory/transfers", permission: "inventory:transfers", type: "TRANSFER" },
  charges: { slug: "charges", api: "/inventory/charges", permission: "inventory:charges", type: "CHARGE", reasonKind: "CHARGE" },
  discharges: { slug: "discharges", api: "/inventory/discharges", permission: "inventory:discharges", type: "DISCHARGE", reasonKind: "DISCHARGE" },
  adjustments: { slug: "adjustments", api: "/inventory/adjustments", permission: "inventory:adjustments", type: "ADJUSTMENT", reasonKind: "ADJUSTMENT" },
  "cost-adjustments": { slug: "cost-adjustments", api: "/inventory/cost-adjustments", permission: "inventory:cost-adjustments", type: "COST_ADJUSTMENT" },
};
