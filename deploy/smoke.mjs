// Verificación de humo del ERP desplegado (no crea datos). Uso:
//   BASE=https://prod-cloud.tailf30e87.ts.net:10000 ADMIN_EMAIL=... ADMIN_PASSWORD=... node deploy/smoke.mjs
const BASE = process.env.BASE; const EMAIL = process.env.ADMIN_EMAIL; const PASS = process.env.ADMIN_PASSWORD;
if (!BASE || !EMAIL || !PASS) { console.error('Faltan BASE, ADMIN_EMAIL y ADMIN_PASSWORD'); process.exit(2); }
let fails = 0;
const ok = (c, m, extra = '') => { console.log(`${c ? '✔' : '✘'} ${m}${extra ? ' — ' + extra : ''}`); if (!c) fails++; };
const t = async (url, init) => { const t0 = performance.now(); const r = await fetch(url, init); return { r, ms: Math.round(performance.now() - t0) }; };

let { r, ms } = await t(`${BASE}/api/health`);
ok(r.status === 200, 'la web responde', `${r.status} en ${ms} ms`);
const home = await t(`${BASE}/signin`, { redirect: 'manual' });
ok([200, 307].includes(home.r.status), 'la pantalla de ingreso responde (307 = fija el idioma y redirige)', String(home.r.status));
const h = r.headers;
ok(!!h.get('content-security-policy'), 'cabecera Content-Security-Policy');
ok(h.get('x-frame-options') === 'DENY', 'X-Frame-Options: DENY');
ok(h.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
ok(!!h.get('strict-transport-security'), 'Strict-Transport-Security');
ok(!h.get('x-powered-by'), 'sin X-Powered-By');

({ r, ms } = await t(`${BASE}/api/v1/health`));
const health = await r.json().catch(() => ({}));
ok(r.status === 200 && health?.data?.status === 'ok', 'la API responde por el proxy de la web', `${ms} ms`);
({ r } = await t(`${BASE}/api/docs`));
ok(r.status === 404, 'Swagger deshabilitado en producción', String(r.status));
({ r } = await t(`${BASE}/api/v1/auth/me`));
ok(r.status === 401, 'las rutas privadas exigen token', String(r.status));

({ r, ms } = await t(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: 'incorrecta-123' }) }));
ok(r.status === 401, 'contraseña incorrecta → 401 genérico', `${ms} ms`);
({ r, ms } = await t(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'noexiste@erp.galaxy', password: 'incorrecta-123' }) }));
ok(r.status === 401, 'usuario inexistente → 401 (mismo mensaje)', `${ms} ms`);

({ r, ms } = await t(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) }));
const login = await r.json().catch(() => ({}));
ok(r.status === 200 && !!login?.data?.accessToken, 'inicio de sesión del administrador global', `${ms} ms`);
const token = login?.data?.accessToken;
({ r } = await t(`${BASE}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } }));
const me = await r.json().catch(() => ({}));
ok(r.status === 200 && me?.data?.user?.isSuperAdmin === true, 'GET /auth/me del administrador global');
({ r } = await t(`${BASE}/api/v1/organizations`, { headers: { authorization: `Bearer ${token}` } }));
ok(r.status === 200, 'listado de clientes (organizaciones)', String(r.status));
({ r } = await t(`${BASE}/api/v1/reports`, { headers: { authorization: `Bearer ${token}` } }));
ok(r.status === 403, 'sin empresa seleccionada no se accede a datos de empresa', String(r.status));
console.log(fails ? `\n${fails} verificación(es) fallaron` : '\nTodo en orden');
process.exit(fails ? 1 : 0);
