-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "rif" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trade_name" TEXT,
    "fiscal_address" TEXT,
    "base_currency_id" UUID NOT NULL,
    "valuation_currency_id" UUID NOT NULL,
    "is_special_taxpayer" BOOLEAN NOT NULL DEFAULT false,
    "is_vat_withholding_agent" BOOLEAN NOT NULL DEFAULT false,
    "is_igtf_collector" BOOLEAN NOT NULL DEFAULT false,
    "features" JSONB NOT NULL DEFAULT '{"lots":false,"serials":false,"expiry":false,"offline":false}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_companies" (
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_companies_pkey" PRIMARY KEY ("user_id","company_id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "company_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_code" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("company_id","role_id","permission_code")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","company_id","role_id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "company_id" UUID,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "replaced_by_id" UUID,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID,
    "user_id" UUID,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "action" TEXT NOT NULL,
    "diff" JSONB,
    "ip" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "series" TEXT NOT NULL DEFAULT 'A',
    "prefix" TEXT NOT NULL DEFAULT '',
    "next_number" BIGINT NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "company_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("company_id","key")
);

-- CreateTable
CREATE TABLE "settings" (
    "company_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("company_id","key")
);

-- CreateTable
CREATE TABLE "currencies" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 2,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "currency_id" UUID NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "date" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "banks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'VAT',
    "rate" DECIMAL(7,4) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "margin_default" DECIMAL(7,4),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" UUID,
    "unit_id" UUID NOT NULL,
    "tax_id" UUID,
    "tracking_mode" TEXT NOT NULL DEFAULT 'NONE',
    "has_expiry" BOOLEAN NOT NULL DEFAULT false,
    "is_service" BOOLEAN NOT NULL DEFAULT false,
    "min_stock" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "max_stock" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_barcodes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "barcode" TEXT NOT NULL,

    CONSTRAINT "product_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_references" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "ref_type" TEXT NOT NULL DEFAULT 'OEM',
    "code" TEXT NOT NULL,
    "brand" TEXT,

    CONSTRAINT "product_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_uoms" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "factor" DECIMAL(18,4) NOT NULL,
    "barcode" TEXT,

    CONSTRAINT "product_uoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_lists" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency_id" UUID NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_list_id" UUID NOT NULL,
    "price" DECIMAL(18,4) NOT NULL,
    "valid_from" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sellers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "user_id" UUID,
    "commission_rate" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "zone_id" UUID,
    "monthly_goal" DECIMAL(18,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "sellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "rif" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trade_name" TEXT,
    "person_type" TEXT NOT NULL DEFAULT 'LEGAL',
    "is_special_taxpayer" BOOLEAN NOT NULL DEFAULT false,
    "retention_iva_pct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "is_islr_subject" BOOLEAN NOT NULL DEFAULT false,
    "credit_days" INTEGER NOT NULL DEFAULT 0,
    "zone_id" UUID,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_suppliers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_sku" TEXT,
    "last_cost" DECIMAL(18,6),
    "lead_time_days" INTEGER,

    CONSTRAINT "product_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "rif" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "trade_name" TEXT,
    "person_type" TEXT NOT NULL DEFAULT 'LEGAL',
    "is_special_taxpayer" BOOLEAN NOT NULL DEFAULT false,
    "retention_iva_pct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "price_list_id" UUID,
    "credit_limit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit_days" INTEGER NOT NULL DEFAULT 0,
    "seller_id" UUID,
    "zone_id" UUID,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "currency_id" UUID NOT NULL,
    "account_type" TEXT NOT NULL DEFAULT 'CHECKING',
    "opening_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "currency_id" UUID,
    "requires_reference" BOOLEAN NOT NULL DEFAULT false,
    "applies_igtf" BOOLEAN NOT NULL DEFAULT false,
    "bank_account_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_types" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "inventory_effect" TEXT NOT NULL DEFAULT 'NONE',
    "affects_receivable" BOOLEAN NOT NULL DEFAULT false,
    "affects_payable" BOOLEAN NOT NULL DEFAULT false,
    "affects_bank" BOOLEAN NOT NULL DEFAULT false,
    "requires_fiscal_number" BOOLEAN NOT NULL DEFAULT false,
    "series" TEXT NOT NULL DEFAULT 'A',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "operation_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movement_reasons" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "movement_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "seq" BIGSERIAL NOT NULL,
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "lot_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,6) NOT NULL,
    "total_cost" DECIMAL(18,4) NOT NULL,
    "qty_after" DECIMAL(18,4) NOT NULL,
    "warehouse_qty_after" DECIMAL(18,4) NOT NULL,
    "avg_cost_after" DECIMAL(18,6) NOT NULL,
    "doc_type" TEXT NOT NULL,
    "doc_id" UUID NOT NULL,
    "doc_line_id" UUID,
    "reversal_of" UUID,
    "posted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_stock" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reserved_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_costs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "avg_cost" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "cost_pending" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lots" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_no" TEXT NOT NULL,
    "expiry_date" DATE,
    "supplier_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_lot_balances" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_lot_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "number" TEXT,
    "doc_date" DATE NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "to_warehouse_id" UUID,
    "reason_id" UUID,
    "notes" TEXT,
    "confirmed_at" TIMESTAMPTZ,
    "confirmed_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "cancel_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "inventory_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_document_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(18,6),
    "system_qty" DECIMAL(18,4),
    "counted_qty" DECIMAL(18,4),
    "difference" DECIMAL(18,4),
    "new_avg_cost" DECIMAL(18,6),
    "lot_no" TEXT,
    "expiry_date" DATE,
    "notes" TEXT,

    CONSTRAINT "inventory_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_periods" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMPTZ,
    "closed_by" UUID,

    CONSTRAINT "inventory_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_period_snapshots" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "avg_cost" DECIMAL(18,6) NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "inventory_period_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "number" TEXT,
    "doc_date" DATE NOT NULL,
    "due_date" DATE,
    "expires_at" DATE,
    "supplier_id" UUID NOT NULL,
    "warehouse_id" UUID,
    "currency_id" UUID NOT NULL,
    "exchange_rate" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "payment_condition" TEXT NOT NULL DEFAULT 'CASH',
    "credit_days" INTEGER NOT NULL DEFAULT 0,
    "supplier_doc_no" TEXT,
    "supplier_control_no" TEXT,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxable_base" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "exempt_base" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total_base" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "confirmed_at" TIMESTAMPTZ,
    "confirmed_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "cancel_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "purchase_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_document_lines" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,6) NOT NULL,
    "discount_pct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "tax_id" UUID,
    "tax_rate" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "net" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lot_no" TEXT,
    "expiry_date" DATE,

    CONSTRAINT "purchase_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_links" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "parent_type" TEXT NOT NULL,
    "parent_id" UUID NOT NULL,
    "child_type" TEXT NOT NULL,
    "child_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_link_lines" (
    "link_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "parent_line_id" UUID NOT NULL,
    "child_line_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "document_link_lines_pkey" PRIMARY KEY ("link_id","parent_line_id","child_line_id")
);

