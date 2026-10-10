-- 0013: el modo offline sale de este proyecto: se elimina la bandera `offline` de las funciones de la empresa.
ALTER TABLE companies ALTER COLUMN features SET DEFAULT '{"lots":false,"serials":false,"expiry":false}';
UPDATE companies SET features = features - 'offline' WHERE features ? 'offline';
