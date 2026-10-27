-- Ubicaciones (catálogo simple) y marca / ubicación opcionales del producto. Aditiva.
CREATE TABLE locations (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL,
  code       text NOT NULL,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_locations_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT locations_company_id_code_key UNIQUE (company_id, code),
  CONSTRAINT locations_company_id_id_key UNIQUE (company_id, id)
);

ALTER TABLE products ADD COLUMN brand text;
ALTER TABLE products ADD COLUMN location_id uuid;
ALTER TABLE products ADD CONSTRAINT ck_products_brand CHECK (brand IS NULL OR char_length(brand) <= 80);
ALTER TABLE products ADD CONSTRAINT fk_products_location_id FOREIGN KEY (company_id, location_id) REFERENCES locations (company_id, id);
CREATE INDEX ix_products_location ON products (company_id, location_id) WHERE location_id IS NOT NULL;

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON locations
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
CREATE TRIGGER trg_locations_updated_at BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON locations TO erp_app;
  END IF;
END $$;
