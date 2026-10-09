import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { isValidRif } from '@erp/domain';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/db/prisma.service';
import { RedisService } from '../src/common/db/redis.service';
import { setupApp } from '../src/setup-app';
import { CompaniesService } from '../src/modules/companies/companies.service';
import { hashPassword } from '../src/modules/auth/auth.service';

export const PASSWORD = 'Admin12345!';
let counter = 0;

export function uniqueRif(prefix = 'J'): string {
  // 8 dígitos únicos por proceso + dígito verificador válido
  const base = String(10_000_000 + Math.floor(Math.random() * 80_000_000) + counter++).slice(0, 8);
  for (let d = 0; d < 10; d++) { const r = `${prefix}-${base}-${d}`; if (isValidRif(r)) return r; }
  return uniqueRif(prefix);
}

export interface Ctx {
  app: INestApplication;
  prisma: PrismaService;
  http: ReturnType<typeof request>;
  super: string;
  close: () => Promise<void>;
}

export async function bootstrap(): Promise<Ctx> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  setupApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  const companies = app.get(CompaniesService);
  const redis = app.get(RedisService);
  await redis.client.flushdb();
  for (const c of [{ code: 'VES', name: 'Bolívar', symbol: 'Bs', decimals: 2 }, { code: 'USD', name: 'Dólar', symbol: '$', decimals: 2 }, { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 }]) {
    await prisma.currency.upsert({ where: { code: c.code }, update: {}, create: c });
  }
  await prisma.bank.upsert({ where: { code: '0102' }, update: {}, create: { code: '0102', name: 'Banco de Venezuela' } });
  await companies.syncPermissionCatalog();
  await prisma.user.upsert({
    where: { email: 'superadmin@erp.local' }, update: {},
    create: { email: 'superadmin@erp.local', fullName: 'Super', passwordHash: await hashPassword(PASSWORD), isSuperAdmin: true },
  });
  const http = request(app.getHttpServer());
  const sup = await http.post('/api/v1/auth/login').send({ email: 'superadmin@erp.local', password: PASSWORD });
  return { app, prisma, http, super: sup.body.data.accessToken, close: async () => { await app.close(); } };
}

export interface Tenant { companyId: string; adminEmail: string; token: string; rif: string; organizationId: string }

/** Crea un cliente (organización) con su administrador. */
export async function createOrg(ctx: Ctx, name = 'Cliente', adminEmail?: string) {
  const email = adminEmail ?? `orgadmin-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const res = await ctx.http.post('/api/v1/organizations').set('Authorization', `Bearer ${ctx.super}`)
    .send({ name, admin: { email, fullName: `Admin ${name}`, password: PASSWORD } });
  if (res.status !== 201) throw new Error(`createOrg: ${res.status} ${JSON.stringify(res.body)}`);
  return { organizationId: res.body.data.id as string, adminEmail: email };
}

/**
 * Crea una empresa (con administrador propio) y devuelve el token de ese admin con la empresa seleccionada.
 * Si no se indica `organizationId`, se crea un cliente nuevo para ella.
 */
export async function createTenant(ctx: Ctx, name = 'Empresa', organizationId?: string): Promise<Tenant> {
  const orgId = organizationId ?? (await createOrg(ctx, `Cliente de ${name}`)).organizationId;
  const rif = uniqueRif();
  const adminEmail = `admin-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const res = await ctx.http.post('/api/v1/companies').set('Authorization', `Bearer ${ctx.super}`)
    .send({ organizationId: orgId, rif, legalName: `${name} C.A.`, admin: { email: adminEmail, fullName: 'Admin', password: PASSWORD } });
  if (res.status !== 201) throw new Error(`createTenant: ${res.status} ${JSON.stringify(res.body)}`);
  const login = await ctx.http.post('/api/v1/auth/login').send({ email: adminEmail, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login tenant: ${login.status} ${JSON.stringify(login.body)}`);
  return { companyId: res.body.data.id, adminEmail, token: login.body.data.accessToken, rif, organizationId: orgId };
}

export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Atajos REST con token. */
export function client(ctx: Ctx, token: string) {
  const h = auth(token);
  return {
    get: (u: string) => ctx.http.get(`/api/v1${u}`).set(h),
    post: (u: string, b: unknown = {}, extra: Record<string, string> = {}) => ctx.http.post(`/api/v1${u}`).set(h).set(extra).send(b as object),
    patch: (u: string, b: unknown) => ctx.http.patch(`/api/v1${u}`).set(h).send(b as object),
    del: (u: string) => ctx.http.delete(`/api/v1${u}`).set(h),
  };
}

export type Api = ReturnType<typeof client>;

/** Datos base de inventario para pruebas: depósitos, producto, proveedor. */
export async function seedBasics(api: Api) {
  const units = (await api.get('/units?limit=100')).body.data;
  const unitId = units.find((u: any) => u.code === 'UND').id;
  const whs = (await api.get('/warehouses')).body.data;
  const w1 = whs[0].id;
  const w2 = (await api.post('/warehouses', { code: 'SEC', name: 'Secundario' })).body.data.id;
  const taxes = (await api.get('/taxes?limit=100')).body.data;
  const iva = taxes.find((t: any) => t.code === 'IVA_GENERAL').id;
  const currencies = (await api.get('/currencies?limit=10')).body.data;
  const cur = (c: string) => currencies.find((x: any) => x.code === c).id;
  const product = async (sku: string, extra: object = {}) => {
    const r = await api.post('/products', { sku, name: `Producto ${sku}`, unitId, taxId: iva, ...extra });
    if (r.status !== 201) throw new Error(`product ${sku}: ${JSON.stringify(r.body)}`);
    return r.body.data.id as string;
  };
  return { unitId, w1, w2, iva, usd: cur('USD'), ves: cur('VES'), product };
}
