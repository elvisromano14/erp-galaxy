/**
 * Pruebas de carga del ERP (HTTP real contra una API levantada con una base aparte). No se ejecuta en producción.
 *   bash loadtest/run.sh        # crea la base `minierp_load`, levanta la API en :3402, corre los escenarios y la apaga
 * Escenarios: login (argon2), lecturas (listado/existencias/valorizado), facturación de contado concurrente sobre muchos productos
 * y contención sobre UN producto con stock limitado (nunca debe haber stock negativo ni números repetidos).
 */
import autocannon from 'autocannon';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3402';
const API = `${BASE}/api/v1`;
const PASSWORD = 'LoadTest12345!';
const rnd = () => Math.random().toString(36).slice(2, 8);
const out = { startedAt: new Date().toISOString(), scenarios: {} };

async function call(method, path, token, body, extra = {}) {
  const t0 = performance.now();
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const ms = performance.now() - t0;
  let j = null; try { j = await r.json(); } catch { /* vacío */ }
  return { status: r.status, body: j, ms };
}
const must = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body.data; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const stats = (a) => ({ n: a.length, p50: +pct(a, 0.5).toFixed(0), p95: +pct(a, 0.95).toFixed(0), p99: +pct(a, 0.99).toFixed(0), max: +Math.max(0, ...a).toFixed(0) });

// ───────── preparación: superadmin → cliente → empresa → catálogo
const sup = await call('POST', '/auth/login', null, { email: 'loadadmin@erp.local', password: PASSWORD });
const superToken = must(sup, 'login superadmin').accessToken;
const org = must(await call('POST', '/organizations', superToken, { name: 'Carga', admin: { email: `org-${rnd()}@load.test`, fullName: 'Admin Carga', password: PASSWORD } }), 'org');
const adminEmail = `admin-${rnd()}@load.test`;
const company = must(await call('POST', '/companies', superToken, { organizationId: org.id, rif: process.env.LOAD_RIF ?? 'J-12345678-4', legalName: 'Empresa de Carga, C.A.', admin: { email: adminEmail, fullName: 'Admin', password: PASSWORD } }), 'company');
let token = must(await call('POST', '/auth/login', null, { email: adminEmail, password: PASSWORD }), 'login admin').accessToken;
const T = (p, b, m = 'POST') => call(m, p, token, b);
const list = async (p) => must(await T(p, undefined, 'GET'), p);
const currencies = await list('/currencies?limit=10'); const usd = currencies.find(c => c.code === 'USD').id, ves = currencies.find(c => c.code === 'VES').id;
await T('/exchange-rates', { currencyId: usd, rate: '40', date: new Date().toISOString().slice(0, 10) });
const units = await list('/units?limit=50'); const wh = (await list('/warehouses'))[0].id;
const bank = (await list('/banks?limit=5'))[0].id;
const acc = must(await T('/bank-accounts', { bankId: bank, name: 'Caja carga', number: '01020000000000099999', currencyId: ves, overdraftLimit: '999999999' }), 'cuenta').id;
const method = must(await T('/payment-methods', { code: 'TRF', name: 'Transferencia', type: 'TRANSFER' }), 'instrumento').id;
const customer = must(await T('/customers', { rif: 'J-40404040-4', legalName: 'Cliente de carga' }), 'cliente').id;

