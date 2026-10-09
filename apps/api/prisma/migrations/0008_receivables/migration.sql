-- 0008: cuentas por cobrar y cobros a clientes. Las facturas (S9–S10) crearán sus asientos aquí; mientras tanto se cargan saldos iniciales.
CREATE TABLE receivable_entries (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL,
  customer_id   uuid NOT NULL,
  entry_type    text NOT NULL,
  source_type   text,
  source_id     uuid,
  document_no   text NOT NULL,
  issue_date    date NOT NULL,
  due_date      date NOT NULL,
  currency_id   uuid NOT NULL REFERENCES currencies(id),
  exchange_rate numeric(18,8) NOT NULL DEFAULT 1,
  amount        numeric(18,4) NOT NULL,
  balance       numeric(18,4) NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN',
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  UNIQUE (company_id, id),
  CONSTRAINT ck_recv_type CHECK (entry_type IN ('OPENING','INVOICE','CREDIT_NOTE','DEBIT_NOTE')),
  CONSTRAINT ck_recv_status CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','CANCELLED')),
  CONSTRAINT ck_recv_rate CHECK (exchange_rate > 0),
  CONSTRAINT ck_recv_amount CHECK (amount <> 0),
  CONSTRAINT ck_recv_balance CHECK (balance = 0 OR (balance > 0) = (amount > 0)),
  CONSTRAINT ck_recv_due CHECK (due_date >= issue_date),
  CONSTRAINT fk_recv_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_recv_customer FOREIGN KEY (company_id, customer_id) REFERENCES customers (company_id, id)
);
CREATE INDEX ix_recv_customer_status ON receivable_entries (company_id, customer_id, status);
CREATE INDEX ix_recv_source ON receivable_entries (company_id, source_type, source_id);
CREATE TRIGGER trg_receivable_entries_updated_at BEFORE UPDATE ON receivable_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE customer_receipts (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL,
  number            text NOT NULL,
  status            text NOT NULL DEFAULT 'CONFIRMED',
  customer_id       uuid NOT NULL,
  receipt_date      date NOT NULL,
  payment_method_id uuid NOT NULL,
  bank_account_id   uuid,
  currency_id       uuid NOT NULL REFERENCES currencies(id),
  exchange_rate     numeric(18,8) NOT NULL DEFAULT 1,
  amount            numeric(18,4) NOT NULL,
  reference         text,
  notes             text,
  cancelled_at      timestamptz,
  cancelled_by      uuid,
  cancel_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  UNIQUE (company_id, id),
  UNIQUE (company_id, number),
  CONSTRAINT ck_cust_rec_status CHECK (status IN ('CONFIRMED','CANCELLED')),
  CONSTRAINT ck_cust_rec_amount CHECK (amount >= 0),
  CONSTRAINT ck_cust_rec_rate CHECK (exchange_rate > 0),
  CONSTRAINT fk_cust_rec_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cust_rec_customer FOREIGN KEY (company_id, customer_id) REFERENCES customers (company_id, id),
  CONSTRAINT fk_cust_rec_method FOREIGN KEY (company_id, payment_method_id) REFERENCES payment_methods (company_id, id),
  CONSTRAINT fk_cust_rec_bank FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id)
);
CREATE INDEX ix_cust_rec_customer ON customer_receipts (company_id, customer_id, receipt_date);
CREATE TRIGGER trg_customer_receipts_updated_at BEFORE UPDATE ON customer_receipts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE customer_receipt_applications (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL,
  receipt_id          uuid NOT NULL,
  receivable_entry_id uuid NOT NULL,
  amount              numeric(18,4) NOT NULL,
  amount_receipt      numeric(18,4) NOT NULL,
  UNIQUE (company_id, receipt_id, receivable_entry_id),
  CONSTRAINT ck_cust_app_amount CHECK (amount <> 0),
  CONSTRAINT fk_cust_app_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_cust_app_receipt FOREIGN KEY (company_id, receipt_id) REFERENCES customer_receipts (company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_cust_app_entry FOREIGN KEY (company_id, receivable_entry_id) REFERENCES receivable_entries (company_id, id)
);
CREATE INDEX ix_cust_app_entry ON customer_receipt_applications (company_id, receivable_entry_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['receivable_entries','customer_receipts','customer_receipt_applications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON receivable_entries, customer_receipts, customer_receipt_applications TO erp_app;
  END IF;
END $$;
