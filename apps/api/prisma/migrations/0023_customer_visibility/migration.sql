-- Alcance de clientes de la app móvil por empresa: OWN (cartera del vendedor) | ALL (todos). Aditiva; por omisión conserva el comportamiento actual.
ALTER TABLE companies ADD COLUMN customer_visibility text NOT NULL DEFAULT 'OWN';
ALTER TABLE companies ADD CONSTRAINT ck_companies_customer_visibility CHECK (customer_visibility IN ('OWN', 'ALL'));
