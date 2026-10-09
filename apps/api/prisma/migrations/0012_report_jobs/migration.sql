-- 0012: reportes pesados en segundo plano (BullMQ). El archivo generado se guarda aquí y expira (se purga con una tarea diaria).
CREATE TABLE report_jobs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id  uuid NOT NULL,
  user_id     uuid,
  category    text NOT NULL,
  report      text NOT NULL,
  format      text NOT NULL,
  delimiter   text NOT NULL DEFAULT ';',
  filters     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'QUEUED',
  error       text,
  row_count   integer,
  truncated   boolean NOT NULL DEFAULT false,
  filename    text,
  mime        text,
  size_bytes  integer,
  file        bytea,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  expires_at  timestamptz,
  UNIQUE (company_id, id),
  CONSTRAINT ck_report_jobs_status CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED')),
  CONSTRAINT ck_report_jobs_format CHECK (format IN ('csv', 'xlsx', 'pdf')),
  CONSTRAINT fk_report_jobs_company FOREIGN KEY (company_id) REFERENCES companies(id)
);
CREATE INDEX ix_report_jobs_user ON report_jobs (company_id, user_id, created_at DESC);
CREATE INDEX ix_report_jobs_expiry ON report_jobs (expires_at) WHERE file IS NOT NULL;
ALTER TABLE report_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_jobs
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON report_jobs TO erp_app;
  END IF;
END $$;
