-- 0010: fiscal — retenciones (IVA/ISLR) practicadas y recibidas, IGTF en cobros, devolución de dinero.
CREATE TABLE withholdings (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id            uuid NOT NULL,
  direction             text NOT NULL,
  kind                  text NOT NULL,
  number                text NOT NULL,
  external_number       text,
  status                text NOT NULL DEFAULT 'CONFIRMED',
  voucher_date          date NOT NULL,
  period                text NOT NULL,
  supplier_id           uuid,
  customer_id           uuid,
  purchase_document_id  uuid,
  sales_document_id     uuid,
  payable_entry_id      uuid,
  receivable_entry_id   uuid,
  concept               text,
  base_bs               numeric(18,4) NOT NULL,
  percentage            numeric(7,4) NOT NULL,
  amount_bs             numeric(18,4) NOT NULL,
  applied_amount        numeric(18,4) NOT NULL,
  notes                 text,
  cancelled_at          timestamptz,
  cancelled_by          uuid,
  cancel_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  UNIQUE (company_id, id),
  UNIQUE (company_id, number),
  CONSTRAINT ck_wh_direction CHECK (direction IN ('ISSUED','RECEIVED')),
  CONSTRAINT ck_wh_kind CHECK (kind IN ('IVA','ISLR')),
  CONSTRAINT ck_wh_status CHECK (status IN ('CONFIRMED','CANCELLED')),
  CONSTRAINT ck_wh_amounts CHECK (base_bs >= 0 AND percentage > 0 AND percentage <= 100 AND amount_bs > 0 AND applied_amount > 0),
  CONSTRAINT ck_wh_party CHECK ((direction = 'ISSUED' AND supplier_id IS NOT NULL AND customer_id IS NULL AND payable_entry_id IS NOT NULL)
                             OR (direction = 'RECEIVED' AND customer_id IS NOT NULL AND supplier_id IS NULL AND receivable_entry_id IS NOT NULL AND external_number IS NOT NULL)),
  CONSTRAINT fk_wh_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_wh_supplier FOREIGN KEY (company_id, supplier_id) REFERENCES suppliers (company_id, id),
  CONSTRAINT fk_wh_customer FOREIGN KEY (company_id, customer_id) REFERENCES customers (company_id, id),
  CONSTRAINT fk_wh_payable FOREIGN KEY (company_id, payable_entry_id) REFERENCES payable_entries (company_id, id),
  CONSTRAINT fk_wh_receivable FOREIGN KEY (company_id, receivable_entry_id) REFERENCES receivable_entries (company_id, id)
);
-- Una sola retención activa por documento y tipo (la anulada se puede rehacer).
CREATE UNIQUE INDEX uq_wh_purchase_doc ON withholdings (company_id, purchase_document_id, kind) WHERE status = 'CONFIRMED' AND purchase_document_id IS NOT NULL;
CREATE UNIQUE INDEX uq_wh_sales_doc ON withholdings (company_id, sales_document_id, kind) WHERE status = 'CONFIRMED' AND sales_document_id IS NOT NULL;
CREATE INDEX ix_wh_period ON withholdings (company_id, direction, kind, period);
ALTER TABLE withholdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE withholdings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON withholdings
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

ALTER TABLE customer_receipts
  ADD COLUMN igtf_pct    numeric(7,4) NOT NULL DEFAULT 0,
  ADD COLUMN igtf_amount numeric(18,4) NOT NULL DEFAULT 0;
ALTER TABLE customer_receipts ADD CONSTRAINT ck_cust_rec_igtf CHECK (igtf_pct >= 0 AND igtf_amount >= 0);

ALTER TABLE bank_movements DROP CONSTRAINT ck_bank_mov_kind;
ALTER TABLE bank_movements ADD CONSTRAINT ck_bank_mov_kind CHECK (kind IN
  ('DEPOSIT','WITHDRAWAL','FEE','ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT','SUPPLIER_PAYMENT','CUSTOMER_RECEIPT','CUSTOMER_REFUND','REVERSAL'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON withholdings TO erp_app;
  END IF;
END $$;
