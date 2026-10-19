import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;

export const encryptedEnvelopeSchema = z
  .object({
    version: z.literal(ENVELOPE_VERSION),
    algorithm: z.literal(ALGORITHM),
    nonce: z.string().base64(),
    ciphertext: z.string().base64(),
    authenticationTag: z.string().base64(),
  })
  .strict();

export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

const assertKey = (key: Uint8Array): Buffer => {
  const buffer = Buffer.from(key);
  if (buffer.byteLength !== 32) {
    throw new Error('Vault key must be exactly 32 bytes.');
  }
  return buffer;
};

export const encryptBytes = (plaintext: Uint8Array, key: Uint8Array): EncryptedEnvelope => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, assertKey(key), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authenticationTag: cipher.getAuthTag().toString('base64'),
  };
};

export const decryptBytes = (envelopeValue: unknown, key: Uint8Array): Buffer => {
  const envelope = encryptedEnvelopeSchema.parse(envelopeValue);
  const decipher = createDecipheriv(ALGORITHM, assertKey(key), Buffer.from(envelope.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
};

export const encryptJson = <T>(value: T, key: Uint8Array): EncryptedEnvelope =>
  encryptBytes(Buffer.from(JSON.stringify(value), 'utf8'), key);

export const decryptJson = <T>(value: unknown, key: Uint8Array, schema: z.ZodType<T>): T => {
  const plaintext = decryptBytes(value, key);
  return schema.parse(JSON.parse(plaintext.toString('utf8')));
};
