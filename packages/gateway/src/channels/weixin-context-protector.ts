import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const ENVELOPE_FIELDS = ['algorithm', 'ciphertext', 'keyId', 'nonce', 'tag', 'version'];
const FINGERPRINT_DOMAIN = 'weixin-context-fingerprint-v1';

export type WeixinKeyMaterial = {
  keyId: string;
  key: Uint8Array;
};

export type WeixinVersionedFingerprint = {
  value: string;
  keyId: string;
};

export type WeixinSealedContext = {
  /** JSON envelope with its own version, algorithm, key ID, nonce, ciphertext, and tag. */
  ciphertext: string;
  /** Duplicated outside the envelope for a sidecar key-ID column; open requires an exact match. */
  keyId: string;
  fingerprint: WeixinVersionedFingerprint;
};

export interface WeixinTrustedKeyResolver {
  currentEncryptionKey(): WeixinKeyMaterial;
  encryptionKey(keyId: string): Uint8Array | undefined;
  currentFingerprintKey(): WeixinKeyMaterial;
  fingerprintKey(keyId: string): Uint8Array | undefined;
}

/** Versioned successor to the candidate Weixin protector port.
 * The candidate's legacy string fingerprint port cannot represent key rotation. */
export interface VersionedWeixinContextProtector {
  seal(value: string, aad: string): WeixinSealedContext;
  open(value: { ciphertext: string; keyId: string }, aad: string): string;
  fingerprint(value: string, aad: string): WeixinVersionedFingerprint;
  verifyFingerprint(value: string, aad: string, expected: WeixinVersionedFingerprint): boolean;
}

type Envelope = {
  version: 1;
  algorithm: 'A256GCM';
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

type CopiedKey = { keyId: string; bytes: Buffer };

function fail(code: string): never {
  throw new Error(code);
}

function validateValueAndAad(value: unknown, aad: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    fail('weixin_protector_value_invalid');
  }
  if (typeof aad !== 'string' || Buffer.from(aad, 'utf8').toString('utf8') !== aad) {
    fail('weixin_protector_aad_invalid');
  }
}

function validateKeyId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !KEY_ID.test(value)) fail('weixin_protector_key_id_invalid');
}

function copyKey(value: unknown, keyId: unknown): CopiedKey {
  validateKeyId(keyId);
  if (!(value instanceof Uint8Array) || value.byteLength !== KEY_BYTES) {
    fail('weixin_protector_key_invalid');
  }
  return { keyId, bytes: Buffer.from(value) };
}

function currentKey(resolve: () => WeixinKeyMaterial, failureCode = 'weixin_protector_key_unavailable'): CopiedKey {
  let material: WeixinKeyMaterial;
  try {
    material = resolve();
  } catch {
    fail(failureCode);
  }
  if (!material || typeof material !== 'object') fail(failureCode);
  return copyKey(material.key, material.keyId);
}

function storedKey(keyId: string, resolve: (keyId: string) => Uint8Array | undefined,
  failureCode = 'weixin_protector_key_unavailable'): CopiedKey {
  validateKeyId(keyId);
  let material: Uint8Array | undefined;
  try {
    material = resolve(keyId);
  } catch {
    fail(failureCode);
  }
  if (material === undefined) fail(failureCode);
  return copyKey(material, keyId);
}

function base64Url(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    fail('weixin_protector_envelope_invalid');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) {
    fail('weixin_protector_envelope_invalid');
  }
  return bytes;
}

function parseEnvelope(value: unknown, externalKeyId: unknown): { envelope: Envelope; nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  if (typeof value !== 'string' || typeof externalKeyId !== 'string') fail('weixin_protector_envelope_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('weixin_protector_envelope_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('weixin_protector_envelope_invalid');
  const envelope = parsed as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(',') !== ENVELOPE_FIELDS.join(',')
    || envelope.version !== 1 || envelope.algorithm !== 'A256GCM'
    || typeof envelope.keyId !== 'string' || !KEY_ID.test(envelope.keyId)
    || envelope.keyId !== externalKeyId
    || typeof envelope.nonce !== 'string' || typeof envelope.ciphertext !== 'string'
    || typeof envelope.tag !== 'string') {
    fail('weixin_protector_envelope_invalid');
  }
  const nonce = base64Url(envelope.nonce, NONCE_BYTES);
  const ciphertext = base64Url(envelope.ciphertext);
  const tag = base64Url(envelope.tag, TAG_BYTES);
  return { envelope: envelope as Envelope, nonce, ciphertext, tag };
}

