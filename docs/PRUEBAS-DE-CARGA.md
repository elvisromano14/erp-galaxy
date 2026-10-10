# Pruebas de carga

Se ejecutan con `bash apps/api/loadtest/run.sh` (crea la base `minierp_load`, levanta la API en `:3402`, corre los escenarios y la apaga; no toca desarrollo ni producción).
Los resultados completos quedan en `apps/api/loadtest/result.json`. Variables: `N_PRODUCTS` (3000), `WORKERS` (12), `SECONDS` (20).

**Entorno de la corrida** (equipo de desarrollo, PostgreSQL 18 y Redis en contenedores locales, pool de 20 conexiones): una sola instancia de la API, 3 000 productos y 3 000 filas de existencias.

| Escenario | Resultado |
|---|---|
| Importación de 3 000 productos / 3 000 existencias iniciales | 0,4 s / 3,3 s |
| Inicio de sesión (argon2id), 8 simultáneos | ≈ 47 req/s, p95 190 ms |
| Listado de productos con búsqueda (20 conexiones) | ≈ 990 req/s, p99 28 ms |
| Existencias (50 filas) | ≈ 470 req/s, p99 52 ms |
| Reporte *Existencias valorizadas* en JSON (≈ 3 000 filas, 420 KB) | ≈ 190 req/s, p99 132 ms |
| **Facturación de contado** (crear + emitir con pago y banco), 12 trabajadores, 20 s | **1 433 facturas, 0 fallos, ≈ 71/s, p95 182 ms** |
| Numeración de esas facturas | únicas **y** correlativas (sin huecos) |
| **Contención sobre un producto** con 50 unidades y 16 trabajadores | 1 601 intentos → **50 vendidas**, 1 551 rechazadas por falta de existencia, stock final 0 (sin sobreventa ni negativos) |
| Exportación Excel en segundo plano (≈ 3 000 filas) | lista en 1 s |

## Qué detectó (y se corrigió)

La primera corrida reveló un **interbloqueo del pool de conexiones**: algunos servicios usaban el cliente global de base de datos dentro de una petición
y necesitaban una segunda conexión; con más peticiones simultáneas que conexiones, todas esperaban. Tras la corrección se repitió la prueba (resultados de arriba)
y se agregó una prueba automática de regresión (`concurrency.e2e-spec.ts`). Ver `docs/SEGURIDAD.md`.

## Capacidad en el VPS

El servidor (2 CPU, 4 GB, compartido con otras aplicaciones) ejecuta un solo proceso de API (~120 MB en reposo) y uno de web (~45 MB). Como referencia, la API
mantiene unas decenas de facturas por segundo en un equipo de escritorio; para decenas de usuarios simultáneos hay margen amplio. Vigile la memoria libre
(el servidor no tiene swap) y los conteos de conexiones a PostgreSQL (la API usa hasta 12; el servidor admite 100 en total para todos los proyectos).
