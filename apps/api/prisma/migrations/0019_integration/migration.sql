-- 0019: base para integrar el ERP con otros sistemas (Saint): cuentas de servicio, referencias externas,
-- eventos de salida y estado de validación de proveedores. Solo cambios ADITIVOS (nada se renombra ni se borra).

-- ───────────── Cuentas de servicio (credenciales de máquina a máquina) ─────────────
-- Un usuario de servicio no entra por clave: obtiene un token corto con client_id + secreto.
ALTER TABLE users ADD COLUMN is_service boolean NOT NULL DEFAULT false;

CREATE TABLE service_credentials (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL,
  user_id      uuid NOT NULL UNIQUE,
  client_id    text NOT NULL UNIQUE,
  secret_hash  text NOT NULL,             -- argon2id; el secreto se muestra una sola vez al crearlo
  name         text NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT fk_service_credentials_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_service_credentials_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX ix_service_credentials_company ON service_credentials (company_id);
-- Como `users` y `refresh_tokens`, es una tabla global de autenticación: se consulta ANTES de conocer la empresa.

-- ───────────── Proveedores: estado de validación (igual que clientes) ─────────────
ALTER TABLE suppliers ADD COLUMN validation_status text NOT NULL DEFAULT 'VALIDATED';
ALTER TABLE suppliers ADD CONSTRAINT suppliers_validation_status_check CHECK (validation_status IN ('VALIDATED', 'PENDING'));
CREATE INDEX ix_suppliers_pending ON suppliers (company_id) WHERE validation_status = 'PENDING';

-- ───────────── Referencias externas (código o número del otro sistema) ─────────────
CREATE TABLE external_refs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL,
  entity          text NOT NULL,           -- customer, supplier, product, price_list…
  entity_id       uuid NOT NULL,
  system          text NOT NULL,           -- SAINT
  connector       text NOT NULL,           -- servidor de origen (electrosur, sinocars…)
  external_key    text NOT NULL,           -- p. ej. SACLIE.CodClie
  external_number text,                    -- número de documento del otro sistema (factura, pedido…)
  origin          text NOT NULL,           -- dónde nació el registro: SAINT | ERP
  content_hash    text,                    -- huella de lo último aplicado (evita escrituras y rebotes)
  synced_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, system, entity, external_key),
  UNIQUE (company_id, system, entity, entity_id),
  CONSTRAINT ck_external_refs_origin CHECK (origin IN ('SAINT', 'ERP')),
  CONSTRAINT fk_external_refs_company FOREIGN KEY (company_id) REFERENCES companies(id)
);
CREATE INDEX ix_external_refs_entity ON external_refs (company_id, entity, entity_id);

-- ───────────── Eventos de salida (ERP → integrador), patrón «transactional outbox» ─────────────
CREATE TABLE integration_events (
  seq         bigserial PRIMARY KEY,
  company_id  uuid NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid NOT NULL,
  op          text NOT NULL,
  version     integer,
  origin      text NOT NULL,               -- ERP | MOBILE | INTEGRATION (lo que escribe el integrador no se reenvía)
  summary     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_integration_events_op CHECK (op IN ('CREATE', 'UPDATE', 'DEACTIVATE', 'STATUS')),
  CONSTRAINT ck_integration_events_origin CHECK (origin IN ('ERP', 'MOBILE', 'INTEGRATION')),
  CONSTRAINT fk_integration_events_company FOREIGN KEY (company_id) REFERENCES companies(id)
);
CREATE INDEX ix_integration_events_company_seq ON integration_events (company_id, seq);
CREATE INDEX ix_integration_events_created ON integration_events (created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['external_refs', 'integration_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
CREATE TRIGGER trg_external_refs_updated_at BEFORE UPDATE ON external_refs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
