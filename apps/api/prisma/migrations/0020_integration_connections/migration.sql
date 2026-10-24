-- Conexiones del integrador a las bases de Saint (configuradas desde el ERP) y su monitoreo.
-- Aditiva: solo tablas nuevas. La clave de SQL Server se guarda CIFRADA (AES-256-GCM, llave en el entorno del servidor).

CREATE TABLE integration_connections (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id              uuid NOT NULL,
  connector_id            text NOT NULL,                 -- identificador corto: electrosur, sinocars…
  name                    text NOT NULL,
  host                    text NOT NULL,
  port                    integer NOT NULL DEFAULT 1433,
  database_name           text NOT NULL,
  username                text NOT NULL,
  password_enc            text NOT NULL,                 -- v1.<iv>.<tag>.<texto cifrado> (base64url)
  encrypt                 boolean NOT NULL DEFAULT false,
  trust_server_certificate boolean NOT NULL DEFAULT true,
  mode                    text NOT NULL DEFAULT 'READ_ONLY',
  allowed_write_databases text[] NOT NULL DEFAULT '{}',
  poll_interval_sec       integer NOT NULL DEFAULT 30,
  streams                 text[] NOT NULL DEFAULT ARRAY['customers'],
  outbound                text[] NOT NULL DEFAULT '{}',
  price_currency          text NOT NULL DEFAULT 'USD',
  enabled                 boolean NOT NULL DEFAULT true,
  -- Prueba de conexión: el ERP la solicita y el integrador la ejecuta y responde.
  test_requested_at       timestamptz,
  test_at                 timestamptz,
  test_ok                 boolean,
  test_message            text,
  test_latency_ms         integer,
  test_databases          text[] NOT NULL DEFAULT '{}',
  test_schema             jsonb,
  last_seen_at            timestamptz,                   -- último contacto del integrador con esta conexión
  version                 integer NOT NULL DEFAULT 1,
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT ck_integration_connections_mode CHECK (mode IN ('READ_ONLY', 'READ_WRITE')),
  CONSTRAINT ck_integration_connections_poll CHECK (poll_interval_sec >= 5),
  CONSTRAINT ck_integration_connections_connector CHECK (connector_id ~ '^[a-z0-9-]{2,40}$'),
  CONSTRAINT fk_integration_connections_company FOREIGN KEY (company_id) REFERENCES companies(id)
);
CREATE UNIQUE INDEX ux_integration_connections_connector ON integration_connections (company_id, connector_id) WHERE deleted_at IS NULL;

CREATE TABLE integration_runs (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL,
  connector_id text NOT NULL,
  stream       text NOT NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  rows_read    integer NOT NULL DEFAULT 0,
  rows_applied integer NOT NULL DEFAULT 0,
  rows_failed  integer NOT NULL DEFAULT 0,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_integration_runs_company FOREIGN KEY (company_id) REFERENCES companies(id)
);
CREATE INDEX ix_integration_runs_lookup ON integration_runs (company_id, connector_id, started_at DESC);

CREATE TABLE integration_conflicts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL,
  connector_id text NOT NULL,
  entity       text NOT NULL,
  saint_key    text NOT NULL DEFAULT '',
  erp_id       uuid,
  kind         text NOT NULL,
  detail       jsonb,
  status       text NOT NULL DEFAULT 'OPEN',
  note         text,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  CONSTRAINT ck_integration_conflicts_status CHECK (status IN ('OPEN', 'RESOLVED', 'ACKNOWLEDGED')),
  CONSTRAINT fk_integration_conflicts_company FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE (company_id, connector_id, entity, saint_key, kind)
);
CREATE INDEX ix_integration_conflicts_status ON integration_conflicts (company_id, status);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connections', 'integration_runs', 'integration_conflicts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
