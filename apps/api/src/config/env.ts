import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3101),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  /** Llave para cifrar en reposo las claves de las conexiones a Saint (sin ella no se pueden guardar). */
  INTEGRATION_SECRET_KEY: z.string().min(32).optional(),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(7),
  /** Ventana en que reusar un refresh token recién rotado se considera una carrera benigna (p. ej. dos pestañas). */
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().default(10),
  /** Saltos de proxy de confianza para `req.ip` (Next → API = 1; con Tailscale Funnel + Next delante de la API = 2). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  LOG_LEVEL: z.string().default('info'),
  /** Procesa las colas de BullMQ (reportes en segundo plano, tareas periódicas) dentro de este proceso. Puede correr aparte con `pnpm worker`. */
  WORKER_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  /** Prefijo de las claves de BullMQ en Redis (separa entornos que comparten Redis). */
  QUEUE_PREFIX: z.string().default('erp'),
  /** Tope de filas de un reporte generado en segundo plano (PDF se limita aparte a 5 000). */
  REPORT_ASYNC_ROW_CAP: z.coerce.number().default(300000),
  /** Horas que se conserva el archivo de un reporte en segundo plano. */
  REPORT_FILE_TTL_HOURS: z.coerce.number().default(72),
  /** Sincronización de la tasa oficial (BCV) con DolarApi. */
  FX_API_URL: z.string().url().default('https://ve.dolarapi.com/v1'),
  /** Leyenda al pie de facturas/notas mientras la numeración sea interna (antes de la imprenta digital). */
  // App móvil
  MOBILE_MIN_APP_VERSION: z.string().default('1.0.0'),
  MOBILE_LATEST_APP_VERSION: z.string().default('1.0.0'),
  MOBILE_SCHEMA_VERSION: z.coerce.number().int().default(1),
  /** Directorio con el APK publicado y su `latest.json` (lo llena `deploy/publish-apk.sh`). */
  MOBILE_APK_DIR: z.string().default('/data/apk'),
  MOBILE_MAX_DEVICES_PER_USER: z.coerce.number().int().min(1).default(1),
  MOBILE_MAINTENANCE_MESSAGE: z.string().optional(),
  INVOICE_LEGEND: z.string().default('Documento sin validez fiscal: numeración interna provisional'),
  /** Tareas periódicas de mantenimiento (vencimiento de cotizaciones). */
  JOBS_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  FX_SYNC_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  FX_SYNC_INTERVAL_MINUTES: z.coerce.number().min(5).default(120),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().default(15),
  THROTTLE_LOGIN_PER_MIN: z.coerce.number().default(10),
  /** Límite por minuto de operaciones costosas (importaciones, extractos, exportaciones en segundo plano). */
  THROTTLE_HEAVY_PER_MIN: z.coerce.number().default(20),
  THROTTLE_DEFAULT_PER_MIN: z.coerce.number().default(600),
});

export type Env = z.infer<typeof schema>;
export const env: Env = schema.parse(process.env);
