-- 0015: nombre del administrador de la empresa (lo fija el alta del cliente).
ALTER TABLE companies ADD COLUMN admin_name text;

-- Un cliente (administrador) puede pertenecer a varias empresas/clientes; un usuario normal sigue siendo de uno solo.
DROP INDEX IF EXISTS uq_user_organizations_user;
CREATE UNIQUE INDEX uq_user_organizations_member ON user_organizations (user_id) WHERE NOT is_admin;
