-- 0002: CHECKs, FK compuestas multiempresa, triggers, RLS y permisos por rol.
-- Escrito a mano (Prisma no modela nada de esto). NO ejecutar `prisma migrate dev`.

-- ───────────── updated_at automático (clock_timestamp) ─────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at' AND table_name <> '_prisma_migrations'
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- ───────────── Ledgers inmutables ─────────────
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % es de solo inserción (%).', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_movements_immutable BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_exchange_rates_immutable BEFORE UPDATE OR DELETE ON exchange_rates
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────── CHECK (enums como text) ─────────────
ALTER TABLE products ADD CONSTRAINT ck_products_tracking CHECK (tracking_mode IN ('NONE','LOT','SERIAL'));
ALTER TABLE products ADD CONSTRAINT ck_products_expiry CHECK (NOT has_expiry OR tracking_mode = 'LOT');
ALTER TABLE products ADD CONSTRAINT ck_products_service CHECK (NOT is_service OR tracking_mode = 'NONE');
ALTER TABLE product_references ADD CONSTRAINT ck_product_refs_type CHECK (ref_type IN ('OEM','EQUIVALENT','ALTERNATE'));
ALTER TABLE product_uoms ADD CONSTRAINT ck_product_uoms_factor CHECK (factor > 0);
ALTER TABLE product_prices ADD CONSTRAINT ck_product_prices_nonneg CHECK (price >= 0);
ALTER TABLE taxes ADD CONSTRAINT ck_taxes_kind CHECK (kind IN ('VAT','EXEMPT','EXONERATED','IGTF'));
ALTER TABLE taxes ADD CONSTRAINT ck_taxes_rate CHECK (rate >= 0 AND rate <= 100);
ALTER TABLE exchange_rates ADD CONSTRAINT ck_exchange_rates_positive CHECK (rate > 0);
ALTER TABLE suppliers ADD CONSTRAINT ck_suppliers_person CHECK (person_type IN ('LEGAL','NATURAL'));
ALTER TABLE customers ADD CONSTRAINT ck_customers_person CHECK (person_type IN ('LEGAL','NATURAL'));
ALTER TABLE payment_methods ADD CONSTRAINT ck_payment_methods_type CHECK (type IN ('CASH','TRANSFER','MOBILE_PAYMENT','CARD','ZELLE','CHECK','WITHHOLDING','CREDIT'));
ALTER TABLE operation_types ADD CONSTRAINT ck_operation_types_effect CHECK (inventory_effect IN ('IN','OUT','NONE'));
ALTER TABLE movement_reasons ADD CONSTRAINT ck_movement_reasons_kind CHECK (kind IN ('CHARGE','DISCHARGE','ADJUSTMENT'));
ALTER TABLE bank_accounts ADD CONSTRAINT ck_bank_accounts_type CHECK (account_type IN ('CHECKING','SAVINGS','CASH'));

ALTER TABLE inventory_documents ADD CONSTRAINT ck_inv_docs_type CHECK (doc_type IN ('TRANSFER','CHARGE','DISCHARGE','ADJUSTMENT','COST_ADJUSTMENT'));
ALTER TABLE inventory_documents ADD CONSTRAINT ck_inv_docs_status CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED'));
ALTER TABLE inventory_documents ADD CONSTRAINT ck_inv_docs_transfer CHECK (
  (doc_type = 'TRANSFER' AND to_warehouse_id IS NOT NULL AND to_warehouse_id <> warehouse_id)
  OR (doc_type <> 'TRANSFER' AND to_warehouse_id IS NULL));
ALTER TABLE inventory_documents ADD CONSTRAINT ck_inv_docs_number CHECK (status = 'DRAFT' OR number IS NOT NULL);
ALTER TABLE inventory_document_lines ADD CONSTRAINT ck_inv_lines_qty CHECK (quantity >= 0);
ALTER TABLE inventory_periods ADD CONSTRAINT ck_inv_periods CHECK (month BETWEEN 1 AND 12 AND status IN ('OPEN','CLOSED'));
ALTER TABLE inventory_stock ADD CONSTRAINT ck_inv_stock_reserved CHECK (reserved_qty >= 0);

