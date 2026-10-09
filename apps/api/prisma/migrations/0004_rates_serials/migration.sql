-- 0004: tasas manuales por empresa (las de BCV son globales) y control por seriales.

-- ───────── Tasas de cambio: globales (BCV, company_id NULL) o manuales de una empresa ─────────
ALTER TABLE exchange_rates ADD COLUMN company_id uuid REFERENCES companies(id);
CREATE INDEX ix_exchange_rates_company ON exchange_rates (company_id, currency_id, date);
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY;
-- Cada empresa ve las globales y las suyas; solo puede insertar las suyas (o globales desde el job, sin contexto de empresa).
CREATE POLICY rates_visibility ON exchange_rates
  USING (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id IS NULL OR company_id = nullif(current_setting('app.company_id', true), '')::uuid);
ALTER TABLE exchange_rates ADD CONSTRAINT ck_exchange_rates_source CHECK (source IN ('MANUAL','BCV','API'));

-- ───────── Seriales ─────────
ALTER TABLE inventory_document_lines ADD COLUMN serials text[];
ALTER TABLE purchase_document_lines ADD COLUMN serials text[];

CREATE TABLE product_serials (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL,
  product_id     uuid NOT NULL,
  serial_no      text NOT NULL,
  warehouse_id   uuid,
  status         text NOT NULL DEFAULT 'IN_STOCK',
  last_doc_type  text,
  last_doc_id    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, product_id, serial_no),
  UNIQUE (company_id, id),
  CONSTRAINT ck_serial_status CHECK (status IN ('IN_STOCK','SOLD','RETURNED','SCRAPPED')),
  CONSTRAINT ck_serial_location CHECK ((status = 'IN_STOCK') = (warehouse_id IS NOT NULL)),
  CONSTRAINT fk_serials_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_serials_product FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),
  CONSTRAINT fk_serials_warehouse FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id)
);
CREATE INDEX ix_serials_stock ON product_serials (company_id, product_id, warehouse_id) WHERE status = 'IN_STOCK';
CREATE TRIGGER trg_product_serials_updated_at BEFORE UPDATE ON product_serials FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Qué seriales participaron en cada movimiento del kardex (inmutable; permite revertir exactamente).
CREATE TABLE movement_serials (
  movement_id uuid NOT NULL,
  company_id  uuid NOT NULL,
  serial_id   uuid NOT NULL,
  PRIMARY KEY (movement_id, serial_id),
  CONSTRAINT fk_mser_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_mser_serial FOREIGN KEY (company_id, serial_id) REFERENCES product_serials (company_id, id)
);
CREATE INDEX ix_mser_serial ON movement_serials (company_id, serial_id);
CREATE TRIGGER trg_movement_serials_immutable BEFORE UPDATE OR DELETE ON movement_serials FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_serials','movement_serials'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON product_serials TO erp_app;
    GRANT SELECT, INSERT ON movement_serials TO erp_app;
    REVOKE UPDATE, DELETE ON movement_serials FROM erp_app;
  END IF;
END $$;
