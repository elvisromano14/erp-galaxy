-- 0016: modo de impresión de facturas (normal o impresora fiscal) y datos devueltos por la máquina fiscal.
ALTER TABLE companies
  ADD COLUMN invoice_print_mode text NOT NULL DEFAULT 'NORMAL' CHECK (invoice_print_mode IN ('NORMAL', 'FISCAL_PRINTER')),
  ADD COLUMN fiscal_printer_model text;
ALTER TABLE sales_documents
  ADD COLUMN fiscal_number text,
  ADD COLUMN fiscal_serial text;