ALTER TABLE purchase_documents ADD CONSTRAINT ck_purch_docs_type CHECK (doc_type IN ('QUOTE','ORDER','DELIVERY_NOTE','DELIVERY_NOTE_RETURN','PURCHASE','PURCHASE_RETURN'));
ALTER TABLE purchase_documents ADD CONSTRAINT ck_purch_docs_status CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED','CONFIRMED','PARTIALLY_FULFILLED','FULFILLED','INVOICED','CANCELLED','CLOSED'));
ALTER TABLE purchase_documents ADD CONSTRAINT ck_purch_docs_cond CHECK (payment_condition IN ('CASH','CREDIT'));
ALTER TABLE purchase_documents ADD CONSTRAINT ck_purch_docs_number CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED') OR number IS NOT NULL);
ALTER TABLE purchase_documents ADD CONSTRAINT ck_purch_docs_rate CHECK (exchange_rate > 0);
ALTER TABLE purchase_document_lines ADD CONSTRAINT ck_purch_lines_qty CHECK (quantity > 0 AND unit_cost >= 0);
ALTER TABLE purchase_document_lines ADD CONSTRAINT ck_purch_lines_disc CHECK (discount_pct >= 0 AND discount_pct <= 100);
ALTER TABLE document_link_lines ADD CONSTRAINT ck_link_lines_qty CHECK (quantity > 0);
ALTER TABLE payable_entries ADD CONSTRAINT ck_payables_status CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','CANCELLED'));

-- ───────────── FK: company_id → companies(id) en toda tabla de negocio ─────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
      AND c.table_name NOT IN ('audit_logs','refresh_tokens')
  LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT fk_%s_company FOREIGN KEY (company_id) REFERENCES companies(id)', t, t);
  END LOOP;
END $$;

-- ───────────── FK compuestas (company_id, x_id) → (company_id, id): impiden cruzar empresas ─────────────
-- (hijo, columna, padre, on delete)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('categories','parent_id','categories',''),
    ('products','category_id','categories',''),
    ('products','unit_id','units',''),
    ('products','tax_id','taxes',''),
    ('product_barcodes','product_id','products',''),
    ('product_references','product_id','products',''),
    ('product_uoms','product_id','products',''),
    ('product_prices','product_id','products',''),
    ('product_prices','price_list_id','price_lists',''),
    ('zones','parent_id','zones',''),
    ('sellers','zone_id','zones',''),
    ('suppliers','zone_id','zones',''),
    ('product_suppliers','product_id','products',''),
    ('product_suppliers','supplier_id','suppliers',''),
    ('customers','price_list_id','price_lists',''),
    ('customers','seller_id','sellers',''),
    ('customers','zone_id','zones',''),
    ('payment_methods','bank_account_id','bank_accounts',''),
    ('role_permissions','role_id','roles','ON DELETE CASCADE'),
    ('user_roles','role_id','roles','ON DELETE CASCADE'),
    ('lots','product_id','products',''),
    ('lots','supplier_id','suppliers',''),
    ('inventory_movements','product_id','products',''),
    ('inventory_movements','warehouse_id','warehouses',''),
    ('inventory_movements','lot_id','lots',''),
    ('inventory_stock','product_id','products',''),
    ('inventory_stock','warehouse_id','warehouses',''),
    ('product_costs','product_id','products',''),
    ('inventory_lot_balances','product_id','products',''),
    ('inventory_lot_balances','warehouse_id','warehouses',''),
    ('inventory_lot_balances','lot_id','lots',''),
    ('inventory_documents','warehouse_id','warehouses',''),
    ('inventory_documents','to_warehouse_id','warehouses',''),
    ('inventory_documents','reason_id','movement_reasons',''),
    ('inventory_document_lines','document_id','inventory_documents','ON DELETE CASCADE'),
    ('inventory_document_lines','product_id','products',''),
    ('inventory_period_snapshots','period_id','inventory_periods',''),
    ('inventory_period_snapshots','product_id','products',''),
    ('purchase_documents','supplier_id','suppliers',''),
    ('purchase_documents','warehouse_id','warehouses',''),
    ('purchase_document_lines','document_id','purchase_documents','ON DELETE CASCADE'),
    ('purchase_document_lines','product_id','products',''),
    ('purchase_document_lines','tax_id','taxes',''),
    ('document_link_lines','link_id','document_links','ON DELETE CASCADE'),
    ('payable_entries','supplier_id','suppliers',''),
    ('payable_entries','purchase_document_id','purchase_documents','')
  ) AS v(child, col, parent, ondel)
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT fk_%s_%s FOREIGN KEY (company_id, %I) REFERENCES %I (company_id, id) %s',
      r.child, r.child, r.col, r.col, r.parent, r.ondel);
  END LOOP;
