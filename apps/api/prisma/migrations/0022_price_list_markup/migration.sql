-- Listas de precio derivadas: precio = precio de la lista base × (1 + % / 100) × tasa de cambio del día. Aditiva.
ALTER TABLE price_lists ADD COLUMN base_list_id uuid;
ALTER TABLE price_lists ADD COLUMN markup_percent numeric(9,4);
ALTER TABLE price_lists ADD CONSTRAINT fk_price_lists_base FOREIGN KEY (company_id, base_list_id) REFERENCES price_lists (company_id, id);
ALTER TABLE price_lists ADD CONSTRAINT ck_price_lists_derived CHECK (
  (base_list_id IS NULL AND markup_percent IS NULL) OR (base_list_id IS NOT NULL AND markup_percent IS NOT NULL AND markup_percent > -100 AND base_list_id <> id)
);
