import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDirectory } from './artifacts';

/**
 * API keys are stored AES-256-GCM encrypted in PostgreSQL. The key-encryption key comes from
 * OPENTUTOR_SECRET_KEY, or else from a 0600 file in the data directory that Web and Worker share.
 * A database dump alone therefore never contains usable provider keys.
 */
let cached: { source: string; key: Buffer } | undefined;
function masterKey(): Buffer {
  const configured = process.env.OPENTUTOR_SECRET_KEY?.trim();
  if (configured) {
    if (cached?.source === configured) return cached.key;
    cached = { source: configured, key: createHash('sha256').update(configured).digest() };
    return cached.key;
  }
  const file = path.join(/* turbopackIgnore: true */ dataDirectory(), 'secret.key');
  if (cached?.source === file) return cached.key;
  mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  if (!existsSync(/* turbopackIgnore: true */ file)) {
    try { writeFileSync(/* turbopackIgnore: true */ file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  try { chmodSync(/* turbopackIgnore: true */ file, 0o600); } catch { /* Best effort on filesystems without POSIX modes. */ }
  const key = Buffer.from(readFileSync(/* turbopackIgnore: true */ file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('data 目录中的 secret.key 无效；删除后需要重新填写各供应商的 API Key');
  cached = { source: file, key };
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}
export function decryptSecret(value: string): string {
  const [version, iv, tag, body] = value.split(':');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('API Key 密文格式无效');
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new Error('API Key 无法解密：加密密钥已变化，请在“模型设置”里重新填写 Key'); }
}
export const keyHint = (secret: string) => secret.length > 8 ? `…${secret.slice(-4)}` : '已保存';