END $$;

-- ───────────── FK a catálogos globales / usuarios ─────────────
ALTER TABLE companies ADD CONSTRAINT fk_companies_base_cur FOREIGN KEY (base_currency_id) REFERENCES currencies(id);
ALTER TABLE companies ADD CONSTRAINT fk_companies_val_cur FOREIGN KEY (valuation_currency_id) REFERENCES currencies(id);
ALTER TABLE user_companies ADD CONSTRAINT fk_user_companies_user FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE user_roles ADD CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE role_permissions ADD CONSTRAINT fk_role_perm_perm FOREIGN KEY (permission_code) REFERENCES permissions(code);
ALTER TABLE refresh_tokens ADD CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE exchange_rates ADD CONSTRAINT fk_exchange_rates_cur FOREIGN KEY (currency_id) REFERENCES currencies(id);
ALTER TABLE price_lists ADD CONSTRAINT fk_price_lists_cur FOREIGN KEY (currency_id) REFERENCES currencies(id);
ALTER TABLE sellers ADD CONSTRAINT fk_sellers_user FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE bank_accounts ADD CONSTRAINT fk_bank_accounts_bank FOREIGN KEY (bank_id) REFERENCES banks(id);
ALTER TABLE bank_accounts ADD CONSTRAINT fk_bank_accounts_cur FOREIGN KEY (currency_id) REFERENCES currencies(id);
ALTER TABLE payment_methods ADD CONSTRAINT fk_payment_methods_cur FOREIGN KEY (currency_id) REFERENCES currencies(id);
ALTER TABLE purchase_documents ADD CONSTRAINT fk_purch_docs_cur FOREIGN KEY (currency_id) REFERENCES currencies(id);
ALTER TABLE payable_entries ADD CONSTRAINT fk_payables_cur FOREIGN KEY (currency_id) REFERENCES currencies(id);

-- Una sola lista de precios por defecto por empresa; un solo período por mes ya es UNIQUE.
CREATE UNIQUE INDEX uq_price_lists_default ON price_lists (company_id) WHERE is_default AND deleted_at IS NULL;
-- Códigos de barras/SKU activos únicos ya cubiertos por UNIQUE (company_id, ...).
CREATE INDEX ix_inventory_stock_wh ON inventory_stock (company_id, warehouse_id);
CREATE INDEX ix_pdl_product ON purchase_document_lines (company_id, product_id);

-- ───────────── RLS: aislamiento por empresa (falla cerrada si no hay contexto) ─────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
      AND c.table_name NOT IN ('user_companies','refresh_tokens','audit_logs')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- audit_logs: se escribe con o sin empresa (login), pero cada empresa solo lee lo suyo.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_logs FOR SELECT
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
CREATE POLICY audit_insert ON audit_logs FOR INSERT
  WITH CHECK (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- ───────────── Permisos por rol ─────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT USAGE ON SCHEMA public TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app;
    -- Ledgers: la aplicación nunca actualiza ni borra.
    REVOKE UPDATE, DELETE ON inventory_movements, audit_logs, exchange_rates FROM erp_app;
    REVOKE ALL ON _prisma_migrations FROM erp_app;
  END IF;
END $$;
