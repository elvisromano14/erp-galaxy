import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { UnauthorizedException } from '@nestjs/common';
import { env } from '../../config/env';
import { NotFoundError } from '../../common/errors/errors';

export interface ApkInfo {
  available: boolean;
  version: string | null; fileName: string | null; sizeBytes: number | null; sha256: string | null; uploadedAt: string | null; notes: string | null;
  /** Versión mínima que exige el servidor (las menores deben actualizarse). */
  minAppVersion: string;
}

/**
 * Distribución de la app móvil desde el propio ERP (sin tiendas): el APK vive en un directorio del servidor (`MOBILE_APK_DIR`) junto con
 * `latest.json` {version, fileName, sha256, sizeBytes, uploadedAt, notes} que escribe `deploy/publish-apk.sh`. La descarga se hace
 * con un enlace firmado de vida corta (para poder abrirlo desde el navegador del teléfono sin sesión) generado por un usuario autorizado.
 */
@Injectable()
export class MobileAppService {
  private dir() { return path.resolve(env.MOBILE_APK_DIR); }

  info(): ApkInfo {
    const none: ApkInfo = { available: false, version: null, fileName: null, sizeBytes: null, sha256: null, uploadedAt: null, notes: null, minAppVersion: env.MOBILE_MIN_APP_VERSION };
    const meta = path.join(this.dir(), 'latest.json');
    if (!existsSync(meta)) return none;
    try {
      const j = JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>;
      const fileName = path.basename(String(j.fileName ?? ''));
      const file = path.join(this.dir(), fileName);
      if (!fileName.endsWith('.apk') || !existsSync(file)) return none;
      return { available: true, version: String(j.version ?? ''), fileName, sizeBytes: statSync(file).size, sha256: String(j.sha256 ?? ''), uploadedAt: String(j.uploadedAt ?? ''), notes: j.notes ? String(j.notes) : null, minAppVersion: env.MOBILE_MIN_APP_VERSION };
    } catch { return none; }
  }

  /** Ruta absoluta del APK vigente (404 si no hay). */
  file(): { path: string; fileName: string; info: ApkInfo } {
    const info = this.info();
    if (!info.available || !info.fileName) throw new NotFoundError('APK de la app móvil');
    return { path: path.join(this.dir(), info.fileName), fileName: info.fileName, info };
  }

  // ───────────── enlace de descarga firmado ─────────────
  private key() { return createHmac('sha256', 'apk-download').update(env.JWT_ACCESS_SECRET).digest(); }
  private sign(payload: string) { return createHmac('sha256', this.key()).update(payload).digest('base64url'); }

  /** Enlace de descarga válido `ttlSeconds` (por omisión 10 min). */
  createLink(userId: string, ttlSeconds = 600): { token: string; expiresAt: string } {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ exp, u: userId })).toString('base64url');
    return { token: `${payload}.${this.sign(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  verify(token: string): { userId: string } {
    const [payload, sig] = token.split('.');
    const bad = () => new UnauthorizedException({ error: 'DOWNLOAD_LINK_INVALID', message: 'El enlace de descarga no es válido o venció: genere uno nuevo' });
    if (!payload || !sig) throw bad();
    const expected = Buffer.from(this.sign(payload)); const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad();
    try {
      const { exp, u } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp: number; u: string };
      if (!exp || exp < Math.floor(Date.now() / 1000)) throw bad();
      return { userId: u };
    } catch (e) { if (e instanceof UnauthorizedException) throw e; throw bad(); }
  }
}
