-- 0011: saldos iniciales de CxP, sobregiro controlado, diferencial cambiario realizado y costo por serial.
ALTER TABLE payable_entries ALTER COLUMN purchase_document_id DROP NOT NULL;
ALTER TABLE payable_entries
  ADD COLUMN document_no text,
  ADD COLUMN issue_date  date,
  ADD COLUMN notes       text;
ALTER TABLE payable_entries ADD CONSTRAINT ck_payables_type CHECK (entry_type IN ('INVOICE', 'RETURN', 'OPENING'));
ALTER TABLE payable_entries ADD CONSTRAINT ck_payables_source CHECK (
  (entry_type = 'OPENING') = (purchase_document_id IS NULL)
  AND (purchase_document_id IS NOT NULL OR (document_no IS NOT NULL AND issue_date IS NOT NULL)));

ALTER TABLE supplier_payment_applications ADD COLUMN rate_doc numeric(18,8), ADD COLUMN rate_pay numeric(18,8), ADD COLUMN fx_diff_bs numeric(18,4) NOT NULL DEFAULT 0;
ALTER TABLE customer_receipt_applications ADD COLUMN rate_doc numeric(18,8), ADD COLUMN rate_pay numeric(18,8), ADD COLUMN fx_diff_bs numeric(18,4) NOT NULL DEFAULT 0;

ALTER TABLE bank_accounts ADD COLUMN overdraft_limit numeric(18,4) NOT NULL DEFAULT 0;
ALTER TABLE bank_accounts ADD CONSTRAINT ck_bank_overdraft CHECK (overdraft_limit >= 0);

ALTER TABLE product_serials ADD COLUMN unit_cost numeric(18,6);
-- Costo de las unidades ya existentes: el de su última entrada al inventario.
UPDATE product_serials s SET unit_cost = (
  SELECT m.unit_cost FROM movement_serials ms JOIN inventory_movements m ON m.id = ms.movement_id AND m.company_id = ms.company_id
  WHERE ms.serial_id = s.id AND ms.company_id = s.company_id AND m.quantity > 0 ORDER BY m.seq DESC LIMIT 1);
