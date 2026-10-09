-- 0006: documentos de ventas (cotizaciones, presupuestos y pedidos). Modelo unificado (erp-v3 §4.3):
-- las facturas y notas llegarán con S9–S10 sobre las mismas tablas.
CREATE TABLE sales_documents (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id       uuid NOT NULL,
  doc_type         text NOT NULL,
  status           text NOT NULL DEFAULT 'DRAFT',
  number           text,
  doc_date         date NOT NULL,
  valid_until      date,
  customer_id      uuid NOT NULL,
  seller_id        uuid,
  warehouse_id     uuid,
  price_list_id    uuid,
  currency_id      uuid NOT NULL REFERENCES currencies(id),
  exchange_rate    numeric(18,8) NOT NULL DEFAULT 1,
  payment_condition text NOT NULL DEFAULT 'CASH',
  credit_days      integer NOT NULL DEFAULT 0,
  subtotal         numeric(18,4) NOT NULL DEFAULT 0,
  taxable_base     numeric(18,4) NOT NULL DEFAULT 0,
  exempt_base      numeric(18,4) NOT NULL DEFAULT 0,
  tax_total        numeric(18,4) NOT NULL DEFAULT 0,
  total            numeric(18,4) NOT NULL DEFAULT 0,
  total_base       numeric(18,4) NOT NULL DEFAULT 0,
  reserves_stock   boolean NOT NULL DEFAULT false,
  stock_reserved   boolean NOT NULL DEFAULT false,
  notes            text,
  confirmed_at     timestamptz,
  confirmed_by     uuid,
  cancelled_at     timestamptz,
  cancelled_by     uuid,
  cancel_reason    text,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,
  UNIQUE (company_id, id),
  UNIQUE (company_id, doc_type, number),
  CONSTRAINT ck_sales_docs_type CHECK (doc_type IN ('QUOTE','BUDGET','ORDER','ORDER_RETURN','INVOICE','CREDIT_NOTE','DEBIT_NOTE')),
  CONSTRAINT ck_sales_docs_status CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED','CONFIRMED','CONVERTED','PARTIALLY_INVOICED','INVOICED','CANCELLED','VOIDED','CLOSED')),
  CONSTRAINT ck_sales_docs_cond CHECK (payment_condition IN ('CASH','CREDIT')),
  CONSTRAINT ck_sales_docs_rate CHECK (exchange_rate > 0),
  CONSTRAINT ck_sales_docs_number CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED') OR number IS NOT NULL),
  CONSTRAINT ck_sales_docs_reserve CHECK (NOT stock_reserved OR (reserves_stock AND warehouse_id IS NOT NULL)),
  CONSTRAINT fk_sales_docs_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_sales_docs_customer FOREIGN KEY (company_id, customer_id) REFERENCES customers (company_id, id),
  CONSTRAINT fk_sales_docs_seller FOREIGN KEY (company_id, seller_id) REFERENCES sellers (company_id, id),
  CONSTRAINT fk_sales_docs_warehouse FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id),
  CONSTRAINT fk_sales_docs_pricelist FOREIGN KEY (company_id, price_list_id) REFERENCES price_lists (company_id, id)
);
CREATE INDEX ix_sales_docs_type_status ON sales_documents (company_id, doc_type, status);
CREATE INDEX ix_sales_docs_customer ON sales_documents (company_id, customer_id);
CREATE INDEX ix_sales_docs_seller ON sales_documents (company_id, seller_id);
CREATE TRIGGER trg_sales_documents_updated_at BEFORE UPDATE ON sales_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sales_document_lines (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL,
  document_id  uuid NOT NULL,
  line_no      integer NOT NULL,
  product_id   uuid NOT NULL,
  description  text,
  quantity     numeric(18,4) NOT NULL,
  unit_price   numeric(18,6) NOT NULL,
  discount_pct numeric(7,4) NOT NULL DEFAULT 0,
  tax_id       uuid,
  tax_rate     numeric(7,4) NOT NULL DEFAULT 0,
  net          numeric(18,4) NOT NULL DEFAULT 0,
  tax          numeric(18,4) NOT NULL DEFAULT 0,
  total        numeric(18,4) NOT NULL DEFAULT 0,
  UNIQUE (company_id, id),
  CONSTRAINT ck_sales_lines_qty CHECK (quantity > 0 AND unit_price >= 0),
  CONSTRAINT ck_sales_lines_disc CHECK (discount_pct >= 0 AND discount_pct <= 100),
  CONSTRAINT fk_sales_lines_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_sales_lines_doc FOREIGN KEY (company_id, document_id) REFERENCES sales_documents (company_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_sales_lines_product FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),
  CONSTRAINT fk_sales_lines_tax FOREIGN KEY (company_id, tax_id) REFERENCES taxes (company_id, id)
);
CREATE INDEX ix_sales_lines_doc ON sales_document_lines (company_id, document_id);
CREATE INDEX ix_sales_lines_product ON sales_document_lines (company_id, product_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_documents','sales_document_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON sales_documents, sales_document_lines TO erp_app;
  END IF;
END $$;
-- Una reserva nunca puede dejar el saldo reservado negativo ni exceder la existencia (salvo stock negativo permitido).
ALTER TABLE inventory_stock DROP CONSTRAINT IF EXISTS ck_inv_stock_reserved;
ALTER TABLE inventory_stock ADD CONSTRAINT ck_inv_stock_reserved CHECK (reserved_qty >= 0);