function fingerprintWithKey(value: string, aad: string, key: CopiedKey): WeixinVersionedFingerprint {
  const digest = createHmac('sha256', key.bytes)
    .update(JSON.stringify([FINGERPRINT_DOMAIN, aad, value]), 'utf8')
    .digest('hex');
  return { value: digest, keyId: key.keyId };
}

export function createVersionedWeixinContextProtector(
  keys: WeixinTrustedKeyResolver,
): VersionedWeixinContextProtector {
  if (!keys || typeof keys.currentEncryptionKey !== 'function' || typeof keys.encryptionKey !== 'function'
    || typeof keys.currentFingerprintKey !== 'function' || typeof keys.fingerprintKey !== 'function') {
    fail('weixin_protector_key_resolver_required');
  }

  return {
    seal(value, aad) {
      validateValueAndAad(value, aad);
      const encryptionKey = currentKey(() => keys.currentEncryptionKey());
      try {
        const fingerprintKey = currentKey(() => keys.currentFingerprintKey(),
          'weixin_protector_fingerprint_key_unavailable');
        try {
          const nonce = randomBytes(NONCE_BYTES);
          const cipher = createCipheriv('aes-256-gcm', encryptionKey.bytes, nonce, { authTagLength: TAG_BYTES });
          cipher.setAAD(Buffer.from(aad, 'utf8'));
          const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
          const envelope: Envelope = {
            version: 1,
            algorithm: 'A256GCM',
            keyId: encryptionKey.keyId,
            nonce: nonce.toString('base64url'),
            ciphertext: encrypted.toString('base64url'),
            tag: cipher.getAuthTag().toString('base64url'),
          };
          return {
            ciphertext: JSON.stringify(envelope),
            keyId: encryptionKey.keyId,
            fingerprint: fingerprintWithKey(value, aad, fingerprintKey),
          };
        } finally {
          fingerprintKey.bytes.fill(0);
        }
      } finally {
        encryptionKey.bytes.fill(0);
      }
    },

    open(value, aad) {
      validateValueAndAad(value?.ciphertext, aad);
      const parsed = parseEnvelope(value.ciphertext, value.keyId);
      const encryptionKey = storedKey(parsed.envelope.keyId, keyId => keys.encryptionKey(keyId));
      try {
        try {
          const decipher = createDecipheriv('aes-256-gcm', encryptionKey.bytes, parsed.nonce,
            { authTagLength: TAG_BYTES });
          decipher.setAAD(Buffer.from(aad, 'utf8'));
          decipher.setAuthTag(parsed.tag);
          const plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
          return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
        } catch {
          fail('weixin_protector_authentication_failed');
        }
      } finally {
        encryptionKey.bytes.fill(0);
      }
    },

    fingerprint(value, aad) {
      validateValueAndAad(value, aad);
      const fingerprintKey = currentKey(() => keys.currentFingerprintKey(),
        'weixin_protector_fingerprint_key_unavailable');
      try {
        return fingerprintWithKey(value, aad, fingerprintKey);
      } finally {
        fingerprintKey.bytes.fill(0);
      }
    },

    verifyFingerprint(value, aad, expected) {
      validateValueAndAad(value, aad);
      if (!expected || typeof expected !== 'object' || !FINGERPRINT.test(expected.value)) {
        fail('weixin_protector_fingerprint_invalid');
      }
      validateKeyId(expected.keyId);
      const fingerprintKey = storedKey(expected.keyId, keyId => keys.fingerprintKey(keyId),
        'weixin_protector_key_unavailable');
      try {
        const actual = Buffer.from(fingerprintWithKey(value, aad, fingerprintKey).value, 'hex');
        const wanted = Buffer.from(expected.value, 'hex');
        return timingSafeEqual(actual, wanted);
      } finally {
        fingerprintKey.bytes.fill(0);
      }
    },
  };
}
