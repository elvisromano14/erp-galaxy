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

const CURRENCIES = [
  { code: 'VES', name: 'Bolívar', symbol: 'Bs', decimals: 2 },
  { code: 'USD', name: 'Dólar estadounidense', symbol: '$', decimals: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
];

// Códigos de 4 dígitos (SUDEBAN). Verificar vigencia antes de producción.
const BANKS = [
  ['0102', 'Banco de Venezuela'], ['0104', 'Venezolano de Crédito'], ['0105', 'Mercantil'], ['0108', 'Provincial'],
  ['0114', 'Bancaribe'], ['0115', 'Banco Exterior'], ['0128', 'Banco Caroní'], ['0134', 'Banesco'], ['0137', 'Sofitasa'],
  ['0138', 'Banco Plaza'], ['0151', 'BFC Banco Fondo Común'], ['0156', '100% Banco'], ['0157', 'Del Sur'],
  ['0163', 'Banco del Tesoro'], ['0166', 'Banco Agrícola de Venezuela'], ['0168', 'Bancrecer'], ['0169', 'Mi Banco'],
  ['0171', 'Banco Activo'], ['0172', 'Bancamiga'], ['0174', 'Banplus'], ['0175', 'Banco Bicentenario'], ['0177', 'Banfanb'], ['0191', 'BNC'],
];

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
    const exists = await prisma.company.findUnique({ where: { rif: 'J-12345678-4' } });
    if (!exists) {
      const company = await companies.create({
        rif: 'J-12345678-4', legalName: 'Repuestos Demo, C.A.', tradeName: 'Repuestos Demo', fiscalAddress: 'Caracas, Venezuela',
        isIgtfCollector: true, admin: { email: 'admin@demo.local', fullName: 'Admin Demo', password: pwd },
      });
      const usd = await prisma.currency.findUniqueOrThrow({ where: { code: 'USD' } });
      await prisma.exchangeRate.create({ data: { currencyId: usd.id, rate: '36.52', date: new Date(new Date().toISOString().slice(0, 10)), source: 'MANUAL' } });
      await prisma.runWithTenant(company.id, async tx => {
        const unit = await tx.unit.findFirstOrThrow({ where: { code: 'UND' } });
        const iva = await tx.tax.findFirstOrThrow({ where: { code: 'IVA_GENERAL' } });
        const cat = await tx.category.create({ data: { companyId: company.id, code: 'FRENOS', name: 'Frenos' } });
        const list = await tx.priceList.findFirstOrThrow({ where: { isDefault: true } });
        const products = [
          { sku: 'PAS-001', name: 'Pastillas de freno delanteras', oem: '04465-0K290' },
          { sku: 'DIS-001', name: 'Disco de freno ventilado', oem: '43512-0K080' },
          { sku: 'FIL-001', name: 'Filtro de aceite', oem: '90915-YZZE1' },
        ];
        for (const p of products) {
          const prod = await tx.product.create({ data: { companyId: company.id, sku: p.sku, name: p.name, categoryId: cat.id, unitId: unit.id, taxId: iva.id } });
          await tx.productReference.create({ data: { companyId: company.id, productId: prod.id, refType: 'OEM', code: p.oem } });
          await tx.productPrice.create({ data: { companyId: company.id, productId: prod.id, priceListId: list.id, price: '25' } });
        }
        await tx.supplier.create({ data: { companyId: company.id, rif: 'J-98765432-4', legalName: 'Importadora Auto Partes, C.A.', creditDays: 15 } });
        await tx.customer.create({ data: { companyId: company.id, rif: 'J-31234567-5', legalName: 'Taller El Mecánico, C.A.', creditDays: 7 } });
      });
      console.log('✔ Empresa demo creada: admin@demo.local (J-12345678-4)');
    } else console.log('• Empresa demo ya existe');
  }
  console.log(`  Contraseña de semilla: ${pwd === 'Admin12345!' ? 'Admin12345! (solo desarrollo)' : '(SEED_PASSWORD)'}`);
  await app.close();
}
main().catch(e => { console.error(e); process.exit(1); });
