const { execSync } = require('node:child_process');
const path = require('node:path');
module.exports = async () => {
  // Base de pruebas limpia: roles, migraciones (incluye RLS y triggers).
  execSync('bash scripts/db-reset.sh minierp_test', { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, PATH: process.env.PATH } });
};