// importación masiva (productos + existencias): mide el importador
const N_PRODUCTS = Number(process.env.N_PRODUCTS ?? 3000);
const csv = (h, rows) => Buffer.from('﻿' + [h, ...rows].map(r => r.join(';')).join('\n'), 'utf8');
const upload = async (type, buf) => {
  const fd = new FormData(); fd.append('file', new Blob([buf]), `${type}.csv`);
  const t0 = performance.now();
  const r = await fetch(`${API}/imports/${type}?mode=commit`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  return { status: r.status, body: await r.json(), ms: performance.now() - t0 };
};
const prods = Array.from({ length: N_PRODUCTS }, (_, i) => [`LT-${String(i + 1).padStart(5, '0')}`, `Repuesto de carga ${i + 1}`, 'UND', 'IVA_GENERAL', '', '5', '20', '', '', String(10 + (i % 90))]);
let r = await upload('products', csv(['sku', 'nombre', 'unidad', 'impuesto', 'instancia', 'stock_minimo', 'stock_maximo', 'codigos_barras', 'codigos_oem', 'precio'], prods));
out.scenarios.importProducts = { rows: N_PRODUCTS, status: r.status, seconds: +(r.ms / 1000).toFixed(1) };
if (r.status >= 300) throw new Error('import productos: ' + JSON.stringify(r.body));
await T('/price-lists', { code: 'GEN', name: 'General', currencyId: ves, isDefault: true });
r = await upload('opening-stock', csv(['sku', 'deposito', 'cantidad', 'costo_unitario'], prods.map(p => [p[0], 'PRINCIPAL', '1000', '2'])));
out.scenarios.importStock = { rows: N_PRODUCTS, status: r.status, seconds: +(r.ms / 1000).toFixed(1) };
if (r.status >= 300) throw new Error('import stock: ' + JSON.stringify(r.body));
const products = (await list(`/products?limit=100`)); // 100 productos para vender
const withPrice = []; for (const p of products.slice(0, 60)) withPrice.push(p.id);

// ───────── A) login (argon2) concurrente
{
  const lat = []; let fail = 0; const t0 = performance.now();
  await Promise.all(Array.from({ length: 8 }, async () => { for (let i = 0; i < 12; i++) { const x = await call('POST', '/auth/login', null, { email: adminEmail, password: PASSWORD }); lat.push(x.ms); if (x.status !== 200) fail++; } }));
  out.scenarios.login = { concurrency: 8, requests: lat.length, failures: fail, rps: +(lat.length / ((performance.now() - t0) / 1000)).toFixed(1), latencyMs: stats(lat) };
}

// ───────── B) lecturas con autocannon
async function cannon(name, path, connections = 20, duration = 10) {
  const res = await autocannon({ url: API + path, connections, duration, headers: { authorization: `Bearer ${token}` } });
  out.scenarios[name] = { path, connections, rps: Math.round(res.requests.average), latencyMs: { p50: res.latency.p50, p97_5: res.latency.p97_5, p99: res.latency.p99, max: res.latency.max }, non2xx: res.non2xx, errors: res.errors + res.timeouts };
}
await cannon('readProducts', '/products?limit=20&search=repuesto');
await cannon('readStock', '/inventory/stock?limit=50');
await cannon('readReportJson', '/reports/inventory/stock-valuation');

// ───────── C) facturación de contado concurrente (muchos productos)
const invoiceOnce = async (productId, qty, price = '100') => {
  const c = await T('/sales/invoices', { customerId: customer, warehouseId: wh, currencyId: ves, lines: [{ productId, quantity: String(qty), unitPrice: price }] });
  if (c.status !== 201) return { ok: false, ms: c.ms, code: c.body?.error ?? c.status };
  const total = (qty * Number(price) * 1.16).toFixed(2);
  const f = await T(`/sales/invoices/${c.body.data.id}/confirm`, { payments: [{ paymentMethodId: method, bankAccountId: acc, currencyId: ves, amount: total }] });
  return { ok: f.status === 201, ms: c.ms + f.ms, code: f.body?.error ?? f.status, number: f.body?.data?.number };
};
async function pool(workers, seconds, fn) {
  const results = []; const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: workers }, async (_, w) => { let i = 0; while (Date.now() < end) results.push(await fn(w, i++)); }));
  return results;
}
{
  const before = (await list('/treasury/accounts/balances')).find(a => a.id === acc).balance;
  const t0 = performance.now();
  const res = await pool(Number(process.env.WORKERS ?? 12), Number(process.env.SECONDS ?? 20), (w, i) => invoiceOnce(withPrice[(w * 7 + i) % withPrice.length], 1 + (i % 3)));
  const secs = (performance.now() - t0) / 1000;
  const okRes = res.filter(x => x.ok);
  const numbers = okRes.map(x => x.number).sort();
  const nums = numbers.map(n => Number(n.replace(/\D/g, '')));
  const unique = new Set(numbers).size === numbers.length;
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  const after = (await list('/treasury/accounts/balances')).find(a => a.id === acc).balance;
  const errs = {}; for (const x of res.filter(x => !x.ok)) errs[x.code] = (errs[x.code] ?? 0) + 1;
  out.scenarios.invoiceConcurrent = { workers: Number(process.env.WORKERS ?? 12), invoices: okRes.length, failed: res.length - okRes.length, errors: errs, invoicesPerSecond: +(okRes.length / secs).toFixed(1), latencyMs: stats(okRes.map(x => x.ms)), numbersUnique: unique, numbersContiguous: contiguous, bankDelta: +(Number(after) - Number(before)).toFixed(2) };
}

// ───────── D) contención: un solo producto con stock limitado
{
  const hot = products[70].id;
  const have = (await list(`/products/${hot}/stock`)).totalQuantity;
  // se deja exactamente 50 unidades: descargo del resto
  const excess = Number(have) - 50;
  const d = must(await T('/inventory/discharges', { warehouseId: wh, lines: [{ productId: hot, quantity: String(excess) }] }), 'descargo'); must(await T(`/inventory/discharges/${d.id}/confirm`), 'confirmar descargo');
  const res = await pool(16, 8, () => invoiceOnce(hot, 1));
  const sold = res.filter(x => x.ok).length;
  const errs = {}; for (const x of res.filter(x => !x.ok)) errs[x.code] = (errs[x.code] ?? 0) + 1;
  const left = (await list(`/products/${hot}/stock`)).totalQuantity;
  out.scenarios.hotProduct = { stockStart: 50, attempts: res.length, sold, rejected: res.length - sold, errors: errs, stockEnd: left, oversold: sold > 50, negativeStock: Number(left) < 0, consistent: Number(left) === 50 - sold };
}

// ───────── E) reporte pesado en segundo plano
{
  const t0 = performance.now();
  const j = must(await T('/reports/jobs', { category: 'inventory', report: 'stock-valuation', format: 'xlsx', filters: {} }), 'job');
  let st; do { await new Promise(r => setTimeout(r, 500)); st = must(await T(`/reports/jobs/${j.id}`, undefined, 'GET'), 'estado'); } while (['QUEUED', 'RUNNING'].includes(st.status) && performance.now() - t0 < 120000);
  out.scenarios.reportJobXlsx = { status: st.status, rows: st.rowCount, sizeKB: Math.round((st.sizeBytes ?? 0) / 1024), seconds: +((performance.now() - t0) / 1000).toFixed(1) };
}

out.finishedAt = new Date().toISOString();
writeFileSync(process.env.OUT ?? 'loadtest/result.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
