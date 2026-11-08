import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { createVersionedWeixinContextProtector } from '../../src/channels/weixin-context-protector.ts';

const AAD = '["weixin","[\\"bot-a\\",\\"user-a\\"]","","message-1","bot-a","user-a","owner-a","binding-a",1]';
const VALUE = 'fixture-only-context-token';

function key() {
  return randomBytes(32);
}

function resolver(options = {}) {
  const encryptionKeys = options.encryptionKeys ?? new Map([['enc-a', key()]]);
  const fingerprintKeys = options.fingerprintKeys ?? new Map([['fp-a', key()]]);
  const currentEncryptionId = options.currentEncryptionId ?? 'enc-a';
  const currentFingerprintId = options.currentFingerprintId ?? 'fp-a';
  const calls = { currentEncryption: 0, encryptionById: [], currentFingerprint: 0, fingerprintById: [] };
  return {
    calls,
    currentEncryptionKey() {
      calls.currentEncryption++;
      const bytes = encryptionKeys.get(currentEncryptionId);
      return bytes && { keyId: currentEncryptionId, key: bytes };
    },
    encryptionKey(keyId) {
      calls.encryptionById.push(keyId);
      return encryptionKeys.get(keyId);
    },
    currentFingerprintKey() {
      calls.currentFingerprint++;
      const bytes = fingerprintKeys.get(currentFingerprintId);
      return bytes && { keyId: currentFingerprintId, key: bytes };
    },
    fingerprintKey(keyId) {
      calls.fingerprintById.push(keyId);
      return fingerprintKeys.get(keyId);
    },
  };
}

function protector(options) {
  return createVersionedWeixinContextProtector(resolver(options));
}

function readEnvelope(ciphertext) {
  return JSON.parse(ciphertext);
}

function flipByte(value) {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}

test('seals and opens a versioned AES-GCM envelope with its exact AAD and key IDs', () => {
  const instance = protector();
  const sealed = instance.seal(VALUE, AAD);
  const envelope = readEnvelope(sealed.ciphertext);

  assert.deepEqual(Object.keys(envelope).sort(), ['algorithm', 'ciphertext', 'keyId', 'nonce', 'tag', 'version']);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.algorithm, 'A256GCM');
  assert.equal(envelope.keyId, sealed.keyId);
  assert.equal(sealed.keyId, 'enc-a');
  assert.equal(sealed.fingerprint.keyId, 'fp-a');
  assert.match(sealed.fingerprint.value, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(envelope.nonce, 'base64url').length, 12);
  assert.equal(Buffer.from(envelope.tag, 'base64url').length, 16);
  assert.equal(instance.open({ ciphertext: sealed.ciphertext, keyId: sealed.keyId }, AAD), VALUE);
});

test('uses a fresh nonce for each encryption under the same key and AAD', () => {
  const instance = protector();
  const nonces = new Set(Array.from({ length: 12 }, () => readEnvelope(instance.seal(VALUE, AAD).ciphertext).nonce));
  assert.equal(nonces.size, 12);
});

test('rejects owner, binding, or binding-version changes in the exact AAD', () => {
  const instance = protector();
  const sealed = instance.seal(VALUE, AAD);
  const changedAads = [
    AAD.replace('owner-a', 'owner-b'),
    AAD.replace('binding-a', 'binding-b'),
    AAD.replace('binding-a",1', 'binding-a",2'),
  ];

  for (const changedAad of changedAads) {
    assert.throws(() => instance.open({ ciphertext: sealed.ciphertext, keyId: sealed.keyId }, changedAad),
      error => error instanceof Error && error.message === 'weixin_protector_authentication_failed');
  }
});

test('rejects tampered nonce, ciphertext, tag, and an external key ID mismatch', () => {
  const instance = protector();
  const sealed = instance.seal(VALUE, AAD);
  const envelope = readEnvelope(sealed.ciphertext);
  const variants = [
    { ...envelope, nonce: flipByte(envelope.nonce) },
    { ...envelope, ciphertext: flipByte(envelope.ciphertext) },
    { ...envelope, tag: flipByte(envelope.tag) },
  ];

  for (const changed of variants) {
    assert.throws(() => instance.open({ ciphertext: JSON.stringify(changed), keyId: sealed.keyId }, AAD),
      error => error instanceof Error && error.message === 'weixin_protector_authentication_failed');
  }
  assert.throws(() => instance.open({ ciphertext: sealed.ciphertext, keyId: 'enc-b' }, AAD),
    error => error instanceof Error && error.message === 'weixin_protector_envelope_invalid');
});

