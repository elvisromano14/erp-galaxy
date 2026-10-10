# Revisión de seguridad (2026-10)

Alcance: API (NestJS), web (Next.js/BFF), base de datos, contenedores y despliegue. Método: revisión de código dirigida a los riesgos habituales
(autenticación, autorización, aislamiento entre empresas, inyección, archivos, cabeceras, dependencias, secretos) más pruebas automáticas.

## Controles que ya existían (verificados)

| Área | Control |
|---|---|
| Aislamiento entre empresas | **RLS obligatorio** (`FORCE ROW LEVEL SECURITY`) en toda tabla con `company_id`, política por `app.company_id` fijado en una transacción por petición (falla cerrada); claves foráneas compuestas `(company_id, id)`; el rol de la aplicación `erp_app` no tiene `BYPASSRLS` ni DDL |
| Autenticación | JWT de acceso de 15 min (lista negra en Redis por `jti`), refresh **rotativo** con detección de reutilización (revoca la familia), contraseñas **argon2id**, bloqueo por intentos (5 → 15 min), límite de intentos por IP |
| Sesión web | El token de acceso vive solo en memoria; el refresh va en cookie `httpOnly`, `SameSite=Lax`, `Secure` en producción y con ruta restringida (`/api/session`) |
| Autorización | RBAC por permisos `módulo:recurso:acción` en cada endpoint; los vendedores solo ven sus documentos; las exportaciones en segundo plano solo las ve su autor |
| Integridad | Kardex, libro bancario y auditoría **inmutables** (triggers y `REVOKE UPDATE/DELETE`); numeración sin huecos bajo concurrencia; idempotencia en POST |
| Entradas | Validación con Zod en todos los cuerpos y consultas (campos desconocidos se descartan); SQL parametrizado (los únicos `Prisma.raw` reciben constantes del código) |
| Archivos | Importaciones y extractos: memoria, máximo 10 MB y 5 000 filas; PDF sin acceso a URL externas |

## Hallazgos y correcciones de esta revisión

| # | Hallazgo | Gravedad | Corrección |
|---|---|---|---|
| 1 | **Interbloqueo del pool de conexiones bajo carga**: servicios que usaban el cliente global (`currency`, `company`, `user`…) dentro de una petición necesitaban una *segunda* conexión; con más peticiones simultáneas que conexiones del pool todas quedaban esperando (denegación de servicio). Lo encontró la prueba de carga | **Alta** | Esas consultas usan ahora la transacción de la petición (`prisma.db`); prueba de regresión `concurrency.e2e-spec.ts` (160 peticiones simultáneas sobre un pool de 25) |
| 2 | Inyección de fórmulas en CSV exportado (`=`, `+`, `-`, `@` en nombres de producto, clientes…) | Media | Los textos que empiezan así se anteponen con `'` |
| 3 | Enumeración de usuarios por tiempo de respuesta en el login (un correo inexistente respondía más rápido que uno real) | Media | Se verifica un hash ficticio argon2id cuando el usuario no existe |
| 4 | Cabeceras de seguridad ausentes en la web | Media | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS y sin `X-Powered-By` |
| 5 | JWT sin algoritmo fijado al verificar | Baja | Se fija `HS256` al firmar y al verificar |
| 6 | Idempotency-Key compartida entre usuarios de una empresa y sin tope de longitud | Baja | El hash incluye al usuario; clave máxima de 128 caracteres |
| 7 | Operaciones costosas con el límite general de 600/min | Baja | Importaciones, extractos y exportaciones en segundo plano: 20/min por IP (`THROTTLE_HEAVY_PER_MIN`) |
| 8 | Libros Excel enormes podían agotar memoria | Baja | Se rechazan hojas con más de 5 100 filas u 80 columnas antes de leerlas |
| 9 | `set-cookie` podía quedar en los registros | Baja | Redactado en el logger |
| 10 | Dependencias con avisos (`uuid`, `js-yaml`, `deepmerge-ts`, `vitest`) | Media/Alta (cadena de herramientas) | Versiones forzadas/actualizadas: `pnpm audit --prod` → **sin vulnerabilidades** |
| 11 | La semilla creaba un administrador con contraseña fija | Media | El arranque de producción (`dist/cli/bootstrap.js`) exige `ADMIN_PASSWORD` de 12+ caracteres, no crea datos de demostración y no modifica un administrador existente |
| 12 | Cliente IP detrás de proxies | Baja | `TRUST_PROXY_HOPS` configurable (2 en producción: Tailscale → Next → API) |

## Despliegue

- Contenedores **sin root** (usuario `node`/`redis`), sistema de archivos de solo lectura, sin capacidades, `no-new-privileges`, con tope de memoria; Podman sin root en el servidor.
- PostgreSQL con roles separados: `erp_migrator` (DDL, solo al migrar), `erp_app` (DML), `erp_backup` (solo lectura). Secretos generados aleatoriamente en `~/.config/erp/*.env` (modo 600).
- La API y Redis solo escuchan en 127.0.0.1; la web en 0.0.0.0:3300 (Next lo exige tras Tailscale Funnel) pero el firewall (UFW) niega todo lo entrante salvo SSH; la publicación es solo por Funnel (HTTPS).
- Swagger deshabilitado en producción.

## Riesgos residuales / recomendaciones

1. **Numeración fiscal provisional** y anulación directa de facturas: requiere definición con el contador y proveedor de imprenta digital (riesgo legal, no técnico).
2. **Copia externa de respaldos**: hoy los respaldos quedan en el mismo servidor.
3. **Acceso desde la tailnet**: cualquier dispositivo de la red Tailscale puede llegar al puerto 3300; si se agregan dispositivos de terceros conviene una regla ACL.
4. Rotación de secretos JWT y de contraseñas de base: manual (reemplazar en `~/.config/erp/*.env` y reiniciar; cerrará las sesiones).
5. Sin 2FA para administradores; recomendable antes de abrir el sistema a más clientes.
6. Las herramientas de desarrollo (jest, eslint, prisma CLI) tienen 3 avisos de auditoría que no viajan en las imágenes de producción.
