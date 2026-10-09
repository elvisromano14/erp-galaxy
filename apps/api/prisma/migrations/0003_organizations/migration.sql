-- 0003: clientes (organizaciones). Cada empresa pertenece a un cliente; la visibilidad de empresas se decide por cliente.
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_organizations (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  is_admin        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);
CREATE INDEX ix_user_organizations_org ON user_organizations (organization_id);
-- Un usuario pertenece a UN solo cliente (los usuarios de plataforma no tienen fila).
CREATE UNIQUE INDEX uq_user_organizations_user ON user_organizations (user_id);

ALTER TABLE companies ADD COLUMN organization_id uuid;
-- Datos existentes: un cliente por empresa (nombre = razón social) y sus usuarios quedan en ese cliente.
ALTER TABLE organizations ADD COLUMN src_company uuid;
INSERT INTO organizations (name, src_company) SELECT legal_name, id FROM companies;
UPDATE companies c SET organization_id = o.id FROM organizations o WHERE o.src_company = c.id;
ALTER TABLE organizations DROP COLUMN src_company;
INSERT INTO user_organizations (user_id, organization_id, is_admin)
  SELECT DISTINCT ON (uc.user_id) uc.user_id, c.organization_id,
         EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.company_id = ur.company_id
                 WHERE ur.user_id = uc.user_id AND ur.company_id = uc.company_id AND r.code = 'ADMIN')
  FROM user_companies uc JOIN companies c ON c.id = uc.company_id
  JOIN users u ON u.id = uc.user_id AND NOT u.is_super_admin
  ORDER BY uc.user_id, uc.created_at;
ALTER TABLE companies ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE companies ADD CONSTRAINT fk_companies_organization FOREIGN KEY (organization_id) REFERENCES organizations(id);
CREATE INDEX ix_companies_org ON companies (organization_id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, user_organizations TO erp_app;
  END IF;
END $$;
