/**
 * Semillas de desarrollo: monedas, bancos, permisos, superadmin y (opcional) empresa demo.
 *   pnpm --filter @erp/api db:seed            → globales + superadmin
 *   SEED_DEMO=1 pnpm --filter @erp/api db:seed → además empresa demo con datos de ejemplo
 * Contraseñas de DEMO: solo desarrollo. Alícuotas/porcentajes: validar con el contador antes de producción.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/db/prisma.service';
import { CompaniesService } from '../src/modules/companies/companies.service';
import { hashPassword } from '../src/modules/auth/auth.service';
import { BANKS, CURRENCIES } from '../src/cli/reference-data';



async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const companies = app.get(CompaniesService);
  const pwd = process.env.SEED_PASSWORD ?? 'Admin12345!';

  for (const c of CURRENCIES) await prisma.currency.upsert({ where: { code: c.code }, update: {}, create: c });
  for (const [code, name] of BANKS) await prisma.bank.upsert({ where: { code }, update: {}, create: { code, name } });
  await companies.syncPermissionCatalog();

  await prisma.user.upsert({
    where: { email: 'superadmin@erp.local' }, update: {},
    create: { email: 'superadmin@erp.local', fullName: 'Super Administrador', passwordHash: await hashPassword(pwd), isSuperAdmin: true },
  });
  console.log('✔ Globales listos (monedas, bancos, permisos, superadmin@erp.local)');

  if (process.env.SEED_DEMO) {
    const { isValidRif } = await import('@erp/domain');
    const rif = (base: string) => { for (let d = 0; d < 10; d++) { const r = `J-${base}-${d}`; if (isValidRif(r)) return r; } throw new Error('rif'); };
    const org = async (name: string) => (await prisma.organization.findFirst({ where: { name } })) ?? prisma.organization.create({ data: { name } });
    const user = async (email: string, fullName: string, superAdmin = false) => {
      const u = await prisma.user.upsert({ where: { email }, update: superAdmin ? { isSuperAdmin: true } : {}, create: { email, fullName, passwordHash: await hashPassword(pwd), isSuperAdmin: superAdmin } });
      return u;
    };
    const makeCompany = async (organizationId: string, actor: { userId: string; isSuperAdmin: boolean }, r: string, legalName: string) => {
      const found = await prisma.company.findUnique({ where: { rif: r } });
      return found ?? (await companies.create({ organizationId, rif: r, legalName, isIgtfCollector: true }, actor));
    };

    // Administrador global (el dueño de la plataforma): ve todas las empresas de todos los clientes.
    const globalAdmin = await user('admin@demo.local', 'Admin Global', true);
    const galaxy = await org('Galaxy (demo)');
    const demo = await makeCompany(galaxy.id, { userId: globalAdmin.id, isSuperAdmin: true }, 'J-12345678-4', 'Repuestos Demo, C.A.');
    const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });
    // Tasa manual de la empresa demo (las oficiales del BCV las trae la sincronización con DolarApi).
    const today = new Date(new Date().toISOString().slice(0, 10));
    await prisma.runWithTenant(demo.id, async tx => {
      if (!(await tx.exchangeRate.findFirst({ where: { currencyId: usd.id, date: today, companyId: demo.id } }))) {
        await tx.exchangeRate.create({ data: { currencyId: usd.id, rate: '36.52', date: today, source: 'MANUAL', companyId: demo.id } });
      }
    });
    if (!(await prisma.runWithTenant(demo.id, tx => tx.product.count()))) {
      await prisma.runWithTenant(demo.id, async tx => {
        const unit = await tx.unit.findFirstOrThrow({ where: { code: 'UND' } });
        const iva = await tx.tax.findFirstOrThrow({ where: { code: 'IVA_GENERAL' } });
        const cat = await tx.category.create({ data: { companyId: demo.id, code: 'FRENOS', name: 'Frenos' } });
        const list = await tx.priceList.findFirstOrThrow({ where: { isDefault: true } });
        for (const p of [{ sku: 'PAS-001', name: 'Pastillas de freno delanteras', oem: '04465-0K290' }, { sku: 'DIS-001', name: 'Disco de freno ventilado', oem: '43512-0K080' }, { sku: 'FIL-001', name: 'Filtro de aceite', oem: '90915-YZZE1' }]) {
          const prod = await tx.product.create({ data: { companyId: demo.id, sku: p.sku, name: p.name, categoryId: cat.id, unitId: unit.id, taxId: iva.id } });
          await tx.productReference.create({ data: { companyId: demo.id, productId: prod.id, refType: 'OEM', code: p.oem } });
          await tx.productPrice.create({ data: { companyId: demo.id, productId: prod.id, priceListId: list.id, price: '25' } });
        }
        await tx.supplier.create({ data: { companyId: demo.id, rif: rif('98765432'), legalName: 'Importadora Auto Partes, C.A.', creditDays: 15 } });
        await tx.customer.create({ data: { companyId: demo.id, rif: rif('31234567'), legalName: 'Taller El Mecánico, C.A.', creditDays: 7 } });
      });
    }

    // Clientes de ejemplo: cada administrador de cliente solo ve (y crea) las empresas de SU cliente.
    const clients: { name: string; admin: [string, string]; companies: [string, string][] }[] = [
      { name: 'Cliente KTSU-JAC', admin: ['admin.ktsu@demo.local', 'Admin KTSU/JAC'], companies: [['20000001', 'KTSU'], ['20000002', 'JAC']] },
      { name: 'Cliente Sinocars', admin: ['admin.sinocars@demo.local', 'Admin Sinocars'], companies: [['20000003', 'SIN0CARS'], ['20000004', 'ELECTRICOS DEL SUR']] },
      { name: 'Cliente Ayagba', admin: ['admin.ayagba@demo.local', 'Admin Ayagba'], companies: [['20000005', 'Ayagba Glam']] },
    ];
    for (const c of clients) {
      const o = await org(c.name);
      const admin = await user(c.admin[0], c.admin[1]);
      await prisma.userOrganization.upsert({ where: { userId_organizationId: { userId: admin.id, organizationId: o.id } }, update: { isAdmin: true }, create: { userId: admin.id, organizationId: o.id, isAdmin: true } });
      for (const [base, name] of c.companies) await makeCompany(o.id, { userId: admin.id, isSuperAdmin: false }, rif(base), name);
    }
    console.log('✔ Demo: admin@demo.local (administrador global) y 3 clientes con sus administradores');
  }
  console.log(`  Contraseña de semilla: ${pwd === 'Admin12345!' ? 'Admin12345! (solo desarrollo)' : '(SEED_PASSWORD)'}`);
  await app.close();
}
main().catch(e => { console.error(e); process.exit(1); });
