-- 0005: bitácora de exportaciones de reportes (erp-v3 §13: quién, filtros, cuándo).
CREATE TABLE report_runs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  user_id     uuid,
  category    text NOT NULL,
  report      text NOT NULL,
  format      text NOT NULL,
  filters     jsonb,
  row_count   integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_report_runs_company ON report_runs (company_id, created_at DESC);
ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_runs
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
CREATE TRIGGER trg_report_runs_immutable BEFORE UPDATE OR DELETE ON report_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT ON report_runs TO erp_app;
    REVOKE UPDATE, DELETE ON report_runs FROM erp_app;
  END IF;
END $$;
