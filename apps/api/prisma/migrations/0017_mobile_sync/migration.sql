-- 0017: soporte de la app móvil de vendedores: dispositivos, operaciones de sincronización idempotentes,
-- políticas del vendedor y estado de validación del cliente creado desde el móvil.

-- Dispositivos registrados (un teléfono por usuario, con revocación remota).
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL,
  user_id       uuid NOT NULL,
  device_key    text NOT NULL,          -- identificador estable generado por la app (se guarda en el almacenamiento seguro)
  device_code   text NOT NULL,          -- D01, D02… (numeración provisional OFF-D01-000123)
  name          text NOT NULL,
  platform      text NOT NULL DEFAULT 'android',
  app_version   text,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, device_key),
  UNIQUE (company_id, device_code),
  CONSTRAINT fk_devices_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_devices_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX ix_devices_user ON devices (company_id, user_id);

-- Operaciones enviadas por el móvil: garantizan "exactamente una vez" por clientOpId y guardan el resultado.
CREATE TABLE sync_operations (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL,
  device_id      uuid NOT NULL,
  client_op_id   uuid NOT NULL,
  client_seq     bigint NOT NULL,
  entity         text NOT NULL,
  action         text NOT NULL,
  local_id       uuid,
  status         text NOT NULL,
  error_code     text,
  message        text,
  server_id      uuid,
  server_number  text,
  server_status  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, client_op_id),
  CONSTRAINT ck_sync_operations_status CHECK (status IN ('APPLIED', 'REJECTED', 'NEEDS_REVIEW')),
  CONSTRAINT fk_sync_operations_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_sync_operations_device FOREIGN KEY (company_id, device_id) REFERENCES devices(company_id, id)
);
CREATE INDEX ix_sync_operations_device ON sync_operations (company_id, device_id, client_seq);

-- Correspondencia id local del dispositivo → id del servidor (para operaciones que referencian entidades creadas sin conexión).
CREATE TABLE sync_entity_map (
  company_id  uuid NOT NULL,
  entity      text NOT NULL,
  local_id    uuid NOT NULL,
  server_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, entity, local_id),
  CONSTRAINT fk_sync_entity_map_company FOREIGN KEY (company_id) REFERENCES companies(id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['devices', 'sync_operations', 'sync_entity_map'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON devices, sync_operations, sync_entity_map TO erp_app;
  END IF;
END $$;
CREATE TRIGGER trg_devices_updated_at BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Políticas del vendedor en el móvil.
ALTER TABLE sellers
  ADD COLUMN max_discount_pct numeric(7,4) NOT NULL DEFAULT 0 CHECK (max_discount_pct >= 0 AND max_discount_pct <= 100),
  ADD COLUMN allow_price_edit boolean NOT NULL DEFAULT false,
  ADD COLUMN allow_customer_create boolean NOT NULL DEFAULT true;

-- Cliente creado desde el móvil: usable en cotizaciones y pedidos, pero no facturable hasta que administración lo valide.
ALTER TABLE customers
  ADD COLUMN validation_status text NOT NULL DEFAULT 'VALIDATED' CHECK (validation_status IN ('VALIDATED', 'PENDING'));
CREATE INDEX ix_customers_pending ON customers (company_id) WHERE validation_status = 'PENDING';
