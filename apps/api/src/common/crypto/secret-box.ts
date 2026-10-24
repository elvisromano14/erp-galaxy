import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BusinessRuleException } from '../errors/errors';

/**
 * Cifrado de secretos en reposo (AES-256-GCM). La llave sale de `INTEGRATION_SECRET_KEY` (entorno del servidor, nunca
 * de la base). Formato: `v1.<iv>.<tag>.<cifrado>` en base64url. Sin llave configurada no se guarda ningún secreto.
 */
const keyFrom = (secret: string | undefined): Buffer => {
  if (!secret) throw new BusinessRuleException('El servidor no tiene configurada la llave de cifrado (INTEGRATION_SECRET_KEY)', 'SECRET_KEY_MISSING');
  return createHash('sha256').update(secret).digest();
};

export function encryptSecret(plain: string, secret: string | undefined): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(blob: string, secret: string | undefined): string {
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new BusinessRuleException('Secreto cifrado con formato desconocido', 'SECRET_FORMAT');
  try {
    const d = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    if (e instanceof BusinessRuleException) throw e;
    throw new BusinessRuleException('No se pudo descifrar el secreto (¿cambió la llave del servidor?)', 'SECRET_DECRYPT');
  }
}
