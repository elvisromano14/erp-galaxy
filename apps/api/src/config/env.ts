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
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(7),
  /** Ventana en que reusar un refresh token recién rotado se considera una carrera benigna (p. ej. dos pestañas). */
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().default(10),
  LOG_LEVEL: z.string().default('info'),
  WORKER_ENABLED: z.coerce.boolean().default(false),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().default(15),
  THROTTLE_LOGIN_PER_MIN: z.coerce.number().default(10),
  THROTTLE_DEFAULT_PER_MIN: z.coerce.number().default(600),
});

export type Env = z.infer<typeof schema>;
export const env: Env = schema.parse(process.env);
