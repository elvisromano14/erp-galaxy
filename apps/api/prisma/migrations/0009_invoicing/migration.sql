-- 0009: facturación (facturas y notas de crédito sobre el modelo unificado de ventas).
ALTER TABLE sales_documents
  ADD COLUMN control_no      text,
  ADD COLUMN igtf_pct        numeric(7,4) NOT NULL DEFAULT 0,
  ADD COLUMN igtf_amount     numeric(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN fiscal_snapshot jsonb;
CREATE UNIQUE INDEX uq_sales_docs_control ON sales_documents (company_id, control_no) WHERE control_no IS NOT NULL;
ALTER TABLE sales_documents ADD CONSTRAINT ck_sales_docs_igtf CHECK (igtf_pct >= 0 AND igtf_amount >= 0);

ALTER TABLE sales_document_lines
  ADD COLUMN unit_cost numeric(18,6),
  ADD COLUMN serials   text[] NOT NULL DEFAULT '{}';

CREATE TABLE sales_document_payments (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL,
  document_id       uuid NOT NULL,
  payment_method_id uuid NOT NULL,
  bank_account_id   uuid,
  currency_id       uuid NOT NULL REFERENCES currencies(id),
  exchange_rate     numeric(18,8) NOT NULL DEFAULT 1,
  amount            numeric(18,4) NOT NULL,
  amount_doc        numeric(18,4) NOT NULL,
  applies_igtf      boolean NOT NULL DEFAULT false,
  igtf_amount       numeric(18,4) NOT NULL DEFAULT 0,
  reference         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_sales_pay_amount CHECK (amount > 0 AND amount_doc > 0 AND igtf_amount >= 0),
  CONSTRAINT fk_sales_pay_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_sales_pay_doc FOREIGN KEY (company_id, document_id) REFERENCES sales_documents (company_id, id),
  CONSTRAINT fk_sales_pay_method FOREIGN KEY (company_id, payment_method_id) REFERENCES payment_methods (company_id, id),
  CONSTRAINT fk_sales_pay_bank FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id)
);
CREATE INDEX ix_sales_pay_doc ON sales_document_payments (company_id, document_id);
ALTER TABLE sales_document_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_document_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_document_payments
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON sales_document_payments TO erp_app;
  END IF;
END $$;