test('opens old ciphertext and verifies its fingerprint by stored key IDs after rotation and restart', () => {
  const oldEncryptionKey = key();
  const oldFingerprintKey = key();
  const oldInstance = createVersionedWeixinContextProtector(resolver({
    encryptionKeys: new Map([['enc-a', oldEncryptionKey]]),
    fingerprintKeys: new Map([['fp-a', oldFingerprintKey]]),
  }));
  const oldSealed = oldInstance.seal(VALUE, AAD);
  const persistedEnvelope = oldSealed.ciphertext;
  const persistedKeyId = oldSealed.keyId;
  const persistedFingerprint = { ...oldSealed.fingerprint };
  const encryptionKeys = new Map([['enc-a', oldEncryptionKey], ['enc-b', key()]]);
  const fingerprintKeys = new Map([['fp-a', oldFingerprintKey], ['fp-b', key()]]);
  const rotatedResolver = resolver({ encryptionKeys, fingerprintKeys,
    currentEncryptionId: 'enc-b', currentFingerprintId: 'fp-b' });
  const restartedInstance = createVersionedWeixinContextProtector(rotatedResolver);

  assert.equal(restartedInstance.open({ ciphertext: persistedEnvelope, keyId: persistedKeyId }, AAD), VALUE);
  assert.equal(restartedInstance.verifyFingerprint(VALUE, AAD, persistedFingerprint), true);
  assert.equal(rotatedResolver.calls.encryptionById.at(-1), 'enc-a');
  assert.equal(rotatedResolver.calls.fingerprintById.at(-1), 'fp-a');
  const newFingerprint = restartedInstance.fingerprint(VALUE, AAD);
  assert.equal(newFingerprint.keyId, 'fp-b');
  assert.notEqual(newFingerprint.value, persistedFingerprint.value);
  const newSealed = restartedInstance.seal(VALUE, AAD);
  assert.equal(readEnvelope(newSealed.ciphertext).keyId, 'enc-b');
  assert.equal(newSealed.fingerprint.keyId, 'fp-b');
});

test('fails closed on missing stored keys without falling back to current keys', () => {
  const original = protector();
  const sealed = original.seal(VALUE, AAD);
  const missingKeys = resolver({
    encryptionKeys: new Map([['enc-b', key()]]),
    fingerprintKeys: new Map([['fp-b', key()]]),
    currentEncryptionId: 'enc-b', currentFingerprintId: 'fp-b',
  });
  const restartedInstance = createVersionedWeixinContextProtector(missingKeys);

  assert.throws(() => restartedInstance.open({ ciphertext: sealed.ciphertext, keyId: sealed.keyId }, AAD),
    error => error instanceof Error && error.message === 'weixin_protector_key_unavailable');
  assert.throws(() => restartedInstance.verifyFingerprint(VALUE, AAD, sealed.fingerprint),
    error => error instanceof Error && error.message === 'weixin_protector_key_unavailable');
  assert.deepEqual(missingKeys.calls.encryptionById, ['enc-a']);
  assert.deepEqual(missingKeys.calls.fingerprintById, ['fp-a']);
  assert.equal(missingKeys.calls.currentEncryption, 0);
  assert.equal(missingKeys.calls.currentFingerprint, 0);
});

test('fingerprints bind value and AAD and verify without logging context or key material', () => {
  const instance = protector();
  const fingerprint = instance.fingerprint(VALUE, AAD);
  let logCalls = 0;
  const original = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug']
    .map(name => [name, console[name]]));
  for (const name of Object.keys(original)) console[name] = () => { logCalls++; };
  try {
    assert.equal(instance.verifyFingerprint(VALUE, AAD, fingerprint), true);
    assert.equal(instance.verifyFingerprint(`${VALUE}-changed`, AAD, fingerprint), false);
    assert.equal(instance.verifyFingerprint(VALUE, `${AAD} `, fingerprint), false);
  } finally {
    for (const [name, fn] of Object.entries(original)) console[name] = fn;
  }
  assert.equal(logCalls, 0);
});

test('rejects malformed envelopes and resolver key material with fixed errors', () => {
  const instance = protector();
  for (const ciphertext of ['', 'not-json', JSON.stringify({ version: 2 })]) {
    assert.throws(() => instance.open({ ciphertext, keyId: 'enc-a' }, AAD),
      error => error instanceof Error && error.message === 'weixin_protector_envelope_invalid');
  }
  const invalidResolver = resolver({ encryptionKeys: new Map([['enc-a', randomBytes(31)]]) });
  assert.throws(() => createVersionedWeixinContextProtector(invalidResolver).seal(VALUE, AAD),
    error => error instanceof Error && error.message === 'weixin_protector_key_invalid');
});

test('rejects path-like stored key IDs before consulting the injected resolver', () => {
  const authority = resolver();
  const instance = createVersionedWeixinContextProtector({
    ...authority,
    currentEncryptionKey() { return { keyId: '../outside/key', key: key() }; },
  });
  assert.throws(() => instance.seal(VALUE, AAD),
    error => error instanceof Error && error.message === 'weixin_protector_key_id_invalid');

  const pathEnvelope = JSON.stringify({ version: 1, algorithm: 'A256GCM', keyId: '../outside/key',
    nonce: Buffer.alloc(12).toString('base64url'), ciphertext: '', tag: Buffer.alloc(16).toString('base64url') });
  assert.throws(() => instance.open({ ciphertext: pathEnvelope, keyId: '../outside/key' }, AAD),
    error => error instanceof Error && error.message === 'weixin_protector_envelope_invalid');
  assert.deepEqual(authority.calls.encryptionById, []);
});