-- CreateTable
CREATE TABLE "document_cancellations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "doc_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payable_entries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "company_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "purchase_document_id" UUID NOT NULL,
    "entry_type" TEXT NOT NULL DEFAULT 'INVOICE',
    "due_date" DATE NOT NULL,
    "currency_id" UUID NOT NULL,
    "exchange_rate" DECIMAL(18,8) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "balance" DECIMAL(18,4) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payable_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_rif_key" ON "companies"("rif");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_company_id_code_key" ON "roles"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "roles_company_id_id_key" ON "roles"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_entity_entity_id_idx" ON "audit_logs"("company_id", "entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_created_at_idx" ON "audit_logs"("company_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_sequences_company_id_doc_type_series_key" ON "document_sequences"("company_id", "doc_type", "series");

-- CreateIndex
CREATE UNIQUE INDEX "currencies_code_key" ON "currencies"("code");

-- CreateIndex
CREATE INDEX "exchange_rates_currency_id_date_created_at_idx" ON "exchange_rates"("currency_id", "date", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "banks_code_key" ON "banks"("code");

-- CreateIndex
CREATE UNIQUE INDEX "taxes_company_id_code_valid_from_key" ON "taxes"("company_id", "code", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "taxes_company_id_id_key" ON "taxes"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "units_company_id_code_key" ON "units"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "units_company_id_id_key" ON "units"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_company_id_code_key" ON "warehouses"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_company_id_id_key" ON "warehouses"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_company_id_code_key" ON "categories"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "categories_company_id_id_key" ON "categories"("company_id", "id");

-- CreateIndex
CREATE INDEX "products_company_id_name_idx" ON "products"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_company_id_sku_key" ON "products"("company_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_company_id_id_key" ON "products"("company_id", "id");

-- CreateIndex
CREATE INDEX "product_barcodes_company_id_product_id_idx" ON "product_barcodes"("company_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcodes_company_id_barcode_key" ON "product_barcodes"("company_id", "barcode");

-- CreateIndex
CREATE INDEX "product_references_company_id_code_idx" ON "product_references"("company_id", "code");

-- CreateIndex
CREATE INDEX "product_references_company_id_product_id_idx" ON "product_references"("company_id", "product_id");

-- CreateIndex
CREATE INDEX "product_uoms_company_id_product_id_idx" ON "product_uoms"("company_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_company_id_code_key" ON "price_lists"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_company_id_id_key" ON "price_lists"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_prices_company_id_product_id_price_list_id_valid_fr_key" ON "product_prices"("company_id", "product_id", "price_list_id", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "zones_company_id_code_key" ON "zones"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "zones_company_id_id_key" ON "zones"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sellers_company_id_code_key" ON "sellers"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "sellers_company_id_id_key" ON "sellers"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_company_id_rif_key" ON "suppliers"("company_id", "rif");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_company_id_id_key" ON "suppliers"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_suppliers_company_id_product_id_supplier_id_key" ON "product_suppliers"("company_id", "product_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_company_id_rif_key" ON "customers"("company_id", "rif");

-- CreateIndex
CREATE UNIQUE INDEX "customers_company_id_id_key" ON "customers"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_company_id_number_key" ON "bank_accounts"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_company_id_id_key" ON "bank_accounts"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_company_id_code_key" ON "payment_methods"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_company_id_id_key" ON "payment_methods"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "operation_types_company_id_code_key" ON "operation_types"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "operation_types_company_id_id_key" ON "operation_types"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "movement_reasons_company_id_code_key" ON "movement_reasons"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "movement_reasons_company_id_id_key" ON "movement_reasons"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_seq_key" ON "inventory_movements"("seq");

-- CreateIndex
CREATE INDEX "inventory_movements_company_id_product_id_seq_idx" ON "inventory_movements"("company_id", "product_id", "seq");

-- CreateIndex
CREATE INDEX "inventory_movements_company_id_warehouse_id_product_id_idx" ON "inventory_movements"("company_id", "warehouse_id", "product_id");

-- CreateIndex
CREATE INDEX "inventory_movements_company_id_doc_type_doc_id_idx" ON "inventory_movements"("company_id", "doc_type", "doc_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_company_id_product_id_warehouse_id_key" ON "inventory_stock"("company_id", "product_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_costs_company_id_product_id_key" ON "product_costs"("company_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "lots_company_id_product_id_lot_no_key" ON "lots"("company_id", "product_id", "lot_no");

-- CreateIndex
CREATE UNIQUE INDEX "lots_company_id_id_key" ON "lots"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lot_balances_company_id_product_id_warehouse_id_l_key" ON "inventory_lot_balances"("company_id", "product_id", "warehouse_id", "lot_id");

-- CreateIndex
CREATE INDEX "inventory_documents_company_id_doc_type_status_idx" ON "inventory_documents"("company_id", "doc_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_company_id_id_key" ON "inventory_documents"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_documents_company_id_doc_type_number_key" ON "inventory_documents"("company_id", "doc_type", "number");

-- CreateIndex
CREATE INDEX "inventory_document_lines_company_id_document_id_idx" ON "inventory_document_lines"("company_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_document_lines_company_id_id_key" ON "inventory_document_lines"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_periods_company_id_year_month_key" ON "inventory_periods"("company_id", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_periods_company_id_id_key" ON "inventory_periods"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_period_snapshots_company_id_period_id_product_id_key" ON "inventory_period_snapshots"("company_id", "period_id", "product_id");

-- CreateIndex
CREATE INDEX "purchase_documents_company_id_doc_type_status_idx" ON "purchase_documents"("company_id", "doc_type", "status");

-- CreateIndex
CREATE INDEX "purchase_documents_company_id_supplier_id_idx" ON "purchase_documents"("company_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_documents_company_id_id_key" ON "purchase_documents"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_documents_company_id_doc_type_number_key" ON "purchase_documents"("company_id", "doc_type", "number");

-- CreateIndex
CREATE INDEX "purchase_document_lines_company_id_document_id_idx" ON "purchase_document_lines"("company_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_document_lines_company_id_id_key" ON "purchase_document_lines"("company_id", "id");

-- CreateIndex
CREATE INDEX "document_links_company_id_child_id_idx" ON "document_links"("company_id", "child_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_links_company_id_parent_id_child_id_key" ON "document_links"("company_id", "parent_id", "child_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_links_company_id_id_key" ON "document_links"("company_id", "id");

-- CreateIndex
CREATE INDEX "document_link_lines_company_id_parent_line_id_idx" ON "document_link_lines"("company_id", "parent_line_id");

-- CreateIndex
CREATE INDEX "document_link_lines_company_id_child_line_id_idx" ON "document_link_lines"("company_id", "child_line_id");

-- CreateIndex
CREATE INDEX "document_cancellations_company_id_doc_id_idx" ON "document_cancellations"("company_id", "doc_id");

-- CreateIndex
CREATE INDEX "payable_entries_company_id_supplier_id_status_idx" ON "payable_entries"("company_id", "supplier_id", "status");

-- CreateIndex
CREATE INDEX "payable_entries_company_id_purchase_document_id_idx" ON "payable_entries"("company_id", "purchase_document_id");

