import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM encryption for secrets stored at rest (LLM API keys,
// git access tokens). Key comes from ENCRYPTION_KEY (64 hex chars = 32 bytes).
//
// Stored format: `v1:<iv>:<tag>:<ciphertext>` — all parts base64.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM
const VERSION = 'v1';

const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decrypt(stored: string): string {
  const [version, ivB64, tagB64, ciphertextB64] = stored.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('Malformed encrypted value');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
