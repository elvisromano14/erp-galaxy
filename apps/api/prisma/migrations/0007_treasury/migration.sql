-- 0007: tesorería — libro de movimientos bancarios (inmutable), pagos a proveedores y conciliación bancaria.
ALTER TABLE payable_entries ADD CONSTRAINT uq_payables_company_id UNIQUE (company_id, id);

CREATE TABLE bank_movements (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  movement_date   date NOT NULL,
  kind            text NOT NULL,
  amount          numeric(18,4) NOT NULL,
  reference       text,
  description     text,
  source_type     text,
  source_id       uuid,
  reversal_of     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (company_id, id),
  CONSTRAINT ck_bank_mov_kind CHECK (kind IN ('DEPOSIT','WITHDRAWAL','FEE','ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT','SUPPLIER_PAYMENT','CUSTOMER_RECEIPT','REVERSAL')),
  CONSTRAINT ck_bank_mov_amount CHECK (amount <> 0),
  CONSTRAINT fk_bank_mov_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_bank_mov_account FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id),
  CONSTRAINT fk_bank_mov_reversal FOREIGN KEY (company_id, reversal_of) REFERENCES bank_movements (company_id, id)
);
CREATE UNIQUE INDEX uq_bank_mov_reversal ON bank_movements (company_id, reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX ix_bank_mov_account_date ON bank_movements (company_id, bank_account_id, movement_date, created_at);
CREATE INDEX ix_bank_mov_source ON bank_movements (company_id, source_type, source_id);

CREATE TABLE supplier_payments (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL,
  number            text NOT NULL,
  status            text NOT NULL DEFAULT 'CONFIRMED',
  supplier_id       uuid NOT NULL,
  payment_date      date NOT NULL,
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
  CONSTRAINT ck_sup_pay_status CHECK (status IN ('CONFIRMED','CANCELLED')),
  CONSTRAINT ck_sup_pay_amount CHECK (amount >= 0),
  CONSTRAINT ck_sup_pay_rate CHECK (exchange_rate > 0),
  CONSTRAINT ck_sup_pay_bank CHECK (amount = 0 OR bank_account_id IS NOT NULL),
  CONSTRAINT fk_sup_pay_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_sup_pay_supplier FOREIGN KEY (company_id, supplier_id) REFERENCES suppliers (company_id, id),
  CONSTRAINT fk_sup_pay_method FOREIGN KEY (company_id, payment_method_id) REFERENCES payment_methods (company_id, id),
  CONSTRAINT fk_sup_pay_bank FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id)
);
CREATE INDEX ix_sup_pay_supplier ON supplier_payments (company_id, supplier_id, payment_date);
CREATE TRIGGER trg_supplier_payments_updated_at BEFORE UPDATE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE supplier_payment_applications (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id       uuid NOT NULL,
  payment_id       uuid NOT NULL,
  payable_entry_id uuid NOT NULL,
  amount           numeric(18,4) NOT NULL,
  amount_payment   numeric(18,4) NOT NULL,
  UNIQUE (company_id, payment_id, payable_entry_id),
  CONSTRAINT ck_sup_app_amount CHECK (amount <> 0),
  CONSTRAINT fk_sup_app_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_sup_app_payment FOREIGN KEY (company_id, payment_id) REFERENCES supplier_payments (company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_sup_app_entry FOREIGN KEY (company_id, payable_entry_id) REFERENCES payable_entries (company_id, id)
);
CREATE INDEX ix_sup_app_entry ON supplier_payment_applications (company_id, payable_entry_id);

CREATE TABLE bank_reconciliations (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL,
  bank_account_id   uuid NOT NULL,
  statement_date    date NOT NULL,
  statement_balance numeric(18,4) NOT NULL,
  book_balance      numeric(18,4) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  notes             text,
  UNIQUE (company_id, id),
  CONSTRAINT ck_bank_rec_balanced CHECK (statement_balance = book_balance),
  CONSTRAINT fk_bank_rec_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_bank_rec_account FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id)
);
CREATE INDEX ix_bank_rec_account ON bank_reconciliations (company_id, bank_account_id, statement_date);

CREATE TABLE bank_reconciliation_items (
  company_id        uuid NOT NULL,
  reconciliation_id uuid NOT NULL,
  movement_id       uuid NOT NULL,
  PRIMARY KEY (company_id, movement_id),
  CONSTRAINT fk_bank_rec_item_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_bank_rec_item_rec FOREIGN KEY (company_id, reconciliation_id) REFERENCES bank_reconciliations (company_id, id),
  CONSTRAINT fk_bank_rec_item_mov FOREIGN KEY (company_id, movement_id) REFERENCES bank_movements (company_id, id)
);
CREATE INDEX ix_bank_rec_items_rec ON bank_reconciliation_items (company_id, reconciliation_id);

CREATE TRIGGER trg_bank_movements_immutable BEFORE UPDATE OR DELETE ON bank_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_bank_recs_immutable BEFORE UPDATE OR DELETE ON bank_reconciliations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_bank_rec_items_immutable BEFORE UPDATE OR DELETE ON bank_reconciliation_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_movements','supplier_payments','supplier_payment_applications','bank_reconciliations','bank_reconciliation_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON supplier_payments, supplier_payment_applications TO erp_app;
    GRANT SELECT, INSERT ON bank_movements, bank_reconciliations, bank_reconciliation_items TO erp_app;
  END IF;
END $$;
