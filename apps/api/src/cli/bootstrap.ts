/**
 * Arranque de PRODUCCIÓN (idempotente): monedas, bancos, catálogo de permisos y el administrador global.
 * No crea empresas ni datos de demostración. Uso (en la imagen):  node dist/cli/bootstrap.js
 *   ADMIN_EMAIL      correo del administrador global (por omisión superadmin@erp.local)
 *   ADMIN_PASSWORD   contraseña inicial (obligatoria, mínimo 12 caracteres); solo se usa si el usuario aún no existe
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../common/db/prisma.service';
import { CompaniesService } from '../modules/companies/companies.service';
import { hashPassword } from '../modules/auth/auth.service';
import { BANKS, CURRENCIES } from './reference-data';

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? 'superadmin@erp.local').toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? '';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  for (const c of CURRENCIES) await prisma.currency.upsert({ where: { code: c.code }, update: {}, create: c });
  for (const [code, name] of BANKS) await prisma.bank.upsert({ where: { code }, update: {}, create: { code, name } });
  await app.get(CompaniesService).syncPermissionCatalog();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    if (password.length < 12) throw new Error('Defina ADMIN_PASSWORD (mínimo 12 caracteres) para crear el administrador global');
    await prisma.user.create({ data: { email, fullName: 'Administrador global', passwordHash: await hashPassword(password), isSuperAdmin: true } });
    console.log(`✔ Administrador global creado: ${email}`);
  } else console.log(`✔ El administrador global ya existe: ${email} (no se modifica)`);
  console.log('✔ Datos de referencia y permisos al día');
  await app.close();
}
main().then(() => process.exit(0), e => { console.error(e.message ?? e); process.exit(1); });
