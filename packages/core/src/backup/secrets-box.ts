/**
 * Secrets inside a backup (v0.7 Q): only when the owner gives a passphrase, never otherwise.
 *
 *   key  = scrypt(passphrase, salt, 32 bytes, N = 2^17, r = 8, p = 1), salt = 16 random bytes
 *   data = AES-256-GCM(key, iv = 12 random bytes, aad = "sebeto-secrets/1") over JSON { name: value }
 *
 * Node's crypto only. The passphrase and the key are never stored or logged; a wrong passphrase and
 * a changed byte both fail the GCM tag check (one plain message for both).
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from 'node:crypto';
import { MAX_BACKUP_PASSPHRASE, MIN_BACKUP_PASSPHRASE } from '@sebeto/shared';

export const SECRETS_FORMAT = 'sebeto-secrets/1';
const AAD = Buffer.from(SECRETS_FORMAT, 'utf8');
export const DEFAULT_SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
/** Upper bounds accepted when reading a file (a crafted file must not make us burn memory/CPU). */
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 4;

export class SecretsBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsBoxError';
  }
}

interface Envelope {
  format: typeof SECRETS_FORMAT;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

/** Throws when the passphrase is missing, too short or too long. */
export function checkPassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== 'string') throw new SecretsBoxError('The passphrase must be text.');
  if ([...passphrase].length < MIN_BACKUP_PASSPHRASE) throw new SecretsBoxError(`The passphrase must be at least ${MIN_BACKUP_PASSPHRASE} characters long.`);
  if (passphrase.length > MAX_BACKUP_PASSPHRASE) throw new SecretsBoxError('The passphrase is too long.');
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const opts: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scryptCb(passphrase.normalize('NFC'), salt, 32, opts, (err, key) => (err ? reject(new SecretsBoxError('Could not derive the key from the passphrase.')) : resolve(key)));
  });
}

export async function sealSecrets(values: Record<string, string>, passphrase: string, params: { N: number; r: number; p: number } = DEFAULT_SCRYPT): Promise<Buffer> {
  checkPassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, params);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(values), 'utf8')), cipher.final()]);
    const env: Envelope = {
      format: SECRETS_FORMAT,
      kdf: { name: 'scrypt', N: params.N, r: params.r, p: params.p, salt: salt.toString('base64') },
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    return Buffer.from(JSON.stringify(env), 'utf8');
  } finally {
    key.fill(0);
  }
}

export async function openSecrets(sealed: Buffer, passphrase: string): Promise<Record<string, string>> {
  let env: Envelope;
  try {
    env = JSON.parse(sealed.toString('utf8')) as Envelope;
  } catch {
    throw new SecretsBoxError('The encrypted secrets are damaged.');
  }
  const k = env?.kdf;
  if (env?.format !== SECRETS_FORMAT || env.cipher !== 'aes-256-gcm' || k?.name !== 'scrypt'
    || !Number.isInteger(k.N) || k.N < 2 ** 14 || k.N > MAX_N || (k.N & (k.N - 1)) !== 0
    || !Number.isInteger(k.r) || k.r < 1 || k.r > MAX_R || !Number.isInteger(k.p) || k.p < 1 || k.p > MAX_P
    || typeof k.salt !== 'string' || typeof env.iv !== 'string' || typeof env.tag !== 'string' || typeof env.data !== 'string') {
    throw new SecretsBoxError('The encrypted secrets are in an unknown format.');
  }
  const salt = Buffer.from(k.salt, 'base64');
  const iv = Buffer.from(env.iv, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  if (salt.length < 16 || iv.length !== 12 || tag.length !== 16) throw new SecretsBoxError('The encrypted secrets are damaged.');
  if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > MAX_BACKUP_PASSPHRASE) {
    throw new SecretsBoxError('Wrong passphrase, or the encrypted secrets were changed.');
  }
  const key = await deriveKey(passphrase, salt, k);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]);
    const values = JSON.parse(plain.toString('utf8')) as unknown;
    plain.fill(0);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('shape');
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(values as Record<string, unknown>)) {
      if (typeof v === 'string') out[name] = v;
    }
    return out;
  } catch {
    throw new SecretsBoxError('Wrong passphrase, or the encrypted secrets were changed.');
  } finally {
    key.fill(0);
  }
}
